/**
 * @fileoverview The read's Slack Web API client: the channel list, a channel's details, joining a public channel, a
 * channel's members, a channel's history, a thread's replies, a person, the workspace and the token's own identity.
 * Every call is admitted through the host's account-source quota under its own method, with a new attempt id and the
 * objects it asks for, so each method's ceiling holds per workspace; a 429 or Slack's `ratelimited` records
 * `Retry-After` for that method of that workspace alone and is thrown as `rate_limited` with its time. Answers are read
 * under a byte cap before decoding, and only fixed failures leave the client. It never sleeps, retries inline, stores,
 * logs, leaves a channel, posts or reads a file.
 * @module agentos-ext-slack-source/slack
 */
import { randomUUID } from 'node:crypto';
import { OAuthGrantRefused } from '@framers/agentos/auth';
import {
  readCapped, ReadCapExceeded, sourceRetryAt, SourceSyncFault, type SourceQuota, type SourceQuotaResult,
} from '@framers/agentos-ext-account-sources';
import type { SlackMethod } from './ceilings.js';
import { SlackOAuthFault, slackOAuthFault, SLACK_UNAVAILABLE_ERRORS } from './oauth.js';
import { type SlackMessage, parseSlackMessage } from './messages.js';
import { isSlackChannelId, isSlackTime, slackTsMs } from './types.js';

/**
 * What a `SlackApi` is built from: trusted server configuration and the host's account-source services; none of it
 * comes from a browser request.
 */
export interface SlackApiOptions {
  /**
   * The installation's current access token, from the host's grant operation (`SlackOAuthFlow.accessToken` under the
   * grant's lease), which refreshes it under token rotation when it is due.
   */
  readonly accessToken: (signal: AbortSignal) => Promise<string>;
  /** The shared quota, built with `slackCeilings` and `slackQuotaWeights`: each call is one `run`, each wait a `defer`. */
  readonly quota: Pick<SourceQuota, 'run' | 'defer' | 'ceilingOf'>;
  /** The opaque quota key of the project, 1 to 512 letters, digits, `:`, `_` or `-`. */
  readonly projectKey: string;
  /** The installation's stable opaque key, never a Slack id: the quota holds each method's ceiling under it. */
  readonly mailboxKey: string;
  /** The fetch every call goes through; the global fetch by default. */
  readonly fetchImpl?: typeof fetch;
  /** Epoch milliseconds, the clock the host's sync store reads; `Date.now` unless given. */
  readonly clock?: () => number;
  /** CI-only stand-in origin: a loopback or `.invalid` origin with no path. */
  readonly apiOrigin?: string;
  /** Milliseconds one call and the reading of its body may take, at most 15,000; 15,000 unless given. */
  readonly timeoutMs?: number;
  /** The byte cap on one answer, at most 16,777,216; 4,194,304 unless given. */
  readonly maxResponseBytes?: number;
}

/** One channel as the read keeps it. */
export interface SlackChannel {
  /** The channel's id. */
  readonly id: string;
  /** Its name without the `#`. */
  readonly name: string;
  /** Whether it is private. */
  readonly isPrivate: boolean;
  /** Whether the bot is in it. */
  readonly isMember: boolean;
  /** Whether it is archived. */
  readonly isArchived: boolean;
  /** Whether it is shared with another organisation (Slack Connect), or waiting to be. */
  readonly isExtShared: boolean;
}

/** One page of a list. */
export interface SlackPage<T> {
  /** The page's entries. */
  readonly items: readonly T[];
  /** The cursor of the next page, or null on the last. */
  readonly nextCursor: string | null;
}

/** A person as the read keeps them: the name they are shown by and what tells a departed or guest account. */
export interface SlackPerson {
  /** The user id. */
  readonly id: string;
  /** Their display name, else their real name, else their user name. */
  readonly name: string;
  /** Whether the account was deactivated. */
  readonly deleted: boolean;
  /** Whether the account is a guest's. */
  readonly restricted: boolean;
  /** Whether the account is a bot's. */
  readonly bot: boolean;
  /** Their address, when the workspace gives it, for the host's private-channel reader binding alone. */
  readonly email: string | null;
}

/** The workspace's name and domain. */
export interface SlackTeam {
  /** The workspace's id. */
  readonly id: string;
  /** Its name. */
  readonly name: string;
  /** Its domain, `{domain}.slack.com`. */
  readonly domain: string;
}

/** What `auth.test` says about the token. */
export interface SlackIdentity {
  /** The workspace the token belongs to. */
  readonly teamId: string;
  /** The bot user the token acts as. */
  readonly userId: string;
  /** The bot's id, when Slack gives it. */
  readonly botId: string | null;
}

/** A history or replies page's range and paging. */
export interface SlackHistoryRange {
  /** The earliest message's timestamp to answer, exclusive unless `inclusive`. */
  readonly oldest: string;
  /** The latest message's timestamp to answer, exclusive unless `inclusive`; now when absent. */
  readonly latest?: string;
  /** Whether the bounds are inclusive. */
  readonly inclusive?: boolean;
  /** The cursor of the page to read, or null for the first. */
  readonly cursor: string | null;
  /** The most messages to ask for: a positive integer within the method's ceiling. */
  readonly limit: number;
}

/**
 * A client's refusal of one item: `not_found` for a channel or person Slack does not have, `thread_not_found` for a
 * thread whose parent it does not have, `no_access` for one the bot cannot read (not in the channel, a private channel to
 * join, a channel type the method does not take), `archived` for an archived channel, `response_too_large` for an answer
 * past the cap, and `configuration`, thrown by the constructor.
 */
export class SlackApiFault extends Error {
  /** @param reason Why the client refused. */
  constructor(readonly reason: 'configuration' | 'not_found' | 'thread_not_found' | 'no_access' | 'archived'
    | 'response_too_large') {
    super(`slack_api_${reason}`); this.name = 'SlackApiFault';
  }
}

/** Slack's errors that end the grant. */
const grantErrors: ReadonlySet<string> = new Set([
  'invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'no_permission', 'app_uninstalled',
]);
/** Slack's errors about one item, by the refusal each becomes. */
const itemErrors: Readonly<Record<string, SlackApiFault['reason']>> = Object.freeze({
  channel_not_found: 'not_found', thread_not_found: 'thread_not_found', user_not_found: 'not_found',
  not_in_channel: 'no_access', method_not_supported_for_channel_type: 'no_access', is_private: 'no_access',
  ekm_access_denied: 'no_access', is_archived: 'archived',
});
const productionOrigin = 'https://slack.com';
/** An opaque quota key. */
const quotaKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,512}$/.test(value);
/** A Slack paging cursor. */
const cursorOf = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 1024
  && !/[\x00-\x20\x7f]/.test(value) ? value : null;
/** A field of an object, or undefined. */
const field = (value: unknown, key: string): unknown => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? (value as Record<string, unknown>)[key] : undefined;

/**
 * Slack's origin, or on CI only a loopback or `.invalid` origin with no path, query, fragment or userinfo.
 *
 * @param value - The stand-in origin, or undefined for Slack's.
 * @returns The origin.
 */
function selectedOrigin(value?: string): string {
  if (value === undefined) return productionOrigin;
  let url: URL;
  try { url = new URL(value); } catch { throw new SlackApiFault('configuration'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (process.env.CI !== 'true' || (!local && !url.hostname.endsWith('.invalid'))
    || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new SlackApiFault('configuration');
  }
  return url.origin;
}

/**
 * A channel object of an answer, or null for one the read does not take (a direct message, a malformed id).
 *
 * @param value - The channel object.
 * @returns The channel, or null.
 */
export function parseSlackChannel(value: unknown): SlackChannel | null {
  const id = field(value, 'id');
  if (!isSlackChannelId(id) || field(value, 'is_im') === true || field(value, 'is_mpim') === true) return null;
  const name = field(value, 'name');
  return Object.freeze({
    id, name: typeof name === 'string' && name.length > 0 && name.length <= 256 ? name : id,
    isPrivate: field(value, 'is_private') === true || field(value, 'is_group') === true,
    isMember: field(value, 'is_member') === true, isArchived: field(value, 'is_archived') === true,
    isExtShared: field(value, 'is_ext_shared') === true || field(value, 'is_pending_ext_shared') === true,
  });
}

/**
 * The capped Slack Web API client of one installation. Each call makes one attempt, admitted by the quota under its
 * method; the durable coordinator owns retries, backoff and exhaustion. Failures are a fixed `SourceSyncFault`
 * (`rate_limited`, `provider_unavailable`, `network`, `grant_rejected`, `insufficient_scope`, `invalid_response`,
 * `cancelled`) or a `SlackApiFault` about one item.
 */
export class SlackApi {
  private readonly origin: string;
  private readonly send: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  /**
   * @param options - The token source, the quota and its keys, and the optional fetch, clock, CI origin and limits.
   * @throws {SlackApiFault} `configuration` for a malformed quota key, a limit past its ceiling, or an origin override
   *   outside CI or not a loopback or `.invalid` origin.
   */
  constructor(private readonly options: SlackApiOptions) {
    this.origin = selectedOrigin(options.apiOrigin);
    this.send = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxBytes = options.maxResponseBytes ?? 4_194_304;
    if (!quotaKey(options.projectKey) || !quotaKey(options.mailboxKey)
      || !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 15_000
      || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > 16_777_216) {
      throw new SlackApiFault('configuration');
    }
  }

  /** The client's clock, refused when it is not an instant. */
  private now(): number {
    const value = this.options.clock?.() ?? Date.now();
    if (!isSlackTime(value)) throw new SourceSyncFault('invalid_response');
    return value;
  }

  /** A retry time handed back: never at or before the client's clock. */
  private later(retryAt: number): number { return Math.max(retryAt, this.now() + 1); }

  /**
   * The most objects one request of a method may ask for: the method's ceiling, else `fallback`.
   *
   * @param method - The method.
   * @param fallback - The size when the method has no ceiling.
   * @returns The page size.
   */
  pageSize(method: SlackMethod, fallback: number): number {
    return this.options.quota.ceilingOf(method)?.maxObjects ?? fallback;
  }

  /**
   * One call through the quota: the token, one form POST, the capped answer, and Slack's answer checked.
   *
   * @param method - The method.
   * @param params - The form's fields.
   * @param signal - The caller's cancellation.
   * @param objects - The objects the call asks for, when it pages.
   * @returns The answer's fields, a success.
   */
  private async call(method: SlackMethod, params: Record<string, string>, signal?: AbortSignal,
    objects?: number): Promise<Record<string, unknown>> {
    if (signal?.aborted) throw new SourceSyncFault('cancelled');
    type Raw = { readonly status: number; readonly retryAfter: string | null; readonly body: unknown };
    let result: SourceQuotaResult<Raw>;
    result = await this.options.quota.run({
      projectKey: this.options.projectKey, mailboxKey: this.options.mailboxKey, method, attemptId: randomUUID(),
      ...(objects === undefined ? {} : { objects }),
    }, async (slot) => {
      let token: string;
      // A refresh Slack refused reaches the coordinator as the grant's loss, never as a storage failure to retry.
      try { token = await this.options.accessToken(slot); }
      catch (error) { throw error instanceof SlackOAuthFault || error instanceof OAuthGrantRefused ? slackOAuthFault(error) : error; }
      const controller = new AbortController(); let timedOut = false;
      const abort = () => controller.abort();
      slot.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
      try {
        let response: Response;
        try {
          response = await this.send(`${this.origin}/api/${method}`, {
            method: 'POST', redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal,
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json' },
            body: new URLSearchParams(params).toString(),
          });
        } catch {
          throw new SourceSyncFault(signal?.aborted ? 'cancelled' : 'network', timedOut ? this.now() + 1000 : null);
        }
        let bytes: Uint8Array;
        try { bytes = await readCapped(response, this.maxBytes); }
        catch (error) {
          if (error instanceof ReadCapExceeded) throw new SlackApiFault('response_too_large');
          throw new SourceSyncFault(signal?.aborted ? 'cancelled' : 'network');
        }
        let body: unknown = null;
        try { body = JSON.parse(Buffer.from(bytes).toString('utf8')); } catch { body = null; }
        return { status: response.status, retryAfter: response.headers.get('retry-after'), body };
      } finally {
        clearTimeout(timer); slot.removeEventListener('abort', abort);
      }
    }, signal);
    if (result.kind === 'deferred' || result.kind === 'late') throw new SourceSyncFault('rate_limited', this.later(result.retryAt));
    if (result.kind === 'duplicate') throw new SourceSyncFault('invalid_response');
    const { status, retryAfter, body } = result.value;
    const error = field(body, 'error');
    if (status === 429 || error === 'ratelimited') {
      const retryAt = sourceRetryAt(this.now(), 1, retryAfter, 0);
      await this.options.quota.defer({ projectKey: this.options.projectKey, mailboxKey: this.options.mailboxKey, method }, retryAt);
      throw new SourceSyncFault('rate_limited', this.later(retryAt));
    }
    if (status >= 500 || (typeof error === 'string' && SLACK_UNAVAILABLE_ERRORS.has(error))) {
      throw new SourceSyncFault('provider_unavailable', this.later(sourceRetryAt(this.now(), 1, retryAfter, 0)));
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new SourceSyncFault('invalid_response');
    if (field(body, 'ok') === true && status === 200) return body as Record<string, unknown>;
    if (typeof error === 'string' && grantErrors.has(error)) throw new SourceSyncFault('grant_rejected');
    if (error === 'missing_scope') throw new SourceSyncFault('insufficient_scope');
    if (typeof error === 'string' && Object.hasOwn(itemErrors, error)) throw new SlackApiFault(itemErrors[error]!);
    throw new SourceSyncFault('invalid_response');
  }

  /**
   * One page of the workspace's channels of the given types, archived ones left out.
   *
   * @param types - `public_channel`, `private_channel` or both.
   * @param cursor - The page's cursor, or null for the first.
   * @param limit - The most channels to ask for, within `conversations.list`'s ceiling.
   * @param signal - The caller's cancellation.
   * @returns The channels and the next page's cursor.
   */
  async listChannels(types: readonly ('public_channel' | 'private_channel')[], cursor: string | null, limit: number,
    signal?: AbortSignal): Promise<SlackPage<SlackChannel>> {
    if (types.length === 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 999) throw new SourceSyncFault('invalid_response');
    const answer = await this.call('conversations.list', {
      types: types.join(','), exclude_archived: 'true', limit: String(limit), ...(cursor === null ? {} : { cursor }),
    }, signal, limit);
    const channels = answer.channels;
    if (!Array.isArray(channels) || channels.length > 1000) throw new SourceSyncFault('invalid_response');
    const items = channels.map(parseSlackChannel).filter((channel): channel is SlackChannel => channel !== null);
    return { items, nextCursor: cursorOf(field(answer.response_metadata, 'next_cursor')) };
  }

  /**
   * One channel's details: its name, whether it is private, archived or shared, and whether the bot is in it.
   *
   * @param channel - The channel's id.
   * @param signal - The caller's cancellation.
   * @returns The channel.
   */
  async channelInfo(channel: string, signal?: AbortSignal): Promise<SlackChannel> {
    const parsed = parseSlackChannel((await this.call('conversations.info', { channel }, signal)).channel);
    if (parsed === null) throw new SourceSyncFault('invalid_response');
    return parsed;
  }

  /**
   * Joins a public channel, as the `public` and `all` channel sets do. A private channel cannot be joined.
   *
   * @param channel - The channel's id.
   * @param signal - The caller's cancellation.
   * @returns The channel as the join answered it.
   */
  async join(channel: string, signal?: AbortSignal): Promise<SlackChannel> {
    const parsed = parseSlackChannel((await this.call('conversations.join', { channel }, signal)).channel);
    if (parsed === null) throw new SourceSyncFault('invalid_response');
    return parsed;
  }

  /**
   * One page of a channel's members' user ids.
   *
   * @param channel - The channel's id.
   * @param cursor - The page's cursor, or null for the first.
   * @param limit - The most members to ask for, 1 to 999.
   * @param signal - The caller's cancellation.
   * @returns The user ids and the next page's cursor.
   */
  async members(channel: string, cursor: string | null, limit: number, signal?: AbortSignal): Promise<SlackPage<string>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 999) throw new SourceSyncFault('invalid_response');
    const answer = await this.call('conversations.members', {
      channel, limit: String(limit), ...(cursor === null ? {} : { cursor }),
    }, signal);
    const members = answer.members;
    if (!Array.isArray(members) || members.length > 1000) throw new SourceSyncFault('invalid_response');
    return {
      items: members.filter((id): id is string => typeof id === 'string' && /^[UW][A-Z0-9]{2,31}$/.test(id)),
      nextCursor: cursorOf(field(answer.response_metadata, 'next_cursor')),
    };
  }

  /**
   * One page of a channel's messages in a range, newest first: thread parents with their reply counts, never the
   * replies, which `replies` reads.
   *
   * @param channel - The channel's id.
   * @param range - The range, the page's cursor and its size within `conversations.history`'s ceiling.
   * @param signal - The caller's cancellation.
   * @returns The messages the read keeps and the next page's cursor.
   */
  async history(channel: string, range: SlackHistoryRange, signal?: AbortSignal): Promise<SlackPage<SlackMessage>> {
    return this.messages('conversations.history', { channel }, range, signal, null);
  }

  /**
   * One page of a thread's replies in a range, oldest first, the parent left out.
   *
   * @param channel - The channel's id.
   * @param ts - The parent's timestamp.
   * @param range - The range, the page's cursor and its size within `conversations.replies`' ceiling.
   * @param signal - The caller's cancellation.
   * @returns The replies the read keeps and the next page's cursor.
   */
  async replies(channel: string, ts: string, range: SlackHistoryRange, signal?: AbortSignal): Promise<SlackPage<SlackMessage>> {
    if (slackTsMs(ts) === null) throw new SourceSyncFault('invalid_response');
    return this.messages('conversations.replies', { channel, ts }, range, signal, ts);
  }

  /**
   * A history or replies page.
   *
   * @param method - `conversations.history` or `conversations.replies`.
   * @param params - The channel and, for replies, the parent.
   * @param range - The range and paging.
   * @param signal - The caller's cancellation.
   * @param parent - The parent's timestamp for replies, which are kept without it; null for history.
   * @returns The page.
   */
  private async messages(method: 'conversations.history' | 'conversations.replies', params: Record<string, string>,
    range: SlackHistoryRange, signal: AbortSignal | undefined, parent: string | null): Promise<SlackPage<SlackMessage>> {
    if (slackTsMs(range.oldest) === null || (range.latest !== undefined && slackTsMs(range.latest) === null)
      || !Number.isSafeInteger(range.limit) || range.limit < 1 || range.limit > 999) throw new SourceSyncFault('invalid_response');
    const answer = await this.call(method, {
      ...params, oldest: range.oldest, ...(range.latest === undefined ? {} : { latest: range.latest }),
      inclusive: range.inclusive === true ? 'true' : 'false', limit: String(range.limit),
      ...(range.cursor === null ? {} : { cursor: range.cursor }),
    }, signal, range.limit);
    const list = answer.messages;
    if (!Array.isArray(list) || list.length > Math.max(range.limit + 1, 1000)) throw new SourceSyncFault('invalid_response');
    const items: SlackMessage[] = [];
    for (const value of list) {
      const message = parseSlackMessage(value);
      if (message === null || message.ts === parent) continue;
      items.push(message);
    }
    const more = answer.has_more === true;
    const nextCursor = cursorOf(field(answer.response_metadata, 'next_cursor'));
    return { items, nextCursor: more ? nextCursor : null };
  }

  /**
   * A person: the name they are shown by, whether the account was deactivated or is a guest's or a bot's, and their
   * address where the workspace gives it.
   *
   * @param user - The user id.
   * @param signal - The caller's cancellation.
   * @returns The person.
   */
  async userInfo(user: string, signal?: AbortSignal): Promise<SlackPerson> {
    const answer = await this.call('users.info', { user }, signal);
    const value = answer.user; const profile = field(value, 'profile');
    const id = field(value, 'id');
    if (typeof id !== 'string' || id !== user) throw new SourceSyncFault('invalid_response');
    const pick = (...names: unknown[]): string | null => {
      for (const name of names) if (typeof name === 'string' && name.trim().length > 0 && name.length <= 256) return name.trim();
      return null;
    };
    const email = field(profile, 'email');
    return Object.freeze({
      id, name: pick(field(profile, 'display_name'), field(profile, 'real_name'), field(value, 'real_name'), field(value, 'name')) ?? id,
      deleted: field(value, 'deleted') === true, restricted: field(value, 'is_restricted') === true,
      bot: field(value, 'is_bot') === true,
      email: typeof email === 'string' && email.length <= 320 && email.includes('@') ? email : null,
    });
  }

  /**
   * The workspace's name and domain.
   *
   * @param signal - The caller's cancellation.
   * @returns The workspace.
   */
  async teamInfo(signal?: AbortSignal): Promise<SlackTeam> {
    const team = (await this.call('team.info', {}, signal)).team;
    const id = field(team, 'id'); const name = field(team, 'name'); const domain = field(team, 'domain');
    if (typeof id !== 'string' || typeof name !== 'string' || typeof domain !== 'string') throw new SourceSyncFault('invalid_response');
    return Object.freeze({ id, name: name.slice(0, 256), domain: domain.slice(0, 256) });
  }

  /**
   * The token's own identity: its workspace and its bot user, for the host to bind the connection to.
   *
   * @param signal - The caller's cancellation.
   * @returns The identity.
   */
  async authTest(signal?: AbortSignal): Promise<SlackIdentity> {
    const answer = await this.call('auth.test', {}, signal);
    const teamId = answer.team_id; const userId = answer.user_id; const botId = answer.bot_id;
    if (typeof teamId !== 'string' || typeof userId !== 'string') throw new SourceSyncFault('invalid_response');
    return Object.freeze({ teamId, userId, botId: typeof botId === 'string' ? botId : null });
  }
}
