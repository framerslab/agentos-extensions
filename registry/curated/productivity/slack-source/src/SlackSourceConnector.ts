/**
 * @fileoverview The Slack account-source connector of one installation: the original selected-item `list`, `read` and
 * `changesSince` over channel-days, and the resumable `sync` provider the account-source coordinator drives. Its
 * sources are channel-days (`{channel}:{yyyy-mm-dd}`), each one document. Slack's events are the live read: the host
 * queues the days an event changes (`enqueueSlackEvent`), and the provider reads each one. The history phase walks the
 * mode's channel set once a reconcile period, from each channel's anchor (its sub-cursor, or its read-from bound for a
 * channel never read), naming the days of the messages it finds and a slice of each channel's retained window; then it
 * checks each channel read before, and names every day it may hold of one Slack does not have, shares with another
 * organisation, or the set or the host leaves, so each is read as gone. Slack's record of each channel it lists or
 * checks goes to the host before a day of that channel is named, so a day the host holds renders by the record the walk
 * read. It sends no request between walks, and ends a host binding's wait when the call's signal aborts. It commits
 * nothing: the store, the quota and the grant own durability.
 * @module agentos-ext-slack-source/SlackSourceConnector
 */
import {
  SourceSyncFault, decideSourceCache,
  type AccountSourceSyncProvider, type ResumableAccountSourceConnector, type SourceCachePermission, type SourceChanges,
  type SourceGone, type SourceItem, type SourceRead, type SourceSelection, type SourceSyncHistoryPage,
  type SourceSyncReadResult, type SourceSyncRequest, type SourceSyncScanPage, type SourceSyncScope,
} from '@framers/agentos-ext-account-sources';
import { type SlackApi, SlackApiFault, type SlackChannel } from './slack.js';
import { type SlackDayInput, channelDayExpiry, channelDayTitle, mapChannelDay } from './mapChannelDay.js';
import { slackPeopleOf, type SlackMessage } from './messages.js';
import {
  SLACK_CHANNEL_LEFT, SLACK_WALK_CHANNELS, SLACK_WALK_DAYS, SLACK_WALK_START, decodeSlackWalk, encodeSlackWalk,
  readSlackDay, slackAdmission, slackAnchoredChannels, slackBeginAnchor, slackChannelAnchor, slackChannelTypes,
  slackDaysOf, slackHeldDays, slackWalkDue, slackWindowSlice, slackWithin,
  type SlackDayMessages, type SlackWalk, type SlackWait,
} from './history.js';
import {
  type SlackSelectionMode, SLACK_DAY_MS, SLACK_DEFAULT_MODE, channelDayId, isSlackRetainedDays, isSlackSelectionMode,
  isSlackTime, parseChannelDayId, slackDayOf, slackDayStart, slackReadFrom, slackTs, slackTsMs,
} from './types.js';

/**
 * A channel-day the host holds from Slack's events, whole: the messages its copy holds with the events applied since,
 * under the per-message rules (a later version replaces an earlier one, a deleted message stays deleted), and the host's
 * record of the channel. The connector renders it with no request, for a channel the set and the host admit.
 */
export interface SlackHeldDay extends SlackDayMessages {
  /**
   * The host's record of the channel as Slack's events and its reconcile last gave it: its id, its name without the `#`,
   * and whether it is private, holds the bot, is archived and is shared with another organisation.
   */
  readonly channel: SlackChannel;
}

/**
 * What a `SlackSourceConnector` is built from: the installation's client, the connection's start and the host's
 * bindings, all server-side; nothing comes from a browser request.
 */
export interface SlackSourceConnectorOptions {
  /** The installation's Web API client, its quota keyed to the installation. */
  readonly api: SlackApi;
  /** When the connection was made, epoch milliseconds: a channel's start unless `channelStart` names a later one. */
  readonly connectedAt: number;
  /**
   * The host's backfill days, from its plan source, when Backfill is on; null when it is off. A channel's read-from
   * bound is its start less these days. A host that turns Backfill on or off stores a changed policy, which clears
   * every sub-cursor, so each channel is read again from its new bound.
   */
  readonly backfillDays: number | null;
  /**
   * The host's retained days, from its plan source: no channel is read from before this many days ago, a reconcile's
   * window pass covers this many days, and no message is kept past this many days from its day (the connection's
   * retention window, `SourceSyncPolicy.windowMs`, shortens it). The backfill days are at most these. The connector
   * holds no number of days of its own.
   */
  readonly retainedDays: number;
  /** The instant the bot arrived in a channel added after the connection, or null for one there at the connection. */
  readonly channelStart?: (channelId: string, signal?: AbortSignal) => Promise<number | null>;
  /**
   * The host's own admission of a channel the mode admits, such as a public channel a wider mode joined earlier, which
   * the `invited` set leaves until someone invites the bot again; every channel the mode admits when absent.
   */
  readonly admits?: (channel: SlackChannel, mode: SlackSelectionMode, signal?: AbortSignal) => Promise<boolean>;
  /** SaysHere's own bot ids, whose posts no document holds. */
  readonly ownBotIds: readonly string[];
  /** The deleted messages' timestamps the host recorded for a channel-day; none when absent. */
  readonly tombstones?: (channelId: string, day: string, signal?: AbortSignal) => Promise<ReadonlySet<string>>;
  /**
   * A channel-day the host holds whole from Slack's events, rendered with no request when the set and the host admit
   * its channel by the host's record, or null to read it from Slack. A host that gives it gives `reconciled` too.
   */
  readonly held?: (request: SourceSyncRequest, channelId: string, day: string) => Promise<SlackHeldDay | null>;
  /**
   * Takes Slack's record of each channel a walk lists, joins or checks, and the ids of the channels read before that Slack
   * does not have or the bot cannot read, before the walk names a day of any of them. The host applies to its record
   * each change an event it missed left (a channel shared with another organisation, made private, archived, renamed or
   * removed), and has applied it when the call answers, so a day `held` renders afterwards renders by the record the
   * walk read, in the same cycle and in a resumed one. Required with `held`.
   */
  readonly reconciled?: (channels: readonly SlackChannel[], gone: readonly string[], signal?: AbortSignal) => Promise<void>;
  /** The names of people by user id from the host's cache; the connector asks `users.info` for the others. */
  readonly people?: (userIds: readonly string[], signal?: AbortSignal) => Promise<Readonly<Record<string, string>>>;
  /** The host's evidenced permission to keep one read; null records a `not_permitted` skip. */
  readonly permission: (request: SourceSyncRequest) => Promise<SourceCachePermission | null>;
  /** The host's own relative source-detail path for a channel-day; never a Slack link. */
  readonly sourceDetailUrl: (scope: SourceSyncScope, sourceId: string) => string;
  /** Ends the access the connector holds: the host removes the app from the workspace and fences the connection. */
  readonly revoke: () => Promise<void>;
  /** The channel set the original interface lists by when a selection names none; `invited` when absent. */
  readonly mode?: SlackSelectionMode;
  /**
   * How long one `readSource` may wait for a method's minute, in milliseconds, up to 85,000; 80,000 unless given, which
   * keeps a read within the 90,000 one provider call may take (`slackOperationMs`).
   */
  readonly waitMs?: number;
  /** Current time as integer epoch milliseconds, the clock the sync store reads; `Date.now` unless given. */
  readonly clock?: () => number;
}

/**
 * A connector's fixed refusal; its message is `slack_connector_<reason>`: `configuration` for an invalid option,
 * `selection` for a malformed or oversized selection or an unknown mode.
 */
export class SlackConnectorFault extends Error {
  /** @param reason Why the connector refused. */
  constructor(readonly reason: 'configuration' | 'selection') {
    super(`slack_connector_${reason}`); this.name = 'SlackConnectorFault';
  }
}

/** The longest one provider call runs, which `readSource`'s waits keep within: the coordinator's bound on one call. */
export const slackOperationMs = 90_000;

/** The most channel-days one selection of the original interface names. */
const maxSelection = 100;

/**
 * The next days of a channel the set has left, newest first and at most `SLACK_WALK_DAYS`, with the walk's
 * state after them and, with the channel's last day, `SLACK_CHANNEL_LEFT` as its sub-cursor.
 *
 * @param walk - The walk, its `leaving` set.
 * @returns The state, the ids and the sub-cursors to stage.
 */
function nameLeft(walk: SlackWalk): [SlackWalk, string[], Record<string, string>] {
  const { channel, newest, oldest } = walk.leaving!;
  const last = Math.max(oldest, newest - SLACK_WALK_DAYS + 1);
  const ids: string[] = [];
  for (let n = newest; n >= last; n--) ids.push(channelDayId(channel, slackDayOf(n * SLACK_DAY_MS)));
  if (last === oldest) return [{ ...walk, leaving: null }, ids, { [channel]: SLACK_CHANNEL_LEFT }];
  return [{ ...walk, leaving: { channel, newest: last - 1, oldest } }, ids, {}];
}

/**
 * A host binding's answer, or `cancelled` once the call's signal aborts, so a binding that never answers cannot hold
 * the call past the coordinator's bound: the coordinator aborts the signal at that bound and waits for the provider.
 * The binding's own work goes on and its answer is dropped; the bindings are reads.
 *
 * @param signal - The call's cancellation.
 * @param binding - The binding's call.
 * @returns The binding's answer.
 */
function hosted<T>(signal: AbortSignal | undefined, binding: () => Promise<T>): Promise<T> {
  if (signal?.aborted) return Promise.reject(new SourceSyncFault('cancelled'));
  const work = Promise.resolve(binding());
  if (signal === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new SourceSyncFault('cancelled'));
    signal.addEventListener('abort', stop, { once: true });
    work.then((value) => { signal.removeEventListener('abort', stop); resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', stop); reject(error); });
  });
}

/**
 * The Slack account-source connector of one installation. Construction sends nothing; every call checks its
 * cancellation before its first request.
 */
export class SlackSourceConnector implements ResumableAccountSourceConnector {
  /** The account-source kind. */
  readonly kind = 'slack';
  /** The resumable provider the account-source coordinator drives; it commits nothing. */
  readonly sync: AccountSourceSyncProvider;
  private readonly clock: () => number;
  private readonly waitMs: number;
  // Names read through `users.info` in this connector's life, by user id; memory only.
  private readonly names = new Map<string, string>();
  // The set each channel was last listed or reported under by the original interface, by channel id: `read` admits a
  // listed item by it, since an item carries no set. Memory only.
  private readonly listedModes = new Map<string, SlackSelectionMode>();

  /**
   * @param options - The client, the connection's start, the backfill and retained days and the host's bindings.
   * @throws {SlackConnectorFault} `configuration` for a start that is not an instant, retained days that are not a
   *   positive integer, backfill days outside 1 to the retained days, an unknown default mode, a wait past its bound,
   *   or `held` without `reconciled`.
   */
  constructor(private readonly options: SlackSourceConnectorOptions) {
    this.clock = options.clock ?? Date.now;
    this.waitMs = options.waitMs ?? 80_000;
    if (!isSlackTime(options.connectedAt) || !Number.isSafeInteger(this.waitMs) || this.waitMs < 0 || this.waitMs > 85_000
      || (options.held !== undefined && options.reconciled === undefined)
      || (options.mode !== undefined && !isSlackSelectionMode(options.mode)) || !isSlackRetainedDays(options.retainedDays)
      || (options.backfillDays !== null && (!Number.isSafeInteger(options.backfillDays) || options.backfillDays < 1
        || options.backfillDays > options.retainedDays))) throw new SlackConnectorFault('configuration');
    this.sync = Object.freeze({
      kind: 'slack',
      begin: async (request: SourceSyncRequest) => { this.active(request.signal); return slackBeginAnchor(request.subCursors); },
      scanPage: async (request: SourceSyncRequest): Promise<SourceSyncScanPage> => {
        this.active(request.signal); return { kind: 'scan', ids: [], nextPageToken: null };
      },
      historyPage: (request: SourceSyncRequest, fromCursor: string, pageToken: string | null) =>
        this.historyPage(request, fromCursor, pageToken),
      readSource: (request: SourceSyncRequest, sourceId: string) => this.readSource(request, sourceId),
    });
  }

  /** The clock, refused when it is not an instant. */
  private now(): number {
    const value = this.clock();
    if (!isSlackTime(value)) throw new SourceSyncFault('invalid_response');
    return value;
  }

  /** Refuses a cancelled call before it sends anything. */
  private active(signal?: AbortSignal): void { if (signal?.aborted) throw new SourceSyncFault('cancelled'); }

  /**
   * The mode a request reads by: the request's, else the policy's, else the default.
   *
   * @param request - The request.
   * @returns The mode.
   */
  private modeOf(request: SourceSyncRequest): SlackSelectionMode {
    const mode = request.selectionMode ?? request.policy.selectionMode ?? SLACK_DEFAULT_MODE;
    if (!isSlackSelectionMode(mode)) throw new SourceSyncFault('invalid_response');
    return mode;
  }

  /**
   * A channel's read-from bound: its start less the backfill days, never before the host's retained days.
   *
   * @param channelId - The channel.
   * @param now - The current instant.
   * @param signal - The cancellation.
   * @returns The bound.
   */
  private async readFrom(channelId: string, now: number, signal?: AbortSignal): Promise<number> {
    const start = this.options.channelStart
      ? (await hosted(signal, () => this.options.channelStart!(channelId, signal))) ?? null : null;
    return slackReadFrom(start !== null && isSlackTime(start) ? start : this.options.connectedAt, this.options.backfillDays,
      this.options.retainedDays, now);
  }

  /**
   * What the mode, then the host, does with a channel.
   *
   * @param channel - The channel.
   * @param mode - The mode.
   * @param signal - The cancellation.
   * @returns `read`, `join` or null.
   */
  private async admission(channel: SlackChannel, mode: SlackSelectionMode, signal?: AbortSignal): Promise<'read' | 'join' | null> {
    const admitted = slackAdmission(channel, mode);
    if (admitted === null || !this.options.admits) return admitted;
    return await hosted(signal, () => this.options.admits!(channel, mode, signal)) ? admitted : null;
  }

  /**
   * Hands the host Slack's record of the channels a walk read and the ids of those it does not have or cannot read,
   * through `reconciled`; nothing when the host gives no binding or there is nothing to hand.
   *
   * @param channels - Slack's records.
   * @param gone - The channels Slack does not have or the bot cannot read.
   * @param signal - The cancellation.
   */
  private async reconcile(channels: readonly SlackChannel[], gone: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!this.options.reconciled || (channels.length === 0 && gone.length === 0)) return;
    await hosted(signal, () => this.options.reconciled!(channels, gone, signal));
  }

  /**
   * Whether a channel read before is one the set has left: Slack does not have it or the bot cannot read it, or
   * it is shared with another organisation, or the mode or the host leaves it. An archived channel is not: its days
   * expire on their clock, so the walk leaves them unread. Slack's answer goes to the host (`reconciled`) first.
   *
   * @param channelId - The channel.
   * @param mode - The mode.
   * @param signal - The cancellation.
   * @returns Whether its days are to be named.
   */
  private async left(channelId: string, mode: SlackSelectionMode, signal?: AbortSignal): Promise<boolean> {
    let channel: SlackChannel;
    try { channel = await this.options.api.channelInfo(channelId, signal); }
    catch (error) {
      if (!(error instanceof SlackApiFault)) throw error;
      if (error.reason !== 'not_found' && error.reason !== 'no_access') return false;
      await this.reconcile([], [channelId], signal);
      return true;
    }
    await this.reconcile([channel], [], signal);
    if (channel.isArchived) return false;
    return await this.admission(channel, mode, signal) === null;
  }

  /**
   * One history page: no request between walks; during a walk, one channel list page, one join or one page of one
   * channel's history from its anchor, naming the days of its messages and, for a channel read before, its window
   * slice, and staging the walk's cutoff as the channel's sub-cursor once its history is read. Once the set is read, one
   * check of a channel read before (`conversations.info`) a page, in id order; a channel the set has left
   * (`left`) has every day it may hold named, `SLACK_WALK_DAYS` a page, and `SLACK_CHANNEL_LEFT` staged as its
   * sub-cursor with its last page, so each day is read as gone and the next walk leaves the channel. Each list page's
   * channels, each joined channel (a member once Slack answers the join) and each check's answer go to the host
   * (`reconciled`) before a day of theirs is named.
   *
   * @param request - The request.
   * @param fromCursor - The instant of the last walk.
   * @param pageToken - The walk's state, or null to start.
   * @returns The page.
   */
  private async historyPage(request: SourceSyncRequest, fromCursor: string, pageToken: string | null): Promise<SourceSyncHistoryPage> {
    this.active(request.signal);
    const cutoffTs = slackTs(request.cutoff);
    if (pageToken === null && !slackWalkDue(fromCursor, request.cutoff, request.policy.reconcileMs)) {
      return { kind: 'history', ids: [], nextPageToken: null, cursor: fromCursor };
    }
    const walk: SlackWalk | null = pageToken === null ? SLACK_WALK_START : decodeSlackWalk(pageToken);
    if (walk === null) throw new SourceSyncFault('invalid_response');
    const mode = this.modeOf(request);
    const anchored = slackAnchoredChannels(request.subCursors);
    const unchecked = (state: SlackWalk) => anchored.find((id) => state.check === null || id > state.check);
    const next = (state: SlackWalk, ids: string[], subCursors: Record<string, string> = {}): SourceSyncHistoryPage => {
      const done = state.queue.length === 0 && state.list === null && state.leaving === null && unchecked(state) === undefined;
      return { kind: 'history', ids, nextPageToken: done ? null : encodeSlackWalk(state),
        cursor: done ? cutoffTs : fromCursor, subCursors };
    };
    if (walk.leaving !== null) return next(...nameLeft(walk));
    if (walk.queue.length === 0 && walk.list === null) {
      const channelId = unchecked(walk);
      if (channelId === undefined) return next({ ...walk, check: walk.check ?? '' }, []);
      const checked: SlackWalk = { ...walk, check: channelId };
      if (!await this.left(channelId, mode, request.signal)) return next(checked, []);
      const readFrom = await this.readFrom(channelId, request.cutoff, request.signal);
      const held = slackHeldDays(readFrom, request.cutoff, this.options.retainedDays);
      if (held === null) return next(checked, [], { [channelId]: SLACK_CHANNEL_LEFT });
      return next(...nameLeft({ ...checked, leaving: { channel: channelId, ...held } }));
    }
    if (walk.queue.length === 0) {
      const limit = Math.min(SLACK_WALK_CHANNELS, request.policy.scanPageSize, this.options.api.pageSize('conversations.list', SLACK_WALK_CHANNELS));
      const page = await this.options.api.listChannels(slackChannelTypes(mode), walk.list === '' ? null : walk.list, limit, request.signal);
      await this.reconcile(page.items, [], request.signal);
      const queue: string[] = [];
      for (const channel of page.items) {
        const admitted = await this.admission(channel, mode, request.signal);
        if (admitted !== null) queue.push(admitted === 'join' ? `+${channel.id}` : channel.id);
      }
      return next({ ...walk, list: page.nextCursor, queue: queue.slice(0, SLACK_WALK_CHANNELS), history: null }, []);
    }
    const head = walk.queue[0]!;
    const rest = walk.queue.slice(1);
    if (head.startsWith('+')) {
      const channelId = head.slice(1);
      let joined: SlackChannel;
      try { joined = await this.options.api.join(channelId, request.signal); }
      catch (error) {
        if (error instanceof SlackApiFault) return next({ ...walk, queue: rest, history: null }, []);
        throw error;
      }
      if (!joined.isMember && joined.isPrivate) return next({ ...walk, queue: rest, history: null }, []);
      await this.reconcile([{ ...joined, isMember: true }], [], request.signal);
      return next({ ...walk, queue: [channelId, ...rest], history: null }, []);
    }
    const channelId = head;
    const readFrom = await this.readFrom(channelId, request.cutoff, request.signal);
    const anchor = slackChannelAnchor(request.subCursors, channelId);
    const anchorMs = anchor === null ? null : slackTsMs(anchor)!;
    const oldest = slackTs(Math.max(readFrom, anchorMs ?? 0));
    try {
      const page = await this.options.api.history(channelId, { oldest, latest: cutoffTs, inclusive: anchor === null,
        cursor: walk.history, limit: this.options.api.pageSize('conversations.history', 200) }, request.signal);
      const ids = slackDaysOf(channelId, page.items);
      if (walk.history === null && anchor !== null) {
        for (const day of slackWindowSlice(readFrom, request.cutoff, this.options.retainedDays)) {
          const id = channelDayId(channelId, day);
          if (!ids.includes(id)) ids.push(id);
        }
      }
      if (page.nextCursor !== null) return next({ ...walk, history: page.nextCursor }, ids);
      return next({ ...walk, queue: rest, history: null }, ids, { [channelId]: cutoffTs });
    } catch (error) {
      if (error instanceof SlackApiFault) return next({ ...walk, queue: rest, history: null }, []);
      throw error;
    }
  }

  /**
   * The names of a day's people: the host's cache first, then `users.info` for the others, each within the wait.
   *
   * @param messages - The day's messages and replies.
   * @param wait - How long a call may wait for its method's minute.
   * @returns The names by user id.
   */
  private async peopleOf(messages: readonly SlackMessage[], wait: SlackWait): Promise<Record<string, string>> {
    const ids = slackPeopleOf(messages);
    const names: Record<string, string> = {};
    const cached = ids.length > 0 && this.options.people
      ? await hosted(wait.signal, () => this.options.people!(ids, wait.signal)) : {};
    for (const id of ids) {
      if (Object.hasOwn(cached, id) && typeof cached[id] === 'string') names[id] = cached[id]!;
      else if (this.names.has(id)) names[id] = this.names.get(id)!;
      else {
        try {
          const person = await slackWithin(wait, () => this.options.api.userInfo(id, wait.signal));
          this.names.set(id, person.name); names[id] = person.name;
        } catch (error) {
          if (!(error instanceof SlackApiFault)) throw error;
        }
      }
    }
    return names;
  }

  /**
   * One channel-day as its messages render it, with the host's tombstones and names, or null when none remains.
   *
   * @param channelId - The channel.
   * @param day - The day.
   * @param channelName - The channel's name.
   * @param messages - The day's messages and replies.
   * @param render - The read-from bound, the retained days, the window, the read time, the keep decision and the host's
   *   path, null for the original interface's read.
   * @param wait - How long a call may wait for its method's minute.
   * @returns The document, or null.
   */
  private async render(channelId: string, day: string, channelName: string,
    messages: SlackDayMessages, render: { readFrom: number; retainedDays: number; windowMs: number; readAt: number;
      sourceDetailUrl: string | null; cache: Extract<ReturnType<typeof decideSourceCache>, { kind: 'cache' }> }, wait: SlackWait) {
    const all = [...messages.messages, ...Object.values(messages.replies).flat()];
    const input: SlackDayInput = { channelId, channelName, day, messages: messages.messages, replies: messages.replies,
      people: await this.peopleOf(all, wait) };
    const tombstones = this.options.tombstones
      ? await hosted(wait.signal, () => this.options.tombstones!(channelId, day, wait.signal)) : new Set<string>();
    return mapChannelDay(input, { ...render, ownBotIds: this.options.ownBotIds, tombstones });
  }

  /**
   * Reads one channel-day for the coordinator: a day the host holds whole is rendered with no request when the mode and
   * the host admit its channel by the host's record, which each walk refreshes (`reconciled`); otherwise the channel's
   * details first. A channel gone, shared with another organisation or outside the mode answers the day gone either
   * way. Then the day's messages and replies. A method's minute without room is waited for within the read's bound, and
   * a later time is answered as a retry.
   *
   * @param request - The request.
   * @param sourceId - The channel-day.
   * @returns The document, gone, a skip or a retry.
   */
  private async readSource(request: SourceSyncRequest, sourceId: string): Promise<SourceSyncReadResult> {
    this.active(request.signal);
    const parsed = parseChannelDayId(sourceId);
    if (parsed === null) return { kind: 'gone', id: sourceId };
    const { channelId, day } = parsed;
    const readStartedAt = this.now();
    const wait: SlackWait = { until: readStartedAt + this.waitMs, clock: () => this.now(), signal: request.signal };
    const permission = await hosted(request.signal, () => this.options.permission(request));
    if (permission === null) return { kind: 'skipped', id: sourceId, reason: 'not_permitted' };
    try {
      const readFrom = await this.readFrom(channelId, request.cutoff, request.signal);
      const held = this.options.held
        ? (await hosted(request.signal, () => this.options.held!(request, channelId, day))) ?? null : null;
      if (held !== null && held.channel.id !== channelId) throw new SourceSyncFault('invalid_response');
      const channel = held !== null ? held.channel
        : await slackWithin(wait, () => this.options.api.channelInfo(channelId, request.signal));
      if (await this.admission(channel, this.modeOf(request), request.signal) !== 'read') return { kind: 'gone', id: sourceId };
      const messages = held ?? await readSlackDay(this.options.api, channelId, day, readFrom, wait);
      if (messages === null) return { kind: 'gone', id: sourceId };
      const readAt = this.now();
      const windowExpiresAt = channelDayExpiry(day, this.options.retainedDays, request.policy.windowMs);
      const cache = decideSourceCache({ permission, maximumCacheMs: this.options.retainedDays * SLACK_DAY_MS, readStartedAt,
        receivedAt: readAt, windowExpiresAt,
        // The Web API's HTTP cache headers describe a response, not the data's retention, which Slack's API terms set
        // and the host's permission evidences.
        headers: { cacheControl: null, date: null, age: null, expires: null } });
      if (cache.kind === 'skip') return { kind: 'skipped', id: sourceId, reason: cache.reason };
      const document = await this.render(channelId, day, channel.name, messages, { readFrom,
        retainedDays: this.options.retainedDays, windowMs: request.policy.windowMs, readAt, cache,
        sourceDetailUrl: this.options.sourceDetailUrl(request.scope, sourceId) }, wait);
      return document === null ? { kind: 'gone', id: sourceId } : { kind: 'document', document };
    } catch (error) {
      if (error instanceof SlackApiFault) {
        if (error.reason === 'response_too_large') return { kind: 'skipped', id: sourceId, reason: 'response_too_large' };
        if (error.reason === 'archived') return { kind: 'skipped', id: sourceId, reason: 'excluded' };
        return { kind: 'gone', id: sourceId };
      }
      if (error instanceof SourceSyncFault && error.code === 'rate_limited' && error.retryAt !== null) {
        return { kind: 'retry', id: sourceId, reason: 'rate_limited', retryAt: Math.max(error.retryAt, this.now() + 1) };
      }
      throw error;
    }
  }

  /**
   * The selection's channel-days by channel, refused when malformed, past 100 or under an unknown mode.
   *
   * @param selection - The selection.
   * @returns The mode and the days by channel.
   */
  private selected(selection: SourceSelection): { mode: SlackSelectionMode; byChannel: Map<string, string[]> } {
    const mode = selection.mode ?? this.options.mode ?? SLACK_DEFAULT_MODE;
    if (!isSlackSelectionMode(mode) || !Array.isArray(selection.ids) || selection.ids.length > maxSelection) {
      throw new SlackConnectorFault('selection');
    }
    const byChannel = new Map<string, string[]>();
    for (const id of selection.ids) {
      const parsed = parseChannelDayId(id);
      if (parsed === null) throw new SlackConnectorFault('selection');
      const days = byChannel.get(parsed.channelId) ?? [];
      if (!days.includes(parsed.day)) days.push(parsed.day);
      byChannel.set(parsed.channelId, days);
    }
    return { mode, byChannel };
  }

  /**
   * A channel's details for the original interface, or why its days are gone.
   *
   * @param channelId - The channel.
   * @param mode - The mode.
   * @param signal - The cancellation.
   * @param wait - How long the call may wait for the method's minute; none when absent.
   * @returns The channel, or the reason its days are gone.
   */
  private async channelFor(channelId: string, mode: SlackSelectionMode, signal?: AbortSignal, wait?: SlackWait):
    Promise<SlackChannel | SourceGone['reason']> {
    try {
      const info = () => this.options.api.channelInfo(channelId, signal);
      const channel = await (wait === undefined ? info() : slackWithin(wait, info));
      return await this.admission(channel, mode, signal) === 'read' ? channel : 'no_access';
    } catch (error) {
      if (error instanceof SlackApiFault) return error.reason === 'not_found' ? 'removed' : 'no_access';
      throw error;
    }
  }

  /**
   * Lists the selected channel-days the mode reads, and names the others gone: a channel Slack does not have as
   * `removed`, one outside the mode as `no_access`. An empty selection sends no request.
   *
   * @param selection - Channel-day ids and an optional mode.
   * @param signal - The cancellation.
   * @returns The items and the gone ones, in the selection's order.
   */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    this.active(signal);
    const { mode, byChannel } = this.selected(selection);
    const items: SourceItem[] = []; const gone: SourceGone[] = [];
    for (const [channelId, days] of byChannel) {
      const channel = await this.channelFor(channelId, mode, signal);
      if (typeof channel !== 'string') this.listedModes.set(channelId, mode);
      for (const day of days) {
        const id = channelDayId(channelId, day);
        if (typeof channel === 'string') gone.push({ id, reason: channel });
        else items.push({ id, title: channelDayTitle(channel.name, day), size: null, version: null });
      }
    }
    return { items, gone };
  }

  /**
   * Reads one channel-day with its attribution, or reports it gone: a channel Slack does not have, or a day with no
   * message left, as `removed`; a channel outside the set as `no_access`. The set is the one this connector last listed
   * or reported the channel under, since an item carries none, else the connector's default. A method's minute without
   * room is waited for within the connector's wait bound (`waitMs`); a later time is thrown as `rate_limited` with it.
   *
   * @param item - The channel-day.
   * @param signal - The cancellation.
   * @returns The read, or why it is gone.
   */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    this.active(signal);
    const parsed = parseChannelDayId(item.id);
    if (parsed === null) throw new SlackConnectorFault('selection');
    const mode = this.listedModes.get(parsed.channelId) ?? this.selected({ ids: [item.id] }).mode;
    const now = this.now();
    const wait: SlackWait = { until: now + this.waitMs, clock: () => this.now(), signal };
    const channel = await this.channelFor(parsed.channelId, mode, signal, wait);
    if (typeof channel === 'string') return { id: item.id, reason: channel };
    const readFrom = await this.readFrom(parsed.channelId, now, signal);
    const messages = await readSlackDay(this.options.api, parsed.channelId, parsed.day, readFrom, wait);
    if (messages === null) return { id: item.id, reason: 'removed' };
    const retainedDays = this.options.retainedDays; const windowMs = retainedDays * SLACK_DAY_MS;
    const expiresAt = channelDayExpiry(parsed.day, retainedDays, windowMs);
    const document = await this.render(parsed.channelId, parsed.day, channel.name, messages, { readFrom, retainedDays, windowMs,
      readAt: now, sourceDetailUrl: null, cache: { kind: 'cache', expiresAt, evidenceId: 'read' } }, wait);
    return document === null ? { id: item.id, reason: 'removed' } : document.read;
  }

  /**
   * The selected channel-days that may have changed since a cursor, and those whose channel is gone, with the next
   * cursor: the instant the call began. Slack's history lists a channel's messages by the time each was posted, and an
   * edit, a thread reply sent to the thread alone or a deletion of an older message carries no newer time, so every
   * selected day of a channel the mode reads, from its read-from bound's day to the call's day, is reported changed and
   * read again; a day wholly before the bound or after the call holds nothing and is left out. The call reads each
   * channel's details and no history. The resumable provider takes the same changes from Slack's events. An empty
   * selection answers no change and sends no request.
   *
   * @param cursor - The instant of the last call, a Slack timestamp, or null for the first.
   * @param selection - Channel-day ids and an optional mode.
   * @param signal - The cancellation.
   * @returns The changes and the next cursor.
   */
  async changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges> {
    this.active(signal);
    if (cursor !== null && slackTsMs(cursor) === null) throw new SlackConnectorFault('selection');
    const { mode, byChannel } = this.selected(selection);
    const now = this.now(); const next = slackTs(now);
    const changed: SourceItem[] = []; const gone: SourceGone[] = [];
    for (const [channelId, days] of byChannel) {
      const channel = await this.channelFor(channelId, mode, signal);
      if (typeof channel === 'string') {
        for (const day of days) gone.push({ id: channelDayId(channelId, day), reason: channel });
        continue;
      }
      this.listedModes.set(channelId, mode);
      const readFrom = await this.readFrom(channelId, now, signal);
      for (const day of days) {
        const start = slackDayStart(day)!;
        if (start + SLACK_DAY_MS <= readFrom || start > now) continue;
        changed.push({ id: channelDayId(channelId, day), title: channelDayTitle(channel.name, day), size: null, version: null });
      }
    }
    return { changed, gone, cursor: next };
  }

  /** Ends the access the connector holds, through the host. */
  async revoke(): Promise<void> { await this.options.revoke(); }
}
