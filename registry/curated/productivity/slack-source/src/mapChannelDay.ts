/**
 * @fileoverview The channel-day document: one channel's messages of one UTC day in time order, each thread's replies
 * under their parent whenever they were posted, edits applied, deletions and SaysHere's own posts left out, mentions
 * and links resolved to text, a file shown by its name. Each message is one span of the document, kept 90 days from
 * the day.
 * @module agentos-ext-slack-source/mapChannelDay
 */
import { createHash } from 'node:crypto';
import type {
  SourceCacheDecision, SourceSyncDocument, SourceSyncMessageSpan, SourceSyncJson,
} from '@framers/agentos-ext-account-sources';
import { type SlackMessage, isKeptSubtype, slackMessageVersion } from './messages.js';
import {
  SLACK_DAY_MS, SLACK_RETAINED_DAYS, channelDayId, compareSlackTs, slackDayStart, slackTsMs,
} from './types.js';

/** One channel-day's messages, as a read or the host gathered them. */
export interface SlackDayInput {
  /** The channel's id. */
  readonly channelId: string;
  /** The channel's name without its `#`. */
  readonly channelName: string;
  /** The UTC day, `yyyy-mm-dd`. */
  readonly day: string;
  /** The channel's messages of the day, threads' parents among them, in any order; replies are left out of these. */
  readonly messages: readonly SlackMessage[];
  /** Each thread's replies by its parent's timestamp, in any order. */
  readonly replies: Readonly<Record<string, readonly SlackMessage[]>>;
  /** The names people are shown by, by user id. */
  readonly people: Readonly<Record<string, string>>;
}

/** What rendering a channel-day takes besides its messages. */
export interface SlackDayRender {
  /** The instant before which nothing of the channel is read: a message or a reply before it is left out. */
  readonly readFrom: number;
  /**
   * The connection policy's retention window, `SourceSyncPolicy.windowMs`: the day is kept the shorter of it and the
   * retained days from its start.
   */
  readonly windowMs: number;
  /** SaysHere's own bot ids, whose posts are left out so a note never quotes itself. */
  readonly ownBotIds: readonly string[];
  /** The timestamps of deleted messages, which are left out however late a copy of them arrives. */
  readonly tombstones: ReadonlySet<string>;
  /** The host's own relative source-detail path for the document, never a Slack link; null for none. */
  readonly sourceDetailUrl: string | null;
  /** When the messages were read, epoch milliseconds. */
  readonly readAt: number;
  /** The host's decision to keep the document, with its expiry and evidence. */
  readonly cache: Extract<SourceCacheDecision, { kind: 'cache' }>;
}

/** The months as a title writes them. */
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The title of a channel-day: `#general on Nov 4, 2026`.
 *
 * @param channelName - The channel's name.
 * @param day - The UTC day.
 * @returns The title.
 */
export function channelDayTitle(channelName: string, day: string): string {
  const [year, month, date] = day.split('-');
  return `#${channelName} on ${months[Number(month) - 1]} ${Number(date)}, ${year}`;
}

/**
 * A message's time of day in UTC, `9:05 AM`.
 *
 * @param ms - Epoch milliseconds.
 * @returns The time.
 */
function clock(ms: number): string {
  const at = new Date(ms); const hours = at.getUTCHours();
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(at.getUTCMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/**
 * A message's text with Slack's markup resolved: a mention to the person's name, a channel to its name, a link to its
 * label and address, the three escaped characters to themselves.
 *
 * @param value - The text as Slack stores it.
 * @param people - The names by user id.
 * @returns The text a document shows.
 */
export function resolveSlackText(value: string, people: Readonly<Record<string, string>>): string {
  const resolved = value.replace(/<([^<>]*)>/g, (_whole, inner: string) => {
    const bar = inner.indexOf('|');
    const target = bar < 0 ? inner : inner.slice(0, bar);
    const label = bar < 0 ? null : inner.slice(bar + 1);
    if (target.startsWith('@')) {
      const id = target.slice(1);
      return `@${Object.hasOwn(people, id) ? people[id] : label ?? 'someone'}`;
    }
    if (target.startsWith('#')) return `#${label ?? 'channel'}`;
    if (target.startsWith('!')) {
      if (['!here', '!channel', '!everyone'].includes(target)) return `@${target.slice(1)}`;
      return label ?? '';
    }
    if (target.startsWith('mailto:')) return label ?? target.slice(7);
    return label !== null && label !== target ? `${label} (${target})` : target;
  });
  return resolved.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
}

/**
 * The name a message is shown under: its writer's name, the bot's or app's name, or `Someone`.
 *
 * @param message - The message.
 * @param people - The names by user id.
 * @returns The name.
 */
function writer(message: SlackMessage, people: Readonly<Record<string, string>>): string {
  if (message.user !== null && Object.hasOwn(people, message.user)) return people[message.user]!;
  return message.botName ?? 'Someone';
}

/**
 * Keeps each message once, its newest version, in time order.
 *
 * @param messages - The messages.
 * @returns The messages, deduplicated and ordered.
 */
function latest(messages: Iterable<SlackMessage>): SlackMessage[] {
  const byTs = new Map<string, SlackMessage>();
  for (const message of messages) {
    const kept = byTs.get(message.ts);
    if (!kept || compareSlackTs(slackMessageVersion(message), slackMessageVersion(kept)) > 0) byTs.set(message.ts, message);
  }
  return [...byTs.values()].sort((a, b) => compareSlackTs(a.ts, b.ts));
}

/** The most messages one document holds, the account-source store's bound on a document's spans. */
export const SLACK_DAY_MESSAGES = 1000;

/** The most characters one document holds, the account-source store's bound on a document's text. */
export const SLACK_DAY_CHARACTERS = 1_048_576;

/**
 * When a channel-day's messages leave the copy: its start plus the shorter of the retained days and the connection's
 * retention window.
 *
 * @param day - The UTC day.
 * @param windowMs - The connection policy's retention window.
 * @returns The expiry, epoch milliseconds.
 * @throws {RangeError} `slack_channel_day_invalid` for a malformed day.
 */
export function channelDayExpiry(day: string, windowMs: number): number {
  const start = slackDayStart(day);
  if (start === null || !Number.isSafeInteger(windowMs) || windowMs < 1) throw new RangeError('slack_channel_day_invalid');
  return start + Math.min(SLACK_RETAINED_DAYS * SLACK_DAY_MS, windowMs);
}

/**
 * Renders one channel-day as a document: a line per message (`{name} {h:mm AM}: {text}`, each file as
 * `[file: {name}]`), a thread's replies indented under their parent, a span per message. Answers null when no message
 * of the day remains, so the host removes the day's document. A day past the store's bounds (1,000 messages, 1,048,576
 * characters) keeps its messages in time order up to them, with `complete` false in its metadata.
 *
 * @param input - The channel, the day, its messages, the replies and the names.
 * @param render - The read-from bound, the retention window, SaysHere's bot ids, the deleted timestamps, the host's
 *   path, the read time and the host's keep decision, whose expiry is at most `channelDayExpiry`.
 * @returns The document, or null.
 * @throws {RangeError} `slack_channel_day_invalid` for a malformed channel or day.
 */
export function mapChannelDay(input: SlackDayInput, render: SlackDayRender): SourceSyncDocument | null {
  const id = channelDayId(input.channelId, input.day);
  const start = slackDayStart(input.day)!;
  const end = start + SLACK_DAY_MS;
  const own = new Set(render.ownBotIds);
  const kept = (message: SlackMessage): boolean => {
    const ms = slackTsMs(message.ts);
    return ms !== null && ms >= render.readFrom && isKeptSubtype(message.subtype)
      && !render.tombstones.has(message.ts) && (message.botId === null || !own.has(message.botId));
  };
  const parents = latest(input.messages.filter((message) => {
    const ms = slackTsMs(message.ts);
    return ms !== null && message.threadTs === null && ms >= start && ms < end && kept(message);
  }));
  if (parents.length === 0) return null;
  const windowExpiresAt = channelDayExpiry(input.day, render.windowMs);
  const lines: string[] = []; const spans: SourceSyncMessageSpan[] = [];
  let offset = 0; let version = ''; let activityAt = 0; let complete = true;
  // Adds one message's lines, or answers false when the document has no room for them: the store's bounds on a
  // document's spans and characters hold, and what does not fit is left out with `complete` false.
  const add = (message: SlackMessage, indent: string): boolean => {
    // A message's time, never after the read: a clock a little behind Slack's must not date a message in its future.
    const ms = Math.min(slackTsMs(message.ts)!, render.readAt);
    const files = message.files.map((name) => `[file: ${name}]`);
    const body = [resolveSlackText(message.text, input.people), ...files].filter((part) => part.length > 0).join(' ');
    const line = `${writer(message, input.people)} ${clock(ms)}: ${body}`.split('\n').map((part) => indent + part).join('\n');
    const from = lines.length > 0 ? offset + 1 : 0;
    if (spans.length >= SLACK_DAY_MESSAGES || from + line.length > SLACK_DAY_CHARACTERS) { complete = false; return false; }
    spans.push({ messageId: message.ts, start: from, end: from + line.length, receivedAt: ms, windowExpiresAt, truncated: false });
    lines.push(line); offset = from + line.length;
    const stamp = slackMessageVersion(message);
    if (version === '' || compareSlackTs(stamp, version) > 0) version = stamp;
    activityAt = Math.max(activityAt, ms);
    return true;
  };
  for (const parent of parents) {
    if (!add(parent, '')) break;
    const replies = Object.hasOwn(input.replies, parent.ts) ? input.replies[parent.ts]! : [];
    for (const reply of latest(replies.filter((message) => message.threadTs === parent.ts && kept(message)))) {
      if (!add(reply, '  ')) break;
    }
    if (!complete) break;
  }
  const text = lines.join('\n');
  const title = channelDayTitle(input.channelName, input.day);
  const newestTs = parents[parents.length - 1]!.ts;
  const metadata: Readonly<Record<string, SourceSyncJson>> = Object.freeze({
    channelId: input.channelId, channelName: input.channelName, day: input.day, messages: spans.length, newestTs, complete,
  });
  const contentHash = createHash('sha256')
    .update(JSON.stringify([text, spans.map((span) => [span.messageId, span.start, span.end]), metadata])).digest('hex');
  return Object.freeze({
    read: Object.freeze({
      item: Object.freeze({ id, title, size: text.length, version }),
      content: Object.freeze({ text }),
      ref: Object.freeze({ kind: 'slack', title, url: render.sourceDetailUrl, version,
        readAt: new Date(render.readAt).toISOString() }),
    }),
    messages: Object.freeze(spans.map((span) => Object.freeze(span))),
    metadata, activityAt, contentHash, cache: render.cache,
  });
}
