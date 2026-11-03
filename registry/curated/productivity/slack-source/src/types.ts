/**
 * @fileoverview The Slack read's shared words: the exact bot scope set an installation is granted, the three channel
 * sets a connection reads by, the channel-day source id and Slack's message timestamps, and the read-from bound the
 * host's days give a channel.
 * @module agentos-ext-slack-source/types
 */

/**
 * The bot scopes the read asks for and accepts, exactly: the messages and events of the channels the bot is in
 * (`channels:history`, `groups:history`), the channel lists, details and members (`channels:read`, `groups:read`),
 * joining public channels (`channels:join`), people's names and the addresses a private channel's readers are matched
 * by (`users:read`, `users:read.email`) and the workspace's name (`team:read`). No write, manage, direct-message,
 * file, search, admin or user scope.
 */
export const SLACK_READ_SCOPES: readonly string[] = Object.freeze([
  'channels:history', 'groups:history', 'channels:read', 'groups:read',
  'channels:join', 'users:read', 'users:read.email', 'team:read',
]);

/**
 * The channel set a connection reads: `invited`, the public and private channels someone invited the bot into;
 * `public`, every public channel, which the connector joins, and no private one; `all`, every public channel, joined,
 * and every private channel the bot was invited into. No set reads a direct message or a channel shared with another
 * organisation.
 */
export type SlackSelectionMode = 'invited' | 'public' | 'all';

/** The three channel sets, the default first. */
export const SLACK_SELECTION_MODES: readonly SlackSelectionMode[] = Object.freeze(['invited', 'public', 'all']);

/** The channel set a connection reads when its policy and its selection name none. */
export const SLACK_DEFAULT_MODE: SlackSelectionMode = 'invited';

/**
 * Whether a value names one of the three channel sets.
 *
 * @param value - The value to check.
 * @returns True for `invited`, `public` or `all`.
 */
export function isSlackSelectionMode(value: unknown): value is SlackSelectionMode {
  return value === 'invited' || value === 'public' || value === 'all';
}

/** Milliseconds in one UTC day. */
export const SLACK_DAY_MS = 86_400_000;

/**
 * Whether a value is a number of retained days the host may send: a positive integer whose span in milliseconds is an
 * instant the account-source services accept. The host reads its value from its plan source.
 *
 * @param value - The value to check.
 * @returns True for a positive integer within the services' time range.
 */
export function isSlackRetainedDays(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value * SLACK_DAY_MS <= maxTime;
}

/** The latest epoch millisecond the account-source services accept. */
const maxTime = 8_639_999_913_600_000;

/**
 * Whether a value is an instant the account-source services accept: a safe integer of epoch milliseconds.
 *
 * @param value - The value to check.
 * @returns True for an integer from 0 to the services' latest time.
 */
export function isSlackTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maxTime;
}

/** A channel's id as Slack writes one for a public or private channel: `C` or `G`, then capital letters and digits. */
const channelPattern = /^[CG][A-Z0-9]{2,31}$/;

/**
 * Whether a value is a channel id the read accepts. A direct message's id (`D…`) is not one.
 *
 * @param value - The value to check.
 * @returns True for a public or private channel's id.
 */
export function isSlackChannelId(value: unknown): value is string {
  return typeof value === 'string' && channelPattern.test(value);
}

/** Slack's message timestamp: whole seconds, a dot and six digits. */
const tsPattern = /^(\d{1,12})\.(\d{6})$/;

/**
 * The epoch milliseconds of a Slack message timestamp (`1730000000.123456`), or null for a malformed one.
 *
 * @param ts - The timestamp.
 * @returns Its milliseconds, or null.
 */
export function slackTsMs(ts: unknown): number | null {
  if (typeof ts !== 'string') return null;
  const match = tsPattern.exec(ts);
  if (!match) return null;
  const ms = Number(match[1]) * 1000 + Math.floor(Number(match[2]) / 1000);
  return isSlackTime(ms) ? ms : null;
}

/**
 * The Slack timestamp of an instant, at millisecond precision, as Slack's `oldest` and `latest` arguments take one.
 *
 * @param ms - Epoch milliseconds.
 * @returns The timestamp.
 */
export function slackTs(ms: number): string {
  if (!isSlackTime(ms)) throw new RangeError('slack_time_invalid');
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

/**
 * Orders two Slack timestamps by their digits, never through a float.
 *
 * @param a - A timestamp.
 * @param b - Another timestamp.
 * @returns Negative when `a` is earlier, positive when later, zero when equal.
 */
export function compareSlackTs(a: string, b: string): number {
  const [aSeconds = '', aMicros = ''] = a.split('.');
  const [bSeconds = '', bMicros = ''] = b.split('.');
  const left = aSeconds.replace(/^0+(?=.)/, ''); const right = bSeconds.replace(/^0+(?=.)/, '');
  if (left.length !== right.length) return left.length - right.length;
  if (left !== right) return left < right ? -1 : 1;
  return aMicros < bMicros ? -1 : aMicros > bMicros ? 1 : 0;
}

/**
 * The UTC day of an instant, `yyyy-mm-dd`.
 *
 * @param ms - Epoch milliseconds.
 * @returns The day.
 */
export function slackDayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A UTC day as the source id writes it. */
const dayPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The first millisecond of a UTC day, or null for a malformed or impossible day.
 *
 * @param day - The day, `yyyy-mm-dd`.
 * @returns Its start, or null.
 */
export function slackDayStart(day: string): number | null {
  if (!dayPattern.test(day)) return null;
  const start = Date.parse(`${day}T00:00:00.000Z`);
  return isSlackTime(start) && slackDayOf(start) === day ? start : null;
}

/** One channel's messages of one UTC day: the unit of a document. */
export interface SlackChannelDay {
  /** The channel's id. */
  readonly channelId: string;
  /** The UTC day, `yyyy-mm-dd`. */
  readonly day: string;
}

/**
 * A channel-day's source id, `{channel}:{yyyy-mm-dd}`.
 *
 * @param channelId - The channel's id.
 * @param day - The UTC day.
 * @returns The id.
 */
export function channelDayId(channelId: string, day: string): string {
  if (!isSlackChannelId(channelId) || slackDayStart(day) === null) throw new RangeError('slack_channel_day_invalid');
  return `${channelId}:${day}`;
}

/**
 * The channel and the day a source id names, or null for an id that is not a channel-day's.
 *
 * @param id - The source id.
 * @returns The channel-day, or null.
 */
export function parseChannelDayId(id: unknown): SlackChannelDay | null {
  if (typeof id !== 'string') return null;
  const at = id.indexOf(':');
  if (at < 0) return null;
  const channelId = id.slice(0, at); const day = id.slice(at + 1);
  return isSlackChannelId(channelId) && slackDayStart(day) !== null ? { channelId, day } : null;
}

/**
 * The instant before which a channel is not read: its start (the connect, or the bot's arrival in a channel added
 * later), less the host's backfill days when Backfill is on, and never earlier than the host's retained days before
 * `now`. Both come from the host's plan source; the connector holds no number of days of its own.
 *
 * @param start - The channel's start, epoch milliseconds.
 * @param backfillDays - The host's backfill days, or null when Backfill is off.
 * @param retainedDays - The host's retained days: nothing is read from before this many days ago.
 * @param now - The current instant.
 * @returns The read-from instant.
 * @throws {RangeError} `slack_retained_days_invalid` for retained days that are not a positive integer, and
 *   `slack_backfill_days_invalid` for backfill days that are not an integer from 1 to the retained days.
 */
export function slackReadFrom(start: number, backfillDays: number | null, retainedDays: number, now: number): number {
  if (!isSlackTime(start) || !isSlackTime(now)) throw new RangeError('slack_time_invalid');
  if (!isSlackRetainedDays(retainedDays)) throw new RangeError('slack_retained_days_invalid');
  if (backfillDays !== null && (!Number.isSafeInteger(backfillDays) || backfillDays < 1
    || backfillDays > retainedDays)) throw new RangeError('slack_backfill_days_invalid');
  const from = backfillDays === null ? start : start - backfillDays * SLACK_DAY_MS;
  return Math.max(0, from, now - retainedDays * SLACK_DAY_MS);
}
