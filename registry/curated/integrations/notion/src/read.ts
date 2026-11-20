/**
 * @fileoverview The pages a person shared with a public connection, read as an account source: a listing of the pages
 * the grant reaches, newest edited first; the changes since a cursor of the pages a host holds; and the connection's
 * capability check. Notion's search is no inventory: its index takes time to show a page shared, unshared or moved to
 * the trash, so every page a host holds is retrieved on every pass whatever search says, and search only adds pages
 * the host does not hold yet. Every call is paced, by the host's shared budget when one is given and otherwise by a
 * sliding one-minute window inside the connector, and a 429 is passed on with Notion's wait, never retried here.
 *
 * A page is read as Markdown text (`notionMarkdown`) from its blocks, one level a call, inside the host's bounds on its
 * blocks, its depth and its characters; a page past one answers `too_large` and is never cut.
 *
 * Sources, read on 20 November 2026: https://developers.notion.com/reference/post-search.md,
 * https://developers.notion.com/reference/search-optimizations-and-limitations.md,
 * https://developers.notion.com/reference/retrieve-a-page.md, https://developers.notion.com/reference/get-block-children.md,
 * https://developers.notion.com/reference/block.md, https://developers.notion.com/reference/pagination.md,
 * https://developers.notion.com/reference/request-limits.md and https://developers.notion.com/reference/status-codes.md.
 * @module agentos-ext-notion/read
 */

import type {
  AccountSourceConnector, SourceChanges, SourceGone, SourceItem, SourceRead, SourceSelection,
} from '@framers/agentos-ext-account-sources';
import { childrenWritten, leastChars, notionMarkdown, type NotionBlockNode } from './blocks.js';
import { NotionFault, apiFault } from './faults.js';
import { NOTION_VERSION } from './oauth.js';
import { linkOf } from './pages.js';
import { NOTION_ID, apiOrigin, call, credential, isObject, jsonObject } from './transport.js';

/** The kind of the connector and of every passage it reads. */
export const NOTION_READ_KIND = 'notion';

/** Where a page sits, as a catalog shows it beside the page's title. */
export interface NotionPageParent {
  /** The workspace's top level, a page, a database (a page of one of its data sources) or a block of a page. */
  readonly type: 'workspace' | 'page' | 'database' | 'block';
  /** The parent's id; null at the workspace's top level. */
  readonly id: string | null;
}

/** A page as `list()` and `changesSince()` answer it: the contract's item and the page's parent. */
export interface NotionPageItem extends SourceItem {
  readonly parent: NotionPageParent;
}

/** The kind of call a host's shared budget is asked to send. */
export type NotionReadMethod = 'search' | 'retrieve' | 'children';

/** What the connector reads with and within. */
export interface NotionReadOptions {
  /** The grant's access token; the host renews it (`NotionOAuthFlow.accessToken`). */
  readonly accessToken: string;
  /** The most new pages `list()` and `changesSince()` answer from a relist. */
  readonly maxPages: number;
  /** Levels of child blocks a page is read to; the page's own children are level 1. */
  readonly maxDepth: number;
  /** Blocks a page, every level counted. */
  readonly maxBlocks: number;
  /** Characters of a page's Markdown text. */
  readonly maxChars: number;
  /** The connector's own pacing when no `send` is given: calls in any minute, 180 when absent. */
  readonly requestsPerMinute?: number;
  /** Calls one `list`, `read` or `changesSince` keeps in flight at once; 1 when absent. */
  readonly concurrency?: number;
  /** The host's shared budget: every call goes through it when given, and the connector paces nothing itself. */
  readonly send?: <T>(method: NotionReadMethod, call: (signal: AbortSignal) => Promise<T>) => Promise<T>;
  /** Each call's deadline, its answer included; 30,000 milliseconds when absent. */
  readonly timeoutMs?: number;
  /** The fetch every call is made with; the global fetch when absent. */
  readonly fetchImpl?: typeof fetch;
  /** Stops the connector: once it has aborted no call starts, and a call under way stops being waited on. */
  readonly signal?: AbortSignal;
  /** A stand-in's origin, such as `http://127.0.0.1:9440`, taken only on CI at a loopback or `.invalid` host. */
  readonly apiBase?: string;
  /** Ends the grant at Notion, as `NotionOAuthFlow` revokes it; `revoke()` does nothing without it. */
  readonly revoke?: () => Promise<unknown>;
  /** The clock a read's time is taken from; the system clock when absent. */
  readonly now?: () => Date;
}

/** One answer: its status, its headers and its JSON object (empty for any other text). */
interface Exchanged {
  readonly status: number;
  readonly headers: Headers;
  readonly answer: Record<string, unknown>;
}

/** The most bytes read of one answer. */
const ANSWER_BYTES = 2_000_000;

/** A call's deadline when none is given. */
const DEADLINE_MS = 30_000;

/** The connector's own pacing when none is given: Notion's 180 requests a minute a connection on most plans. */
const REQUESTS_PER_MINUTE = 180;

/** The window the connector's own pacing counts calls in. */
const WINDOW_MS = 60_000;

/** The most calls one operation may be given to keep in flight. */
const MOST_CONCURRENCY = 64;

/** The most search pages one relist reads, so an answer that repeats its cursor forever still ends. */
const MOST_SEARCH_PAGES = 1_000;

/** Search's largest page, and a block's children's. */
const SEARCH_PAGE_SIZE = 100;

/** The blocks inside a page whose own content is another page or database, never read. */
const UNREAD: ReadonlySet<string> = new Set(['child_page', 'child_database']);

/** Why a page's block read stopped before its end. */
type Stop =
  | { readonly kind: 'too_large' }
  | { readonly kind: 'gone'; readonly reason: 'removed' | 'no_access' }
  | { readonly kind: 'vanished' }
  | { readonly kind: 'fault'; readonly error: unknown };

/**
 * One children call to make: the block, the cursor of its next page, its children's level and where they go, whether
 * the page's text writes them, and the type of the block they belong to (null for the page's own).
 */
interface ChildrenCall {
  readonly id: string;
  readonly cursor?: string;
  readonly level: number;
  readonly into: NotionBlockNode[];
  readonly top: boolean;
  readonly written: boolean;
  readonly parent: string | null;
}

/** What a page's block read has counted so far: its blocks, the fewest characters of its text, each listing's cursors. */
interface Counted {
  blocks: number;
  chars: number;
  readonly cursors: Map<string, Set<string>>;
}

/** A positive whole number no larger than `most`. */
function count(value: unknown, most = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= most;
}

/** A function, or absent. */
function optionalFunction(value: unknown): boolean {
  return value === undefined || typeof value === 'function';
}

/** An id as compared: lower case, without hyphens, so either form of one page's id matches. */
function canonical(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/** A string field of an object, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** True for a page in the trash or archived, which no listing answers and a holder loses. */
function away(page: Record<string, unknown>): boolean {
  return page.in_trash === true || page.is_archived === true || page.archived === true;
}

/** The plain text of a page's title property; the empty string when it has none. */
function titleOf(properties: unknown): string {
  if (!isObject(properties)) return '';
  for (const property of Object.values(properties as Record<string, unknown>)) {
    if (!isObject(property)) continue;
    const field = property as Record<string, unknown>;
    if (field.type !== 'title' || !Array.isArray(field.title)) continue;
    return field.title.map((part) => (isObject(part) ? text((part as Record<string, unknown>).plain_text) ?? '' : '')).join('');
  }
  return '';
}

/**
 * A page's parent as a catalog shows it. A page of a data source names the data source's database; a parent of a
 * kind the library does not show (an agent) reads as the workspace's top level.
 */
function parentOf(parent: unknown): NotionPageParent {
  if (!isObject(parent)) return { type: 'workspace', id: null };
  const value = parent as Record<string, unknown>;
  switch (value.type) {
    case 'page_id': return { type: 'page', id: text(value.page_id) };
    case 'database_id':
    case 'data_source_id': return { type: 'database', id: text(value.database_id) };
    case 'block_id': return { type: 'block', id: text(value.block_id) };
    default: return { type: 'workspace', id: null };
  }
}

/** A page object as an item, or null for a result that is no full page (a partial page names no version). */
function pageItem(value: unknown): NotionPageItem | null {
  if (!isObject(value)) return null;
  const page = value as Record<string, unknown>;
  if (page.object !== 'page' || typeof page.id !== 'string' || !NOTION_ID.test(page.id)) return null;
  const version = page.last_edited_time;
  if (typeof version !== 'string' || version.length === 0 || version.length > 64) return null;
  return { id: page.id, title: titleOf(page.properties), size: null, version, parent: parentOf(page.parent) };
}

/** Items newest edited first; equal times by id, so one set of pages always answers in one order. */
function newestFirst<T extends SourceItem>(items: T[]): T[] {
  const time = (item: T): number => {
    const parsed = Date.parse(item.version ?? '');
    return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
  };
  return items.sort((x, y) => time(y) - time(x) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/** The ids a selection names, each once, in its order; `configuration` for a selection that is not one. */
function idsOf(selection: SourceSelection): string[] {
  if (!isObject(selection) || !Array.isArray(selection.ids) || selection.ids.some((id) => typeof id !== 'string')) {
    throw new NotionFault('configuration');
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of selection.ids) {
    if (seen.has(canonical(id))) continue;
    seen.add(canonical(id));
    ids.push(id);
  }
  return ids;
}

/**
 * A cursor read back: the pages a host holds and their versions, in its order. A null cursor holds none;
 * `configuration` for one that is not a JSON object of strings.
 */
function cursorOf(cursor: string | null): Map<string, string> {
  if (cursor === null) return new Map();
  let parsed: unknown;
  try {
    parsed = typeof cursor === 'string' ? JSON.parse(cursor) : undefined;
  } catch {
    throw new NotionFault('configuration');
  }
  if (!isObject(parsed) || Array.isArray(parsed)) throw new NotionFault('configuration');
  const held = new Map<string, string>();
  for (const [id, version] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof version !== 'string') throw new NotionFault('configuration');
    held.set(id, version);
  }
  return held;
}

/**
 * Runs `work` over `items` with at most `limit` in flight and answers their results in the items' order, as one at a
 * time would. After a fault no further item starts: `halt`, given to every item's work, aborts, so a call still waiting
 * for the window or the host's budget never goes out, while a call already sent is let settle. The first fault is
 * thrown once the work in flight has settled.
 */
async function inOrder<T, R>(items: readonly T[], limit: number, work: (item: T, halt: AbortSignal) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  const halting = new AbortController();
  let next = 0;
  let failed = false;
  let fault: unknown;
  const lane = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await work(items[index]!, halting.signal);
      } catch (error) {
        if (!failed) {
          failed = true;
          fault = error;
          halting.abort();
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed) throw fault;
  return results;
}

/** A timer as Node answers it, which can hold the process open or let it go. */
interface Holdable {
  ref?: () => unknown;
  unref?: () => unknown;
}

/**
 * Answers `work`, or throws `cancelled` as soon as one of `signals` aborts, so a call a host's budget holds stops being
 * waited on; `work` is still let settle, and its outcome is then dropped.
 */
function abortable<T>(work: Promise<T>, signals: readonly AbortSignal[]): Promise<T> {
  if (signals.length === 0) return work;
  const signal = AbortSignal.any([...signals]);
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new NotionFault('cancelled'));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new NotionFault('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work.then((value) => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/**
 * A sliding one-minute window of `limit` calls. A call holds its place from its start until a minute after it, or
 * until it settles when that is later, so a call in flight always counts. A call waiting for a place stops waiting,
 * with `cancelled`, when its signal aborts. The timers that give places back hold the process open while a call
 * waits for one, and let it go once none waits, so a script ends as soon as its last answer is in.
 */
class CallWindow {
  private held = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly timers = new Set<Holdable>();

  constructor(private readonly limit: number) {}

  /** Waits for a place and answers the function that gives it back once the call has settled. */
  async enter(signal: AbortSignal | undefined): Promise<() => void> {
    while (this.held >= this.limit) await this.turn(signal);
    if (signal?.aborted === true) {
      // Woken for a place and stopped before taking it: the place goes to the next call waiting.
      if (this.held < this.limit) this.waiting.shift()?.();
      throw new NotionFault('cancelled');
    }
    this.held += 1;
    const started = Date.now();
    return () => {
      const left = started + WINDOW_MS - Date.now();
      if (left <= 0) {
        this.release();
        return;
      }
      const timer: Holdable = setTimeout(() => {
        this.timers.delete(timer);
        this.release();
      }, left);
      this.timers.add(timer);
      this.hold();
    };
  }

  /** Refs every give-back timer while a call waits, and unrefs them all once none does. */
  private hold(): void {
    const keep = this.waiting.length > 0;
    for (const timer of this.timers) {
      if (keep) timer.ref?.();
      else timer.unref?.();
    }
  }

  private release(): void {
    this.held -= 1;
    this.waiting.shift()?.();
  }

  private turn(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(new NotionFault('cancelled'));
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        const at = this.waiting.indexOf(wake);
        if (at >= 0) this.waiting.splice(at, 1);
        this.hold();
        reject(new NotionFault('cancelled'));
      };
      const wake = (): void => {
        signal?.removeEventListener('abort', abort);
        this.hold();
        resolve();
      };
      this.waiting.push(wake);
      this.hold();
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
}

/**
 * The pages a public connection was shared, read as an account source. `list` and `changesSince` answer each page with
 * its id, its title as plain text, its last edit as its version and its parent; `read` reads one page's text.
 * Every failure is a `NotionFault`: `configuration` for an option or an input refused before any call, `cancelled` once
 * a signal has aborted, Notion's refusal by its reason (`unauthorized`, `restricted` for a grant without Read content,
 * `rate_limited` with Notion's wait), `unavailable` for a 5xx, and the transport's `timeout`, `network` and
 * `response_too_large`.
 */
export class NotionReadConnector implements AccountSourceConnector {
  readonly kind = NOTION_READ_KIND;
  private readonly options: NotionReadOptions;
  private readonly origin: string;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private readonly window: CallWindow;
  private readonly headers: Record<string, string>;

  /**
   * @param options The grant's access token, the bounds and how calls are sent. Throws `NotionFault` with
   * `configuration` for an option it refuses, before any call: a token that is not a credential, a bound that is not a
   * positive whole number, a stand-in address off CI or at a host that is not loopback or `.invalid`.
   */
  constructor(options: NotionReadOptions) {
    if (!isObject(options) || !credential(options.accessToken)) throw new NotionFault('configuration');
    for (const bound of [options.maxPages, options.maxDepth, options.maxBlocks, options.maxChars]) {
      if (!count(bound)) throw new NotionFault('configuration');
    }
    if (options.requestsPerMinute !== undefined && !count(options.requestsPerMinute)) throw new NotionFault('configuration');
    if (options.concurrency !== undefined && !count(options.concurrency, MOST_CONCURRENCY)) throw new NotionFault('configuration');
    if (options.timeoutMs !== undefined && !count(options.timeoutMs)) throw new NotionFault('configuration');
    if (![options.send, options.fetchImpl, options.revoke, options.now].every(optionalFunction)) throw new NotionFault('configuration');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new NotionFault('configuration');
    this.origin = apiOrigin(options.apiBase);
    this.options = options;
    this.concurrency = options.concurrency ?? 1;
    this.timeoutMs = options.timeoutMs ?? DEADLINE_MS;
    this.window = new CallWindow(options.requestsPerMinute ?? REQUESTS_PER_MINUTE);
    this.headers = { authorization: `Bearer ${options.accessToken}`, accept: 'application/json', 'notion-version': NOTION_VERSION };
  }

  /**
   * With no ids, the pages the grant reaches, newest edited first, searched page after page up to `maxPages`; pages in
   * the trash or archived are left out. With ids, each page retrieved: a 404 or a page in the trash or archived is
   * `removed`, a 403 `no_access`. A 403 on search throws `restricted`: the grant has no Read content.
   */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: NotionPageItem[]; gone: SourceGone[] }> {
    const ids = idsOf(selection);
    if (ids.length === 0) return { items: await this.relist(new Set(), signal), gone: [] };
    const answers = await inOrder(ids, this.concurrency, (id, halt) => this.retrieve(id, signal, halt));
    return { items: answers.filter((answer): answer is NotionPageItem => 'version' in answer), gone: answers.filter((answer): answer is SourceGone => 'reason' in answer) };
  }

  /**
   * Reads one page as Markdown text with its attribution, or answers why it cannot. The page is retrieved first: a 404
   * or a page in the trash or archived answers `removed`, a 403 `no_access`. Its blocks are then read one level a call,
   * up to `concurrency` calls in flight, into the page's order whatever order the answers come in; a child page or a
   * child database is written as its title and never read. A page past `maxBlocks`, `maxDepth` or `maxChars` answers
   * `too_large` and no further call starts; characters are counted as the blocks arrive. A 404 or 403 on the page's
   * first children call answers `removed` or `no_access`; on any later children call the page is retrieved again,
   * and the read answers why it is gone, or throws `unavailable` when it is still there, so a host keeps nothing new
   * and tries again. A fault starts no further call and is thrown once the calls in flight have settled.
   */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    if (!isObject(item) || typeof item.id !== 'string') throw new NotionFault('configuration');
    const id = item.id;
    const page = await this.page(id, signal);
    if ('reason' in page) return page;
    const { blocks, stop } = await this.blocksOf(id, signal);
    if (stop?.kind === 'fault') throw stop.error;
    if (stop?.kind === 'gone') return { id, reason: stop.reason };
    if (stop?.kind === 'too_large') return { id, reason: 'too_large' };
    if (stop?.kind === 'vanished') {
      const again = await this.page(id, signal);
      if ('reason' in again) return again;
      throw new NotionFault('unavailable');
    }
    const text = notionMarkdown(blocks);
    if (text.length > this.options.maxChars) return { id, reason: 'too_large' };
    const readAt = (this.options.now?.() ?? new Date()).toISOString();
    return {
      item: { ...page.item, id },
      content: { text },
      ref: { kind: NOTION_READ_KIND, title: page.item.title, url: linkOf(page.answer, id), version: page.item.version, readAt },
    };
  }

  /**
   * The changes since `cursor`, a JSON object of the pages a host holds and their versions (`null` for none). With no
   * ids, one relist runs first, and adds as `changed` up to `maxPages` pages the cursor does not hold; then every page
   * the cursor holds is retrieved, whatever search says, since Notion's index lags shares, unshares and the trash. A
   * retrieved version unlike the cursor's is `changed`; a 404 or a page in the trash or archived is `removed`, a 403
   * `no_access`. With ids, those pages alone are retrieved and no relist runs. `changed` is newest edited first, and
   * the answered cursor holds every page that answered, at the version it answered. A page the relist adds is search's
   * word alone, which can lag an unshare: `read` retrieves it first and answers `removed` or `no_access` when it is
   * gone.
   */
  async changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges & { changed: NotionPageItem[] }> {
    const held = cursorOf(cursor);
    const ids = idsOf(selection);
    const chosen = ids.length > 0;
    const targets = chosen ? ids : [...held.keys()];
    const heldIds = new Set([...held.keys()].map(canonical));
    const fresh = chosen ? [] : await this.relist(heldIds, signal);
    const answers = await inOrder(targets, this.concurrency, (id, halt) => this.retrieve(id, signal, halt));
    const versions = new Map([...held].map(([id, version]) => [canonical(id), version]));
    const changed: NotionPageItem[] = [...fresh];
    const gone: SourceGone[] = [];
    const next: Record<string, string> = {};
    for (const answer of answers) {
      if ('reason' in answer) {
        gone.push(answer);
        continue;
      }
      next[answer.id] = answer.version as string;
      if (versions.get(canonical(answer.id)) !== answer.version) changed.push(answer);
    }
    for (const item of fresh) next[item.id] = item.version as string;
    return { changed: newestFirst(changed), gone, cursor: JSON.stringify(next) };
  }

  /** Ends the grant through the `revoke` the host gave; nothing without one. */
  async revoke(): Promise<void> {
    if (this.options.revoke !== undefined) await this.options.revoke();
  }

  /** Searches page after page and answers, newest edited first, up to `maxPages` pages not among `skip`. */
  private async relist(skip: ReadonlySet<string>, signal: AbortSignal | undefined): Promise<NotionPageItem[]> {
    const found = new Map<string, NotionPageItem>();
    const cursors = new Set<string>();
    let start: string | undefined;
    for (let read = 0; read < MOST_SEARCH_PAGES; read += 1) {
      const body = {
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: SEARCH_PAGE_SIZE,
        ...(start === undefined ? {} : { start_cursor: start }),
      };
      const { status, headers, answer } = await this.exchange('search', '/v1/search', JSON.stringify(body), signal);
      if (status < 200 || status > 299) throw apiFault(status, headers, answer, false);
      if (!Array.isArray(answer.results)) throw new NotionFault('invalid_response', { status });
      for (const result of answer.results) {
        if (found.size >= this.options.maxPages) break;
        if (!isObject(result) || away(result as Record<string, unknown>)) continue;
        const item = pageItem(result);
        if (item === null || skip.has(canonical(item.id)) || found.has(canonical(item.id))) continue;
        found.set(canonical(item.id), item);
      }
      const following = answer.next_cursor;
      if (found.size >= this.options.maxPages || answer.has_more !== true || typeof following !== 'string' || cursors.has(following)) break;
      cursors.add(following);
      start = following;
    }
    return newestFirst([...found.values()]);
  }

  /**
   * Retrieves one page: its item under the id asked for, or why it is gone. An id that is not a Notion id names no
   * page and answers `removed` with no call.
   */
  private async retrieve(id: string, signal: AbortSignal | undefined, halt?: AbortSignal): Promise<NotionPageItem | SourceGone> {
    const page = await this.page(id, signal, halt);
    return 'reason' in page ? page : { ...page.item, id };
  }

  /** Retrieves one page: its item and Notion's answer, or why it is gone. */
  private async page(id: string, signal: AbortSignal | undefined, halt?: AbortSignal): Promise<{ item: NotionPageItem; answer: Record<string, unknown> } | SourceGone> {
    if (!NOTION_ID.test(id)) return { id, reason: 'removed' };
    const { status, headers, answer } = await this.exchange('retrieve', `/v1/pages/${id}`, undefined, signal, halt);
    if (status === 404) return { id, reason: 'removed' };
    if (status === 403) return { id, reason: 'no_access' };
    if (status < 200 || status > 299) throw apiFault(status, headers, answer, false);
    if (away(answer)) return { id, reason: 'removed' };
    const item = pageItem(answer);
    if (item === null) throw new NotionFault('invalid_response', { status });
    return { item, answer };
  }

  /**
   * Reads a page's blocks, every level, up to `concurrency` children calls in flight; each block's children go into
   * its own node, so the tree is in the page's order whatever order the answers come in. Answers the tree, or the
   * first reason it stopped once the calls in flight have settled; a fault a call in flight answers after a stop that
   * is no fault takes its place.
   */
  private async blocksOf(pageId: string, signal: AbortSignal | undefined): Promise<{ blocks: NotionBlockNode[]; stop: Stop | null }> {
    const blocks: NotionBlockNode[] = [];
    const queue: ChildrenCall[] = [{ id: pageId, level: 1, into: blocks, top: true, written: true, parent: null }];
    const counted: Counted = { blocks: 0, chars: 0, cursors: new Map() };
    const halting = new AbortController();
    let stop: Stop | null = null;
    let active = 0;
    await new Promise<void>((resolve) => {
      const pump = (): void => {
        while (stop === null && active < this.concurrency && queue.length > 0) {
          const next = queue.shift()!;
          active += 1;
          const path = `/v1/blocks/${next.id}/children?page_size=${SEARCH_PAGE_SIZE}${next.cursor === undefined ? '' : `&start_cursor=${encodeURIComponent(next.cursor)}`}`;
          this.exchange('children', path, undefined, signal, halting.signal)
            .then((exchanged) => {
              if (stop?.kind === 'fault') return;
              if (stop !== null) {
                // The read has stopped without a fault (too large, or a block gone): a fault answered by a call
                // still in flight, such as a 429, is still what the read throws, before any retrieve again.
                const { status, headers, answer } = exchanged;
                if (status !== 403 && status !== 404 && (status < 200 || status > 299)) {
                  stop = { kind: 'fault', error: apiFault(status, headers, answer, false) };
                }
                return;
              }
              try {
                stop = this.take(next, exchanged, queue, counted);
              } catch (error) {
                stop = { kind: 'fault', error };
              }
            }, (error: unknown) => {
              const halted = error instanceof NotionFault && error.reason === 'cancelled';
              if (stop === null || (stop.kind !== 'fault' && !halted)) stop = { kind: 'fault', error };
            })
            .finally(() => {
              active -= 1;
              if (stop !== null) halting.abort();
              pump();
            });
        }
        if (active === 0) resolve();
      };
      pump();
    });
    return { blocks, stop };
  }

  /**
   * Takes one children answer into the tree and queues the calls it leads to; answers why the read stops, if it does.
   * Each block the page's text writes adds the fewest characters it can write, so a page past `maxChars` stops as soon
   * as it is known to be, and a listing that answers a cursor it answered before is no answer Notion documents.
   */
  private take(made: ChildrenCall, exchanged: Exchanged, queue: ChildrenCall[], counted: Counted): Stop | null {
    const { status, headers, answer } = exchanged;
    if (status === 404 || status === 403) {
      if (made.top && made.cursor === undefined) return { kind: 'gone', reason: status === 404 ? 'removed' : 'no_access' };
      return { kind: 'vanished' };
    }
    if (status < 200 || status > 299) return { kind: 'fault', error: apiFault(status, headers, answer, false) };
    const invalid: Stop = { kind: 'fault', error: new NotionFault('invalid_response', { status }) };
    if (!Array.isArray(answer.results)) return invalid;
    for (const result of answer.results) {
      if (!isObject(result)) return invalid;
      const block = result as Record<string, unknown>;
      const type = block.type;
      if (typeof type !== 'string') return invalid;
      if (block.in_trash === true) continue;
      counted.blocks += 1;
      if (counted.blocks > this.options.maxBlocks) return { kind: 'too_large' };
      const body = block[type];
      const node: NotionBlockNode = { type, body: isObject(body) ? (body as Record<string, unknown>) : {}, children: [] };
      made.into.push(node);
      const shown = made.written && (made.parent !== 'table' || type === 'table_row');
      if (shown) {
        counted.chars += leastChars(node, made.parent);
        if (counted.chars > this.options.maxChars) return { kind: 'too_large' };
      }
      if (block.has_children !== true || UNREAD.has(type)) continue;
      if (made.level + 1 > this.options.maxDepth) return { kind: 'too_large' };
      if (typeof block.id !== 'string' || !NOTION_ID.test(block.id)) return invalid;
      queue.push({ id: block.id, level: made.level + 1, into: node.children as NotionBlockNode[], top: false, written: shown && childrenWritten(type), parent: type });
    }
    if (answer.has_more === true) {
      const following = answer.next_cursor;
      if (typeof following !== 'string' || following.length === 0) return invalid;
      const seen = counted.cursors.get(made.id) ?? new Set<string>();
      if (seen.has(following)) return invalid;
      seen.add(following);
      counted.cursors.set(made.id, seen);
      queue.push({ ...made, cursor: following });
    }
    return null;
  }

  /**
   * Makes one call: through the host's budget when one is given, else inside the connector's window. The call stops
   * when the connector's signal, the operation's signal or the budget's signal aborts. Once `halt` has aborted (another
   * call of the operation failed or stopped it), a call still waiting for its place or for the budget is never sent and
   * throws `cancelled`; a call already sent is not stopped by it. A call the host's budget holds stops being waited
   * on, with `cancelled`, once a signal or `halt` aborts.
   */
  private async exchange(method: NotionReadMethod, path: string, body: string | undefined, signal: AbortSignal | undefined, halt?: AbortSignal): Promise<Exchanged> {
    const callers = [this.options.signal, signal].filter((caller): caller is AbortSignal => caller !== undefined);
    const attempt = async (given?: AbortSignal): Promise<Exchanged> => {
      if (halt?.aborted === true) throw new NotionFault('cancelled');
      const signals = given === undefined ? callers : [...callers, given];
      const init: RequestInit = body === undefined
        ? { method: 'GET', headers: this.headers }
        : { method: 'POST', headers: { ...this.headers, 'content-type': 'application/json' }, body };
      const answer = await call(this.options.fetchImpl ?? fetch, `${this.origin}${path}`, init, {
        signal: signals.length === 0 ? undefined : AbortSignal.any(signals),
        timeoutMs: this.timeoutMs,
        maxBytes: ANSWER_BYTES,
      });
      return { status: answer.status, headers: answer.headers, answer: jsonObject(answer.text) };
    };
    const waiters = halt === undefined ? callers : [...callers, halt];
    if (this.options.send !== undefined) return abortable(this.options.send(method, attempt), waiters);
    const leave = await this.window.enter(waiters.length === 0 ? undefined : AbortSignal.any(waiters));
    try {
      return await attempt();
    } finally {
      leave();
    }
  }
}
