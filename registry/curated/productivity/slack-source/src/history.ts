/**
 * @fileoverview How the read takes Slack's history: each channel's anchor (the instant up to which its history was
 * read, kept as the connection's sub-cursor for that channel, else its read-from bound: its start less the host's
 * backfill days), the channel sets' admission rules, the walk of the mode's channel set that the history phase pages
 * through once a reconcile period, the reconcile's window slice, and the read of one channel-day: its messages and its
 * threads' replies, page by page under each method's ceiling, waiting for a method's minute within the call's budget.
 * @module agentos-ext-slack-source/history
 */
import { SourceSyncFault } from '@framers/agentos-ext-account-sources';
import type { SlackChannel, SlackApi, SlackPage } from './slack.js';
import type { SlackMessage } from './messages.js';
import {
  type SlackSelectionMode, SLACK_DAY_MS, channelDayId, compareSlackTs, isSlackChannelId, isSlackRetainedDays,
  slackDayOf, slackDayStart, slackTs, slackTsMs,
} from './types.js';

/** The anchor of a connection that has read no channel yet: before every message. */
export const SLACK_NO_ANCHOR = '0.000000';

/** The slices a reconcile's window pass divides a channel's retained days into, one a day, so a week reads them all. */
export const SLACK_WINDOW_SLICES = 7;

/** The most channels one walk step holds in its page token. */
export const SLACK_WALK_CHANNELS = 100;

/**
 * A channel's anchor: the instant its history was read up to, as the connection's sub-cursor for it holds it, or null
 * for a channel never read.
 *
 * @param subCursors - The connection's sub-cursors, by channel id.
 * @param channelId - The channel.
 * @returns The anchor, or null.
 */
export function slackChannelAnchor(subCursors: Readonly<Record<string, string>> | undefined, channelId: string): string | null {
  const value = subCursors !== undefined && Object.hasOwn(subCursors, channelId) ? subCursors[channelId] : undefined;
  return value !== undefined && slackTsMs(value) !== null ? value : null;
}

/**
 * The anchor a cycle begins from: the newest channel anchor, the instant of the last walk, or `SLACK_NO_ANCHOR` for a
 * connection that has read no channel.
 *
 * @param subCursors - The connection's sub-cursors, by channel id.
 * @returns The anchor.
 */
export function slackBeginAnchor(subCursors: Readonly<Record<string, string>> | undefined): string {
  let newest = SLACK_NO_ANCHOR;
  for (const [channel, value] of Object.entries(subCursors ?? {})) {
    if (isSlackChannelId(channel) && slackTsMs(value) !== null && compareSlackTs(value, newest) > 0) newest = value;
  }
  return newest;
}

/**
 * Whether the history phase walks the channel set: when the connection has read no channel, or its last walk is at
 * least a reconcile period old. Between walks the live read is Slack's events, so the phase sends no request.
 *
 * @param fromCursor - The cycle's history cursor: the instant of the last walk.
 * @param subCursors - The connection's sub-cursors.
 * @param cutoff - The cycle's cutoff, epoch milliseconds.
 * @param reconcileMs - The policy's reconcile period.
 * @returns Whether a walk is due.
 */
export function slackWalkDue(fromCursor: string, subCursors: Readonly<Record<string, string>> | undefined,
  cutoff: number, reconcileMs: number): boolean {
  const last = slackTsMs(fromCursor);
  if (last === null || Object.keys(subCursors ?? {}).length === 0) return true;
  return cutoff - last >= reconcileMs;
}

/**
 * What a channel set does with a channel: `read` it, `join` it first (a public channel the bot is not in, under
 * `public` and `all`), or leave it. No set reads an archived channel, a channel shared with another organisation, or a
 * private channel nobody invited the bot into; `public` reads no private channel at all.
 *
 * @param channel - The channel.
 * @param mode - The channel set.
 * @returns What the set does with it.
 */
export function slackAdmission(channel: SlackChannel, mode: SlackSelectionMode): 'read' | 'join' | null {
  if (channel.isExtShared || channel.isArchived) return null;
  if (channel.isPrivate) return mode !== 'public' && channel.isMember ? 'read' : null;
  if (channel.isMember) return 'read';
  return mode === 'invited' ? null : 'join';
}

/**
 * The channel types a set lists.
 *
 * @param mode - The channel set.
 * @returns `public_channel`, with `private_channel` for the sets that read private channels.
 */
export function slackChannelTypes(mode: SlackSelectionMode): ('public_channel' | 'private_channel')[] {
  return mode === 'public' ? ['public_channel'] : ['public_channel', 'private_channel'];
}

/**
 * The days of a reconcile's window pass for one channel: of the host's retained days before the cutoff, from its
 * read-from bound's day to the cutoff's, those whose day number falls on the cutoff's day of a
 * `SLACK_WINDOW_SLICES`-day cycle, so seven daily passes read every retained day again.
 *
 * @param readFrom - The channel's read-from bound.
 * @param cutoff - The cycle's cutoff.
 * @param retainedDays - The host's retained days.
 * @returns The slice's days, `yyyy-mm-dd`, newest first.
 * @throws {RangeError} `slack_retained_days_invalid` for retained days that are not a positive integer.
 */
export function slackWindowSlice(readFrom: number, cutoff: number, retainedDays: number): string[] {
  if (!isSlackRetainedDays(retainedDays)) throw new RangeError('slack_retained_days_invalid');
  const last = Math.floor(cutoff / SLACK_DAY_MS);
  const first = Math.max(Math.floor(readFrom / SLACK_DAY_MS), last - retainedDays + 1);
  const days: string[] = [];
  for (let n = last; n >= first; n--) if (n % SLACK_WINDOW_SLICES === last % SLACK_WINDOW_SLICES) days.push(slackDayOf(n * SLACK_DAY_MS));
  return days;
}

/** The history phase's state between its pages. */
export interface SlackWalk {
  /** The channel list's next cursor: `''` before the first list page, null once the list is read. */
  readonly list: string | null;
  /** The listed channels still to read, each prefixed with `+` when it is to be joined first. */
  readonly queue: readonly string[];
  /** The history cursor of the first queued channel, or null for its first page. */
  readonly history: string | null;
}

/**
 * The walk's page token.
 *
 * @param walk - The walk's state.
 * @returns The token, at most 4,096 characters.
 */
export function encodeSlackWalk(walk: SlackWalk): string {
  const token = JSON.stringify({ l: walk.list, q: walk.queue, h: walk.history });
  if (token.length > 4096) throw new SourceSyncFault('invalid_response');
  return token;
}

/**
 * The walk a page token holds, or null for a token this connector did not make.
 *
 * @param token - The page token.
 * @returns The walk, or null.
 */
export function decodeSlackWalk(token: string): SlackWalk | null {
  let value: unknown;
  try { value = JSON.parse(token); } catch { return null; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { l, q, h } = value as Record<string, unknown>;
  if (!(l === null || (typeof l === 'string' && l.length <= 1024)) || !(h === null || (typeof h === 'string' && h.length > 0 && h.length <= 1024))
    || !Array.isArray(q) || q.length > SLACK_WALK_CHANNELS
    || !q.every((entry) => typeof entry === 'string' && isSlackChannelId(entry.startsWith('+') ? entry.slice(1) : entry))) return null;
  return { list: l as string | null, queue: q as string[], history: h as string | null };
}

/**
 * The channel-day ids of a page of a channel's messages: each message's day, deduplicated, in page order.
 *
 * @param channelId - The channel.
 * @param messages - The page's messages.
 * @returns The ids.
 */
export function slackDaysOf(channelId: string, messages: readonly SlackMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) ids.add(channelDayId(channelId, slackDayOf(slackTsMs(message.threadTs ?? message.ts)!)));
  return [...ids];
}

/** How a day read waits for a method's minute: until when it may wait, and its clock and cancellation. */
export interface SlackWait {
  /** The latest instant a wait may end, epoch milliseconds; a later retry time ends the read as a retry. */
  readonly until: number;
  /** The clock, epoch milliseconds. */
  readonly clock: () => number;
  /** The call's cancellation. */
  readonly signal?: AbortSignal;
}

/**
 * Sleeps until an instant, or rejects as `cancelled` on the signal.
 *
 * @param ms - How long to sleep.
 * @param signal - The cancellation.
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new SourceSyncFault('cancelled')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.max(0, ms));
    const stop = () => { clearTimeout(timer); reject(new SourceSyncFault('cancelled')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * Runs one Web API call, and when its method's minute has no room, waits for the quota's time and runs it again, while
 * that time falls within the wait's bound; a later time is thrown as the `rate_limited` fault it came as.
 *
 * @param wait - The bound, the clock and the cancellation.
 * @param call - The call.
 * @returns The call's answer.
 */
export async function slackWithin<T>(wait: SlackWait, call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) {
      if (!(error instanceof SourceSyncFault) || error.code !== 'rate_limited' || error.retryAt === null
        || error.retryAt > wait.until) throw error;
      await sleep(error.retryAt - wait.clock(), wait.signal);
    }
  }
}

/** One channel-day's messages and its threads' replies, as `readSlackDay` read them. */
export interface SlackDayMessages {
  /** The day's messages in the channel, threads' parents among them. */
  readonly messages: readonly SlackMessage[];
  /** Each thread's replies by its parent's timestamp. */
  readonly replies: Readonly<Record<string, readonly SlackMessage[]>>;
}

/**
 * Reads one channel-day: the channel's messages from the later of the day's start and the read-from bound to the
 * day's end, page by page, then each thread's replies from the read-from bound, each page within its method's ceiling.
 *
 * @param api - The installation's client.
 * @param channelId - The channel.
 * @param day - The UTC day.
 * @param readFrom - The channel's read-from bound.
 * @param wait - How long the read may wait for a method's minute.
 * @returns The messages and the replies, or null when the read-from bound is after the day.
 */
export async function readSlackDay(api: SlackApi, channelId: string, day: string, readFrom: number,
  wait: SlackWait): Promise<SlackDayMessages | null> {
  const start = slackDayStart(day);
  if (start === null || !isSlackChannelId(channelId)) throw new SourceSyncFault('invalid_response');
  const end = start + SLACK_DAY_MS;
  if (readFrom >= end) return null;
  const oldest = slackTs(Math.max(start, readFrom));
  const latest = `${Math.floor(end / 1000) - 1}.999999`;
  const historyLimit = api.pageSize('conversations.history', 200);
  const repliesLimit = api.pageSize('conversations.replies', 200);
  const messages: SlackMessage[] = [];
  let cursor: string | null = null;
  do {
    const page: SlackPage<SlackMessage> = await slackWithin(wait, () => api.history(channelId,
      { oldest, latest, inclusive: true, cursor, limit: historyLimit }, wait.signal));
    messages.push(...page.items.filter((message) => message.threadTs === null));
    cursor = page.nextCursor;
  } while (cursor !== null);
  const replies: Record<string, SlackMessage[]> = {};
  for (const parent of messages) {
    if (parent.replyCount === 0 || Object.hasOwn(replies, parent.ts)) continue;
    const thread: SlackMessage[] = [];
    let next: string | null = null;
    do {
      const page: SlackPage<SlackMessage> = await slackWithin(wait, () => api.replies(channelId, parent.ts,
        { oldest: slackTs(readFrom), inclusive: true, cursor: next, limit: repliesLimit }, wait.signal));
      thread.push(...page.items.filter((reply) => reply.threadTs === parent.ts));
      next = page.nextCursor;
    } while (next !== null);
    replies[parent.ts] = thread;
  }
  return { messages, replies };
}
