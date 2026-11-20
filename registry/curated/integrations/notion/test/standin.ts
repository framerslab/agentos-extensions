/**
 * @fileoverview A stand-in for Notion's read API on a loopback port: search paged by `start_cursor`, a page's retrieve
 * and a block's children paged, answering for the pages a test shares. Its search can lag its pages as Notion's index
 * does (still listing an unshared page at its old version, or omitting a shared one), and a test can make it answer a
 * 403, a 404, a 429 with `Retry-After`, a page in the trash, or every answer a set number of milliseconds late, while it
 * counts the calls it holds at once. The same answers are offered as an in-memory fetch for a test on fake timers.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A parent as the library answers it. */
export interface StandInParent {
  readonly type: 'workspace' | 'page' | 'database' | 'block';
  readonly id: string | null;
}

/** A page the stand-in can share: its id, title, last edit, parent and link. */
export interface StandInPage {
  readonly id: string;
  readonly title: string;
  readonly lastEdited: string;
  readonly parent: StandInParent;
  readonly url: string;
}

/** A block the stand-in answers among a page's children. */
export interface StandInBlock {
  readonly id: string;
  readonly type: string;
  readonly body: Record<string, unknown>;
  readonly children?: readonly StandInBlock[];
}

/** One answer: its status, headers and JSON body. */
interface Answer {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}

/** A request as the stand-in records it: the search body, or the id a retrieve or a children call named. */
export type Seen = Record<string, unknown>;

/** The routes a test reads what was sent to. */
export type Route = 'POST /v1/search' | 'GET /v1/pages/:id' | 'GET /v1/blocks/:id/children';

const BASE_TIME = Date.UTC(2026, 9, 1, 8, 0, 0);

/** A Notion id from a number: the hyphenated form of 32 hex digits, the first a prefix that keeps kinds apart. */
export function notionId(n: number, prefix = '0'): string {
  const hex = `${prefix}${n.toString(16).padStart(31, '0')}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The parents the fixtures cycle through, one of each kind. */
const PARENTS: readonly StandInParent[] = [
  { type: 'workspace', id: null },
  { type: 'page', id: notionId(1, 'a') },
  { type: 'database', id: notionId(2, 'd') },
  { type: 'block', id: notionId(3, 'b') },
];

/** One page, its last edit `n` minutes after the fixtures' first. */
export function page(n: number, title = `Page ${n}`): StandInPage {
  const id = notionId(n);
  return { id, title, lastEdited: new Date(BASE_TIME + n * 60_000).toISOString(), parent: PARENTS[n % PARENTS.length]!, url: `https://app.notion.com/p/${id.replace(/-/g, '')}` };
}

/** `count` pages with distinct last edits, oldest first. */
export function pages(count: number, from = 1): StandInPage[] {
  return Array.from({ length: count }, (_, i) => page(from + i));
}

/** The same page edited `minutes` later. */
export function edited(p: StandInPage, minutes = 1_000): StandInPage {
  return { ...p, lastEdited: new Date(Date.parse(p.lastEdited) + minutes * 60_000).toISOString() };
}

/** Pages newest edited first. */
export function newestFirst(list: readonly StandInPage[]): StandInPage[] {
  return [...list].sort((x, y) => (x.lastEdited < y.lastEdited ? 1 : x.lastEdited > y.lastEdited ? -1 : 0));
}

/** A parent in Notion's own form, as an answer of the 2026-03-11 version names it. */
function notionParent(parent: StandInParent): Record<string, unknown> {
  switch (parent.type) {
    case 'workspace': return { type: 'workspace', workspace: true };
    case 'page': return { type: 'page_id', page_id: parent.id };
    case 'database': return { type: 'data_source_id', data_source_id: notionId(9, 'e'), database_id: parent.id };
    case 'block': return { type: 'block_id', block_id: parent.id };
  }
}

/** Notion's error answer in its common shape. */
function failure(status: number, code: string, additional?: Record<string, unknown>): Record<string, unknown> {
  return { object: 'error', status, code, message: 'stand-in message', ...(additional === undefined ? {} : { additional_data: additional }) };
}

/** Waits `ms` milliseconds, at once for zero. */
function wait(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

/** The stand-in: what is shared, how search lags, and what each call answers. */
export class NotionStandIn {
  private server: Server | null = null;
  private origin = '';
  private shared = new Map<string, StandInPage>();
  private trashed = new Set<string>();
  private forbidden = new Set<string>();
  private omitted = new Set<string>();
  private stale = new Map<string, StandInPage>();
  private blocks = new Map<string, readonly StandInBlock[]>();
  private noReadContent = false;
  private limitNext: { retryAfter: number } | null = null;
  private delayMs = 0;
  private inFlight = 0;
  private most = 0;
  private count = 0;
  private log: Array<{ route: Route; seen: Seen }> = [];

  /** Starts the server on a loopback port and answers its origin. */
  async start(): Promise<string> {
    this.server = createServer((request, response) => void this.serve(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.origin;
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server === null) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The stand-in's origin, once started. */
  get apiBase(): string {
    return this.origin;
  }

  /** Forgets every page, scenario and count. */
  reset(): void {
    this.shared = new Map();
    this.trashed = new Set();
    this.forbidden = new Set();
    this.omitted = new Set();
    this.stale = new Map();
    this.blocks = new Map();
    this.noReadContent = false;
    this.limitNext = null;
    this.delayMs = 0;
    this.inFlight = 0;
    this.most = 0;
    this.count = 0;
    this.log = [];
  }

  /** Shares pages, or a page's newer version under the same id. */
  share(list: readonly StandInPage[]): void {
    for (const p of list) this.shared.set(p.id, p);
  }

  /** Unshares a page: its retrieve answers 404 and search leaves it out, unless search lists it stale. */
  unshare(p: StandInPage): void {
    this.shared.delete(p.id);
  }

  /** Moves a page to the trash: its retrieve answers it with `in_trash`, and search leaves it out. */
  trash(p: StandInPage): void {
    this.trashed.add(p.id);
  }

  /** Makes a page's retrieve answer 403. */
  forbid(p: StandInPage): void {
    this.forbidden.add(p.id);
  }

  /** Makes search keep listing a page at its version now, whatever happens to it later. */
  searchListsStale(p: StandInPage): void {
    this.stale.set(p.id, this.shared.get(p.id) ?? p);
  }

  /** Makes search leave a page out while it stays shared. */
  searchOmits(p: StandInPage): void {
    this.omitted.add(p.id);
  }

  /** Gives a page or a block its children. */
  children(id: string, list: readonly StandInBlock[]): void {
    this.blocks.set(id, list);
  }

  /** Answers every call 403, as for a grant without Read content. */
  withoutReadContent(): void {
    this.noReadContent = true;
  }

  /** Answers the next call 429 with `Retry-After`. */
  rateLimitNext(limit: { retryAfter: number }): void {
    this.limitNext = limit;
  }

  /** Delays every answer `ms` milliseconds after its call. */
  delayEach(ms: number): void {
    this.delayMs = ms;
  }

  /** The most calls the stand-in has held at once. */
  mostInFlight(): number {
    return this.most;
  }

  /** How many calls the stand-in has answered or is answering. */
  calls(): number {
    return this.count;
  }

  /** What was sent to a route, in order. */
  seen(route: Route): Seen[] {
    return this.log.filter((entry) => entry.route === route).map((entry) => entry.seen);
  }

  /** The newest edited page shared. */
  get newest(): StandInPage {
    return newestFirst([...this.shared.values()])[0]!;
  }

  /** The same answers as an in-memory fetch, for a test on fake timers. */
  readonly fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === 'string' ? init.body : '';
    const answer = await this.answer(init?.method ?? 'GET', url, headers, text);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json', ...answer.headers } });
  }) as typeof fetch;

  private async serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(name, value);
    const answer = await this.answer(request.method ?? 'GET', new URL(request.url ?? '/', this.origin), headers, Buffer.concat(chunks).toString('utf8'));
    response.writeHead(answer.status, { 'content-type': 'application/json', ...answer.headers });
    response.end(JSON.stringify(answer.body));
  }

  private async answer(method: string, url: URL, headers: Headers, text: string): Promise<Answer> {
    this.count += 1;
    this.inFlight += 1;
    this.most = Math.max(this.most, this.inFlight);
    try {
      const answer = this.route(method, url, headers, text);
      await wait(this.delayMs);
      return answer;
    } finally {
      this.inFlight -= 1;
    }
  }

  private route(method: string, url: URL, headers: Headers, text: string): Answer {
    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(url.pathname);
    const childrenMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(url.pathname);
    if (method === 'POST' && url.pathname === '/v1/search') {
      const body = JSON.parse(text === '' ? '{}' : text) as Record<string, unknown>;
      this.log.push({ route: 'POST /v1/search', seen: body });
      return this.guarded(headers, () => this.search(body));
    }
    if (method === 'GET' && pageMatch !== null) {
      const id = decodeURIComponent(pageMatch[1]!);
      this.log.push({ route: 'GET /v1/pages/:id', seen: { id } });
      return this.guarded(headers, () => this.retrieve(id));
    }
    if (method === 'GET' && childrenMatch !== null) {
      const id = decodeURIComponent(childrenMatch[1]!);
      const cursor = url.searchParams.get('start_cursor');
      this.log.push({ route: 'GET /v1/blocks/:id/children', seen: { id, start_cursor: cursor, page_size: url.searchParams.get('page_size') } });
      return this.guarded(headers, () => this.childrenOf(id, cursor, Number(url.searchParams.get('page_size') ?? '100')));
    }
    return { status: 400, body: failure(400, 'invalid_request_url') };
  }

  /** The checks every call passes first: a bearer token and a version, a grant with Read content, the rate limit. */
  private guarded(headers: Headers, answer: () => Answer): Answer {
    if (!/^Bearer \S+$/.test(headers.get('authorization') ?? '')) return { status: 401, body: failure(401, 'unauthorized') };
    if ((headers.get('notion-version') ?? '') === '') return { status: 400, body: failure(400, 'missing_version') };
    if (this.limitNext !== null) {
      const seconds = this.limitNext.retryAfter;
      this.limitNext = null;
      return { status: 429, headers: { 'retry-after': String(seconds) }, body: failure(429, 'rate_limited', { retry_after: String(seconds), rate_limit_reason: 'public_api_request_rate_limit' }) };
    }
    if (this.noReadContent) return { status: 403, body: failure(403, 'restricted_resource') };
    return answer();
  }

  private pageObject(p: StandInPage): Record<string, unknown> {
    return {
      object: 'page', id: p.id, created_time: '2026-09-01T08:00:00.000Z', last_edited_time: p.lastEdited,
      in_trash: this.trashed.has(p.id), is_archived: false, is_locked: false, url: p.url, public_url: null,
      parent: notionParent(p.parent),
      properties: { title: { id: 'title', type: 'title', title: p.title === '' ? [] : [{ type: 'text', text: { content: p.title, link: null }, plain_text: p.title, href: null }] } },
      icon: null, cover: null, created_by: { object: 'user', id: notionId(7, 'f') }, last_edited_by: { object: 'user', id: notionId(7, 'f') },
    };
  }

  private search(body: Record<string, unknown>): Answer {
    const listed = new Map<string, StandInPage>();
    for (const p of this.shared.values()) if (!this.omitted.has(p.id) && !this.trashed.has(p.id)) listed.set(p.id, p);
    for (const [id, p] of this.stale) listed.set(id, p);
    const ordered = newestFirst([...listed.values()]);
    const start = typeof body.start_cursor === 'string' ? parseInt(body.start_cursor.slice(-12), 16) : 0;
    const size = typeof body.page_size === 'number' ? body.page_size : 100;
    const slice = ordered.slice(start, start + size);
    const next = start + size < ordered.length ? notionId(start + size, 'c') : null;
    return { status: 200, body: { object: 'list', type: 'page_or_data_source', results: slice.map((p) => this.pageObject(p)), next_cursor: next, has_more: next !== null } };
  }

  private retrieve(id: string): Answer {
    if (this.forbidden.has(id)) return { status: 403, body: failure(403, 'restricted_resource') };
    const p = this.shared.get(id);
    if (p === undefined) return { status: 404, body: failure(404, 'object_not_found') };
    return { status: 200, body: this.pageObject(p) };
  }

  private childrenOf(id: string, cursor: string | null, size: number): Answer {
    const known = this.blocks.get(id) ?? (this.shared.has(id) ? [] : undefined);
    if (known === undefined) return { status: 404, body: failure(404, 'object_not_found') };
    const start = cursor === null ? 0 : parseInt(cursor.slice(-12), 16);
    const slice = known.slice(start, start + size);
    const next = start + size < known.length ? notionId(start + size, 'c') : null;
    const results = slice.map((block) => ({ object: 'block', id: block.id, type: block.type, has_children: (block.children?.length ?? 0) > 0, in_trash: false, [block.type]: block.body }));
    for (const block of slice) if (block.children !== undefined) this.blocks.set(block.id, block.children);
    return { status: 200, body: { object: 'list', type: 'block', block: {}, results, next_cursor: next, has_more: next !== null } };
  }
}
