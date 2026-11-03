/**
 * @fileoverview The Events API's envelopes as the read takes them: the `url_verification` challenge, an
 * `event_callback` with its key (`event_id`), its workspace, its time and the event inside, and Slack's
 * `app_rate_limited` notice; whether a delivery is Slack's retry; the channel-days a message event changes; and the
 * pushed-event intake that queues those days into the connection's open sync cycle.
 * @module agentos-ext-slack-source/events
 */
import type {
  SourceSyncEnqueueReason, SourceSyncEnqueueResult, SourceSyncScope,
} from '@framers/agentos-ext-account-sources';
import { type SlackMessage, parseSlackMessage } from './messages.js';
import { channelDayId, isSlackChannelId, slackDayOf, slackTsMs } from './types.js';

/** The largest envelope read, in bytes. */
export const SLACK_ENVELOPE_BYTES = 1_048_576;

/** A channel change the read follows, as Slack names its event. */
export type SlackChannelEventType =
  | 'channel_created' | 'channel_rename' | 'group_rename' | 'channel_archive' | 'group_archive'
  | 'channel_unarchive' | 'group_unarchive' | 'channel_deleted' | 'group_deleted' | 'channel_shared'
  | 'channel_unshared' | 'channel_id_changed' | 'channel_left' | 'group_left' | 'channel_convert_to_private';

/** The channel events the read follows. */
const channelEvents: ReadonlySet<string> = new Set<SlackChannelEventType>([
  'channel_created', 'channel_rename', 'group_rename', 'channel_archive', 'group_archive', 'channel_unarchive',
  'group_unarchive', 'channel_deleted', 'group_deleted', 'channel_shared', 'channel_unshared', 'channel_id_changed',
  'channel_left', 'group_left',
]);

/** The installation and Home tab events the read follows. */
const appEvents: ReadonlySet<string> = new Set(['app_uninstalled', 'tokens_revoked', 'user_change', 'app_home_opened']);

/** One event inside an `event_callback`, as the read takes it. */
export type SlackEvent =
  /** A new message in a channel, a thread reply among them. */
  | { readonly kind: 'message'; readonly channel: string; readonly message: SlackMessage }
  /** A message's new version after an edit. */
  | { readonly kind: 'message_changed'; readonly channel: string; readonly message: SlackMessage }
  /** A deletion: the deleted message's timestamp and, for a reply, its parent's. */
  | { readonly kind: 'message_deleted'; readonly channel: string; readonly deletedTs: string; readonly threadTs: string | null }
  /** A message of a subtype a document does not keep, such as a join notice. */
  | { readonly kind: 'notice'; readonly channel: string; readonly subtype: string }
  /** A change to a channel: its id (the new one for `channel_id_changed`), the earlier id and the new name. */
  | {
    readonly kind: 'channel'; readonly type: SlackChannelEventType; readonly channel: string;
    readonly previousChannel: string | null; readonly name: string | null;
  }
  /** Someone joined or left a channel; `inviter` names who invited them, when Slack says. */
  | {
    readonly kind: 'membership'; readonly type: 'member_joined_channel' | 'member_left_channel';
    readonly channel: string; readonly user: string; readonly inviter: string | null;
  }
  /** The app's installation or a person's account changed, or someone opened the app's Home tab. */
  | {
    readonly kind: 'app'; readonly type: 'app_uninstalled' | 'tokens_revoked' | 'user_change' | 'app_home_opened';
    readonly user: string | null;
  }
  /** An event the read does not follow, a direct message's among them; the route acknowledges it and keeps nothing. */
  | { readonly kind: 'other'; readonly type: string };

/** One envelope Slack posts to the events route. */
export type SlackEnvelope =
  /** The request URL's verification: the route answers the challenge. */
  | { readonly kind: 'url_verification'; readonly challenge: string }
  /** One event, keyed by its id, in one workspace, at its time in epoch seconds. */
  | {
    readonly kind: 'event_callback'; readonly teamId: string; readonly eventId: string; readonly eventTime: number;
    readonly eventTs: string | null; readonly type: string; readonly subtype: string | null; readonly event: SlackEvent;
  }
  /** Slack's notice that the app passed the deliveries it allows a workspace a minute. */
  | { readonly kind: 'app_rate_limited'; readonly teamId: string; readonly minuteRateLimited: number };

/** A refused envelope: `too_large` past 1,048,576 bytes, `invalid` for anything Slack does not send. */
export class SlackEnvelopeFault extends Error {
  /** @param reason Why the envelope was refused. */
  constructor(readonly reason: 'too_large' | 'invalid') {
    super(`slack_envelope_${reason}`); this.name = 'SlackEnvelopeFault';
  }
}

/**
 * A field of an object, or undefined.
 *
 * @param value - The object.
 * @param key - The field.
 * @returns The field's value.
 */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key] : undefined;
}

/** A bounded identifier: letters, digits, dots, underscores, hyphens. */
const id = (value: unknown, maximum = 64): value is string => typeof value === 'string'
  && value.length > 0 && value.length <= maximum && /^[A-Za-z0-9._-]+$/.test(value);

/** Refuses the envelope. */
const invalid = (): never => { throw new SlackEnvelopeFault('invalid'); };

/**
 * A channel's id from an event: the field itself, or the `id` of a channel object.
 *
 * @param value - The field's value.
 * @returns The id, or null.
 */
function channelOf(value: unknown): string | null {
  if (isSlackChannelId(value)) return value;
  const inner = field(value, 'id');
  return isSlackChannelId(inner) ? inner : null;
}

/**
 * Reads the event inside an `event_callback`.
 *
 * @param event - The event object.
 * @returns The event.
 */
function parseEvent(event: Record<string, unknown>): SlackEvent {
  const type = event.type as string;
  if (type === 'message') {
    const channel = channelOf(event.channel);
    const channelType = event.channel_type;
    if (channel === null || channelType === 'im' || channelType === 'mpim') return { kind: 'other', type };
    const subtype = typeof event.subtype === 'string' ? event.subtype : null;
    if (subtype === 'message_changed') {
      const message = parseSlackMessage(event.message);
      return message === null ? { kind: 'notice', channel, subtype } : { kind: 'message_changed', channel, message };
    }
    if (subtype === 'message_deleted') {
      const deletedTs = event.deleted_ts;
      if (typeof deletedTs !== 'string' || slackTsMs(deletedTs) === null) return invalid();
      const thread = field(event.previous_message, 'thread_ts');
      const threadTs = typeof thread === 'string' && slackTsMs(thread) !== null && thread !== deletedTs ? thread : null;
      return { kind: 'message_deleted', channel, deletedTs, threadTs };
    }
    if (subtype === 'channel_convert_to_private') {
      return { kind: 'channel', type: subtype, channel, previousChannel: null, name: null };
    }
    const message = parseSlackMessage(event);
    if (message !== null) return { kind: 'message', channel, message };
    if (subtype !== null) return { kind: 'notice', channel, subtype: subtype.slice(0, 64) };
    return invalid();
  }
  if (type === 'member_joined_channel' || type === 'member_left_channel') {
    const channel = channelOf(event.channel);
    if (channel === null || !id(event.user)) return { kind: 'other', type };
    return { kind: 'membership', type, channel, user: event.user, inviter: id(event.inviter) ? event.inviter : null };
  }
  if (type === 'channel_id_changed') {
    const channel = channelOf(event.new_channel_id); const previousChannel = channelOf(event.old_channel_id);
    if (channel === null || previousChannel === null) return invalid();
    return { kind: 'channel', type, channel, previousChannel, name: null };
  }
  if (channelEvents.has(type)) {
    const channel = channelOf(event.channel);
    if (channel === null) return invalid();
    const name = field(event.channel, 'name');
    return { kind: 'channel', type: type as SlackChannelEventType, channel, previousChannel: null,
      name: typeof name === 'string' && name.length > 0 && name.length <= 256 ? name : null };
  }
  if (appEvents.has(type)) {
    const user = id(event.user) ? event.user : id(field(event.user, 'id')) ? field(event.user, 'id') as string : null;
    return { kind: 'app', type: type as 'app_uninstalled' | 'tokens_revoked' | 'user_change' | 'app_home_opened', user };
  }
  return { kind: 'other', type: type.slice(0, 64) };
}

/**
 * Parses the body Slack posted to the events route. Check its signature first (`verifySlackSignature`).
 *
 * @param rawBody - The body exactly as it arrived.
 * @returns The envelope.
 * @throws {SlackEnvelopeFault} `too_large` past 1,048,576 bytes, `invalid` for a body that is not one of Slack's three
 *   envelopes.
 */
export function parseSlackEnvelope(rawBody: string | Uint8Array): SlackEnvelope {
  const bytes = typeof rawBody === 'string' ? Buffer.byteLength(rawBody, 'utf8') : rawBody.byteLength;
  if (bytes > SLACK_ENVELOPE_BYTES) throw new SlackEnvelopeFault('too_large');
  let parsed: unknown;
  try { parsed = JSON.parse(typeof rawBody === 'string' ? rawBody : Buffer.from(rawBody).toString('utf8')); }
  catch { return invalid(); }
  const type = field(parsed, 'type');
  if (type === 'url_verification') {
    const challenge = field(parsed, 'challenge');
    if (typeof challenge !== 'string' || challenge.length === 0 || challenge.length > 512) return invalid();
    return { kind: 'url_verification', challenge };
  }
  const teamId = field(parsed, 'team_id');
  if (!id(teamId)) return invalid();
  if (type === 'app_rate_limited') {
    const minute = field(parsed, 'minute_rate_limited');
    if (typeof minute !== 'number' || !Number.isSafeInteger(minute) || minute < 0) return invalid();
    return { kind: 'app_rate_limited', teamId, minuteRateLimited: minute };
  }
  if (type !== 'event_callback') return invalid();
  const eventId = field(parsed, 'event_id'); const eventTime = field(parsed, 'event_time');
  const event = field(parsed, 'event');
  if (!id(eventId, 128) || typeof eventTime !== 'number' || !Number.isSafeInteger(eventTime) || eventTime < 0
    || event === null || typeof event !== 'object' || Array.isArray(event)
    || typeof field(event, 'type') !== 'string') return invalid();
  const record = event as Record<string, unknown>;
  const eventTs = typeof record.event_ts === 'string' && slackTsMs(record.event_ts) !== null ? record.event_ts : null;
  return {
    kind: 'event_callback', teamId, eventId, eventTime, eventTs, type: (record.type as string).slice(0, 64),
    subtype: typeof record.subtype === 'string' ? record.subtype.slice(0, 64) : null, event: parseEvent(record),
  };
}

/**
 * Whether a delivery is Slack's retry of one it sent before, and why: `x-slack-retry-num` and `x-slack-retry-reason`.
 *
 * @param headers - The request's headers.
 * @returns The retry's number and reason, or null for a first delivery.
 */
export function slackRetryOf(headers: Headers | Readonly<Record<string, string | undefined>>):
  { readonly retryNum: number; readonly reason: string | null } | null {
  const read = (name: string): string | null => {
    if (headers instanceof Headers) return headers.get(name);
    for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name && typeof value === 'string') return value;
    return null;
  };
  const retry = read('x-slack-retry-num');
  if (retry === null || !/^\d{1,4}$/.test(retry)) return null;
  const reason = read('x-slack-retry-reason');
  return { retryNum: Number(retry), reason: reason !== null && id(reason) ? reason : null };
}

/**
 * The channel-days a message event changes: the day of the message, or of its thread's parent for a reply, which the
 * parent's day holds.
 *
 * @param event - The event.
 * @returns The channel-day source ids, none for an event that changes no message.
 */
export function slackEventSources(event: SlackEvent): string[] {
  const dayOf = (ts: string): string => slackDayOf(slackTsMs(ts)!);
  if (event.kind === 'message' || event.kind === 'message_changed') {
    return [channelDayId(event.channel, dayOf(event.message.threadTs ?? event.message.ts))];
  }
  if (event.kind === 'message_deleted') return [channelDayId(event.channel, dayOf(event.threadTs ?? event.deletedTs))];
  return [];
}

/** The coordinator's pushed-event intake, as `AccountSourceSync.enqueue` takes it. */
export interface SlackEventIntake {
  /** Queues the sources into the connection's open cycle, or opens an incremental one. */
  enqueue(scope: SourceSyncScope, sourceIds: readonly string[], reason: SourceSyncEnqueueReason): Promise<SourceSyncEnqueueResult>;
}

/**
 * Queues the channel-days an event changes into the connection's sync, with the reason `event`, so the worker reads the
 * day the minute its event lands.
 *
 * @param intake - The coordinator, or anything with its `enqueue`.
 * @param scope - The connection the event's workspace is installed in, as the host found it by the envelope's team.
 * @param envelope - The envelope.
 * @returns What the enqueue did, or null for an envelope that changes no message.
 */
export async function enqueueSlackEvent(intake: SlackEventIntake, scope: SourceSyncScope,
  envelope: SlackEnvelope): Promise<SourceSyncEnqueueResult | null> {
  if (envelope.kind !== 'event_callback') return null;
  const ids = slackEventSources(envelope.event);
  return ids.length === 0 ? null : intake.enqueue(scope, ids, 'event');
}
