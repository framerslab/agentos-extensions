// @vitest-environment jsdom
/**
 * Support requests as a product runs them, end to end: the built entries reached through the package's exports map
 * (`.`, `./tickets` and `./react`), the product's own routes over `operations.tickets` (the person's under
 * `/api/v1/support` and staff's under `/api/admin/support`, each signed in as one account, each refusal answered as
 * `{ error }` with its status, the shape the hooks read), and the hooks driving those routes in a page. CI builds every
 * pack before it runs the tests, so `dist` holds this commit's build. The database is SQLite through sql.js in memory:
 * the hooks need jsdom, and the PostgreSQL adapter does not open there.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  Operations,
  OpsLimits,
  OpsMessage,
  OpsOpenInput,
  OpsPerson,
  OpsRefusal,
  OpsStaff,
  OpsStaffFilter,
  OpsStaffTicket,
  OpsStream,
  OpsStreamEvent,
  OpsTicket,
  OpsTicketWrite,
  Tickets,
} from '../src/contract.js';
import type { JsonAnswer, OpsClient } from '../src/react/index.js';
import { fakeClock, type FakeClock } from './helpers/clock.js';
import { fixtureOptions, type Recorder } from './helpers/host.js';
import { jpegWithOrientationAndGps, loadSharp, oversized, smallWebp, tinyGif, tinyPdf } from './helpers/pictures.js';
import { OTHER, PERSON, STAFF, isRefusal } from './helpers/tickets.js';

/** What the root entry exports, typed from its source. */
type RootEntry = typeof import('../src/index.js');
/** What `./tickets` exports, typed from its source. */
type TicketsEntry = typeof import('../src/tickets/index.js');
/** What `./react` exports, typed from its source. */
type ReactEntry = typeof import('../src/react/index.js');

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolve(here, '..');
const packageJson = JSON.parse(readFileSync(join(packRoot, 'package.json'), 'utf8')) as {
  readonly exports: Readonly<Record<string, { readonly import: string; readonly types: string } | string | undefined>>;
};

/** The built file the exports map gives `subpath`: the file a consumer's import of it loads. */
function builtFile(subpath: string): string {
  const target = packageJson.exports[subpath];
  if (target === undefined || typeof target === 'string') throw new Error(`package.json exports no ${subpath} entry`);
  return join(packRoot, target.import);
}

/** Imports the built entry `subpath`. */
async function entry<T>(subpath: string): Promise<T> {
  const file = builtFile(subpath);
  if (!existsSync(file)) throw new Error(`${file} is missing: build the package first, as CI builds every pack before it runs the tests`);
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as T;
}

let rootEntry!: RootEntry;
let ticketsEntry!: TicketsEntry;
let reactEntry!: ReactEntry;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

/** Renders `use` inside a component and answers its latest result. */
function renderHook<T>(use: () => T): { readonly current: () => T; unmount(): void } {
  let latest!: T;
  function Probe(): ReactNode {
    latest = use();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe />));
  return {
    current: () => latest,
    unmount: () => act(() => root.unmount()),
  };
}

/** Waits until `check` answers true, flushing React between looks; `what` names the wait when it runs out. */
async function waitFor(check: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waited ${timeoutMs} ms for ${what}`);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
  }
}

/** Lets `ms` pass, flushing React. */
async function pause(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, ms));
  });
}

/** The page goes behind another tab: the document says `hidden`. */
function hidePage(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
}

/** The page shows again: the document's own `visibilityState` answers. */
function showPage(): void {
  delete (document as { visibilityState?: unknown }).visibilityState;
}

const PERSON_BASE = '/api/v1/support';
const STAFF_BASE = '/api/admin/support';

/** One call a page made to the product's routes, with the status the route answered once it had answered. */
interface Call {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
  status: number | null;
}

/** A JSON answer with `status`. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A refusal as the hooks read one: `{ error }` with the refusal's status, and `Retry-After` when it carries one. */
function refusedAnswer(refusal: OpsRefusal): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (refusal.retryAfter !== undefined) headers['Retry-After'] = String(refusal.retryAfter);
  return new Response(JSON.stringify({ error: refusal.refused }), { status: refusal.status, headers });
}

/** The JSON body a call carried, or null. */
function jsonOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : null;
}

/** The bytes a call carried, or none. */
function bytesOf(init: RequestInit | undefined): Uint8Array {
  return init?.body instanceof Uint8Array ? init.body : new Uint8Array(0);
}

/** A `fetch` over `routes` that records each call into `calls` with the status it was answered. */
function recorded(calls: Call[], routes: (call: Call, url: URL, init: RequestInit | undefined, headers: Headers) => Promise<Response>): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input), 'https://product.invalid');
    const headers = new Headers(init?.headers);
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      search: url.search,
      headers: Object.fromEntries(headers.entries()),
      body: typeof init?.body === 'string' ? init.body : null,
      status: null,
    };
    calls.push(call);
    const response = await routes(call, url, init, headers);
    call.status = response.status;
    return response;
  };
}

/** The stream route: the package's event stream as the answer's body, ended when the page leaves. */
async function streamAnswer(tickets: Tickets, actor: OpsPerson | OpsStaff, id: string, init: RequestInit | undefined, headers: Headers): Promise<Response> {
  const opened = await tickets.stream(actor, id, headers.get('Last-Event-ID') ?? undefined);
  if (isRefusal(opened)) return refusedAnswer(opened);
  const signal = init?.signal ?? null;
  if (signal !== null) {
    if (signal.aborted) opened.close();
    else signal.addEventListener('abort', () => opened.close(), { once: true });
  }
  return new Response(opened.body, { status: 200, headers: opened.headers });
}

/** The picture route: the stored bytes with the headers `./tickets` exports for them. */
async function pictureAnswer(tickets: Tickets, actor: OpsPerson | OpsStaff, id: string): Promise<Response> {
  const picture = await tickets.picture(actor, id);
  if (isRefusal(picture)) return refusedAnswer(picture);
  return new Response(picture.bytes, { status: 200, headers: { ...ticketsEntry.PICTURE_HEADERS, 'Content-Type': picture.mediaType } });
}

/** The person's routes as a product writes them: signed in as `person`, each one call of `tickets` after the sign-in. */
function personRoutes(tickets: Tickets, person: OpsPerson, calls: Call[]): typeof fetch {
  return recorded(calls, async (call, url, init, headers) => {
    if (!url.pathname.startsWith(`${PERSON_BASE}/`)) return json({ error: 'not_found' }, 404);
    const [head, id, action, extra] = url.pathname.slice(PERSON_BASE.length + 1).split('/').map(decodeURIComponent);
    if (extra !== undefined) return json({ error: 'not_found' }, 404);
    if (head === 'requests' && id === undefined) {
      if (call.method === 'GET') return json(await tickets.list(person, url.searchParams.get('cursor') ?? undefined));
      if (call.method === 'POST') {
        const opened = await tickets.open(person, jsonOf(init) as OpsOpenInput);
        return isRefusal(opened) ? refusedAnswer(opened) : json(opened, 201);
      }
    }
    if (head === 'requests' && id !== undefined) {
      if (action === undefined && call.method === 'GET') {
        const view = await tickets.get(person, id);
        return view === null ? json({ error: 'not_found' }, 404) : json(view);
      }
      if (action === 'messages' && call.method === 'POST') {
        const written = await tickets.write(person, id, jsonOf(init) as OpsTicketWrite);
        return isRefusal(written) ? refusedAnswer(written) : json(written, 201);
      }
      if (action === 'read' && call.method === 'POST') {
        const read = await tickets.read(person, id, (jsonOf(init) as { messageId?: string } | null)?.messageId);
        return isRefusal(read) ? refusedAnswer(read) : new Response(null, { status: 204 });
      }
      if (action === 'stream' && call.method === 'GET') return streamAnswer(tickets, person, id, init, headers);
    }
    if (head === 'pictures' && id === undefined && call.method === 'POST') {
      const uploaded = await tickets.upload(person, bytesOf(init), headers.get('Content-Type') ?? '');
      return isRefusal(uploaded) ? refusedAnswer(uploaded) : json(uploaded, 201);
    }
    if (head === 'pictures' && id !== undefined && action === undefined && call.method === 'GET') return pictureAnswer(tickets, person, id);
    return json({ error: 'not_found' }, 404);
  });
}

/** Staff's filter from the list's query, as a product's route reads it: the words as given, `openedDays` as a whole number. */
function staffFilterOf(params: URLSearchParams): OpsStaffFilter {
  const filter: Record<string, string | number> = {};
  for (const key of ['state', 'category', 'claim', 'priority', 'words', 'cursor']) {
    const value = params.get(key);
    if (value !== null) filter[key] = value;
  }
  const days = params.get('openedDays');
  if (days !== null) filter.openedDays = Number(days);
  return filter as OpsStaffFilter;
}

/** Staff's routes as a product's admin writes them: signed in as `staff`, each one call of `tickets` after the product's own permission check. */
function staffRoutes(tickets: Tickets, staff: OpsStaff, calls: Call[]): typeof fetch {
  return recorded(calls, async (call, url, init, headers) => {
    if (url.pathname === STAFF_BASE && call.method === 'GET') {
      try {
        return json(await tickets.staffList(staff, staffFilterOf(url.searchParams)));
      } catch (error) {
        // The list throws a TypeError for a filter outside its words and bounds, which the route answers as a refusal.
        if (error instanceof TypeError) return json({ error: 'refused' }, 400);
        throw error;
      }
    }
    if (!url.pathname.startsWith(`${STAFF_BASE}/`)) return json({ error: 'not_found' }, 404);
    const [head, action, extra] = url.pathname.slice(STAFF_BASE.length + 1).split('/').map(decodeURIComponent);
    if (head === undefined || head === '' || extra !== undefined) return json({ error: 'not_found' }, 404);
    if (head === 'pictures') {
      if (action === undefined && call.method === 'POST') {
        const uploaded = await tickets.upload(staff, bytesOf(init), headers.get('Content-Type') ?? '');
        return isRefusal(uploaded) ? refusedAnswer(uploaded) : json(uploaded, 201);
      }
      if (action !== undefined && call.method === 'GET') return pictureAnswer(tickets, staff, action);
      return json({ error: 'not_found' }, 404);
    }
    if (head === 'to' && action !== undefined && call.method === 'POST') {
      const opened = await tickets.writeTo(staff, action, jsonOf(init) as OpsOpenInput);
      return isRefusal(opened) ? refusedAnswer(opened) : json(opened, 201);
    }
    if (action === undefined && call.method === 'GET') {
      const view = await tickets.staffGet(staff, head);
      return view === null ? json({ error: 'not_found' }, 404) : json(view);
    }
    if (action === 'replies' && call.method === 'POST') {
      const replied = await tickets.reply(staff, head, jsonOf(init) as OpsTicketWrite);
      return isRefusal(replied) ? refusedAnswer(replied) : json(replied, 201);
    }
    if (action === 'claim' && call.method === 'POST') {
      const claimed = await tickets.claim(staff, head, (jsonOf(init) as { on: boolean }).on);
      return isRefusal(claimed) ? refusedAnswer(claimed) : json(claimed);
    }
    return json({ error: 'not_found' }, 404);
  });
}

/** A product over the built root entry: its database, its options, its routes, and a client for each signed-in account. */
interface Product {
  readonly db: StorageAdapter;
  readonly operations: Operations;
  readonly tickets: Tickets;
  readonly recorder: Recorder;
  readonly clock: FakeClock;
  /** The person's page, signed in as the person. */
  readonly person: OpsClient;
  /** Another person's page. */
  readonly other: OpsClient;
  /** The admin's pages, signed in as a staff member. */
  readonly staff: OpsClient;
  readonly personCalls: Call[];
  readonly staffCalls: Call[];
}

let current: Product | null = null;

/** Migrates a fresh database and builds the product over `createOperations`, with `limits` laid over the defaults. */
async function product(limits?: Partial<OpsLimits>): Promise<Product> {
  const db = createSqlJsAdapter();
  await db.open();
  await rootEntry.migrateOperations(db, { prefix: 'ops' });
  const clock = fakeClock();
  const fixture = fixtureOptions(db, limits === undefined ? {} : { limits }, clock);
  // The staff recipients of a new request are the staff member's account.
  const options = { ...fixture.options, tickets: { ...fixture.options.tickets!, staffRecipients: async () => [STAFF.accountId] } };
  const operations = rootEntry.createOperations(options);
  const tickets = operations.tickets;
  if (tickets === null) throw new Error('operations.tickets is null with the tickets module given');
  const personCalls: Call[] = [];
  const staffCalls: Call[] = [];
  current = {
    db,
    operations,
    tickets,
    recorder: fixture.recorder,
    clock,
    person: { fetch: personRoutes(tickets, PERSON, personCalls), base: PERSON_BASE },
    other: { fetch: personRoutes(tickets, OTHER, []), base: PERSON_BASE },
    staff: { fetch: staffRoutes(tickets, STAFF, staffCalls), base: STAFF_BASE },
    personCalls,
    staffCalls,
  };
  return current;
}

/** Posts `body` as JSON through `client`, as a page's form does, read as the hooks read an answer. */
function post<T>(client: OpsClient, path: string, body: unknown): Promise<JsonAnswer<T>> {
  return reactEntry.readJson<T>(client, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

/** Uploads `bytes` as `type` through the client's picture route. */
function upload(client: OpsClient, bytes: Uint8Array, type: string): Promise<JsonAnswer<{ readonly id: string }>> {
  return reactEntry.readJson<{ readonly id: string }>(client, `${client.base}/pictures`, { method: 'POST', headers: { 'Content-Type': type }, body: bytes });
}

/** The data of an answer; fails the test with the refusal's word otherwise. */
function dataOf<T>(answer: JsonAnswer<T>): T {
  if (!('data' in answer)) throw new Error(`refused: ${answer.error} (${answer.status})`);
  return answer.data;
}

/** Five minutes and a second: past the wait before a reply nobody read is mailed. */
const MAIL_WAIT_PASSED_MS = 5 * 60_000 + 1_000;

afterEach(async () => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  showPage();
  if (current !== null) {
    const ending = current;
    current = null;
    await ending.operations.stop();
    await ending.db.close();
  }
});

describe('support requests through the built entries, the product routes and the hooks', () => {
  beforeAll(async () => {
    rootEntry = await entry<RootEntry>('.');
    ticketsEntry = await entry<TicketsEntry>('./tickets');
    reactEntry = await entry<ReactEntry>('./react');
  });

  it('resolves the root, ./tickets and ./react through the exports map to built files that export what the routes and the pages call', () => {
    expect(builtFile('.')).toMatch(/[/\\]dist[/\\]index\.js$/);
    expect(builtFile('./tickets')).toMatch(/[/\\]dist[/\\]tickets[/\\]index\.js$/);
    expect(builtFile('./react')).toMatch(/[/\\]dist[/\\]react[/\\]index\.js$/);
    expect([typeof rootEntry.createOperations, typeof rootEntry.migrateOperations]).toEqual(['function', 'function']);
    expect(ticketsEntry.PICTURE_HEADERS).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'",
      'Cache-Control': 'no-store',
    });
    for (const name of ['useRequests', 'useRequest', 'useStream', 'useComposer', 'useStaffList', 'useStaffRequest', 'Markdown', 'readJson', 'joinPath', 'queryOf'] as const) {
      expect(typeof reactEntry[name], name).toBe('function');
    }
    expect(reactEntry.STREAM_POLL_MS).toBe(20_000);
  });

  it('a request the person opens reaches staff by mail and by the bell without its words, and staff find it under each filter of the list and read it', async () => {
    const shop = await product();
    const a = dataOf(await post<OpsTicket>(shop.person, `${PERSON_BASE}/requests`, { category: 'billing', subject: 'Charged twice', body: 'My card was charged twice for the March invoice.' }));
    expect(a).toMatchObject({ category: 'billing', subject: 'Charged twice', derivedState: 'waiting_team', source: 'person', shareIdentity: false, unread: false });
    expect(a.anonymousId).toMatch(/^P-[0-9A-HJKMNP-TV-Z]{6}$/);
    // Staff are told at once: the bell names the request to the staff recipients before the route answers, and the team alert, which the
    // answer need not wait for, carries its category and id alone.
    expect(shop.recorder.notices).toEqual([{ kind: 'supportWaiting', accountIds: [STAFF.accountId], ticketId: a.id, dedupeKey: expect.stringMatching(/^supportWaiting:/) }]);
    await waitFor(() => shop.recorder.mails.length > 0, 'the team alert');
    expect(shop.recorder.mails).toEqual([
      { kind: 'teamAlert', to: 'team@example.invalid', key: 'requests', lines: [{ category: 'billing', request: a.id }], idempotencyKey: expect.stringMatching(/^requests:[0-9a-f]+$/) },
    ]);
    const told = JSON.stringify([shop.recorder.mails, shop.recorder.notices]);
    for (const kept of ['Charged', 'charged', 'March', a.anonymousId, PERSON.accountId]) expect(told).not.toContain(kept);

    shop.clock.advance(1_000);
    const b = dataOf(await post<OpsTicket>(shop.other, `${PERSON_BASE}/requests`, { category: 'bug', subject: 'Export fails', body: 'The zip stops at 40 percent.' }));
    // Past the person's 30-second cooldown, a second billing question, which a staff member claims.
    shop.clock.advance(31_000);
    const c = dataOf(await post<OpsTicket>(shop.person, `${PERSON_BASE}/requests`, { category: 'billing', subject: 'Annual plan', body: 'Was I charged for the annual plan as well?' }));
    expect(dataOf(await post<OpsStaffTicket>(shop.staff, `${STAFF_BASE}/${c.id}/claim`, { on: true })).claimedBy).toBe(STAFF.accountId);

    // The whole list as the dashboard opens it: the longest waiting on the team first, with the counts and the week's line.
    const all = renderHook(() => reactEntry.useStaffList(shop.staff));
    await waitFor(() => all.current().data !== null, 'the staff list');
    const page = all.current().data!;
    expect(page.tickets.map((ticket) => ticket.id)).toEqual([a.id, b.id, c.id]);
    expect(page.counts).toEqual({ waitingTeam: 3, waitingPerson: 0, urgentOpen: 0, resolved7d: 0 });
    expect(page.openedByDay).toEqual([0, 0, 0, 0, 0, 0, 3]);
    expect(page.cursor).toBeNull();
    // Nothing on the page names the people behind the requests: the anonymous id and the plan stand in for them.
    expect(page.tickets.map((ticket) => [ticket.anonymousId, ticket.plan, ticket.identity, ticket.identityState])).toEqual([
      [a.anonymousId, 'free', null, 'hidden'],
      [b.anonymousId, 'plus', null, 'hidden'],
      [c.anonymousId, 'free', null, 'hidden'],
    ]);
    for (const accountId of [PERSON.accountId, OTHER.accountId]) expect(JSON.stringify(page)).not.toContain(accountId);

    // Each filter as the dashboard sets it: the words matched in any case against subjects and bodies, the claim, the days.
    const billing = renderHook(() => reactEntry.useStaffList(shop.staff, { state: 'waiting_team', category: 'billing', claim: 'nobody', words: 'CHARGED' }));
    const mine = renderHook(() => reactEntry.useStaffList(shop.staff, { claim: 'mine' }));
    const recent = renderHook(() => reactEntry.useStaffList(shop.staff, { openedDays: 1, words: 'zip' }));
    await waitFor(() => billing.current().data !== null && mine.current().data !== null && recent.current().data !== null, 'the filtered lists');
    expect(billing.current().data!.tickets.map((ticket) => ticket.id)).toEqual([a.id]);
    expect(mine.current().data!.tickets.map((ticket) => ticket.id)).toEqual([c.id]);
    expect(recent.current().data!.tickets.map((ticket) => ticket.id)).toEqual([b.id]);
    // Each filter reached the route as the list's query, with no slash between the base and the query.
    expect(shop.staffCalls.filter((call) => call.path === STAFF_BASE).map((call) => [call.method, call.search, call.status])).toEqual([
      ['GET', '', 200],
      ['GET', '?state=waiting_team&category=billing&claim=nobody&words=CHARGED', 200],
      ['GET', '?claim=mine', 200],
      ['GET', '?openedDays=1&words=zip', 200],
    ]);

    // The person's message is unread by staff until a staff member opens the request.
    expect(page.tickets.find((ticket) => ticket.id === a.id)!.unread).toBe(true);
    const thread = renderHook(() => reactEntry.useStaffRequest(shop.staff, a.id));
    await waitFor(() => thread.current().data !== null, 'the staff thread');
    expect(thread.current().data!.ticket).toMatchObject({ id: a.id, anonymousId: a.anonymousId, plan: 'free', identity: null, identityState: 'hidden' });
    expect(thread.current().data!.messages.map((message) => [message.sender, message.body])).toEqual([['person', 'My card was charged twice for the March invoice.']]);
    expect(JSON.stringify(thread.current().data)).not.toContain(PERSON.accountId);
    await act(async () => {
      await all.current().refresh();
    });
    const reread = all.current().data!.tickets;
    expect(reread.find((ticket) => ticket.id === a.id)!.unread).toBe(false);
    expect(reread.find((ticket) => ticket.id === b.id)!.unread).toBe(true);
  });

  it('a staff reply reaches the open page over the stream and is read there, so no mail goes; a reply nobody saw is mailed once without a word of the thread, and the next inside the gap is not', async () => {
    const shop = await product();
    const a = dataOf(await post<OpsTicket>(shop.person, `${PERSON_BASE}/requests`, { category: 'billing', subject: 'Charged twice', body: 'My card was charged twice.' }));
    const events: OpsStreamEvent[] = [];
    const page = renderHook(() => {
      const request = reactEntry.useRequest(shop.person, a.id);
      const stream = reactEntry.useStream(shop.person, a.id, { onEvent: (event) => events.push(event), reconnectMs: 50 });
      return { request, stream };
    });
    await waitFor(() => page.current().request.data !== null && events.some((event) => event.event === 'state'), 'the thread and the opening state');
    expect(page.current().stream.mode).toBe('stream');
    const first = page.current().request.data!.messages[0]!;
    // The opening state carries the newest message's id, the cursor a reconnect resumes from.
    expect(events[0]).toEqual({ id: first.id, event: 'state', data: { state: 'waiting_team', claimed: false, priority: 'normal' } });

    shop.clock.advance(60_000);
    const reply = dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${a.id}/replies`, { body: 'Refunded; it shows within five days.' }));
    await waitFor(() => events.some((event) => event.event === 'message' && event.id === reply.id), 'the reply over the stream');
    expect(events.find((event) => event.event === 'message')!.data).toMatchObject({ id: reply.id, ticketId: a.id, sender: 'staff', body: 'Refunded; it shows within five days.' });
    // The page acknowledged the message it showed, by its id, and the route handed the id to read.
    const readPath = `${PERSON_BASE}/requests/${a.id}/read`;
    await waitFor(() => shop.personCalls.some((call) => call.path === readPath && call.status === 204), 'the acknowledgment');
    expect(shop.personCalls.filter((call) => call.path === readPath).map((call) => [call.method, call.body, call.status])).toEqual([['POST', JSON.stringify({ messageId: reply.id }), 204]]);
    await waitFor(() => events.some((event) => event.event === 'state' && (event.data as { state?: string }).state === 'waiting_person'), 'the state after the reply');
    expect(shop.recorder.notices.filter((notice) => notice.kind === 'supportReplied')).toEqual([
      { kind: 'supportReplied', accountIds: [PERSON.accountId], ticketId: a.id, dedupeKey: `supportReplied:${reply.id}` },
    ]);

    // Five minutes on, the mail run finds the reply read and sends nothing.
    shop.clock.advance(MAIL_WAIT_PASSED_MS);
    expect(await shop.tickets.sendDue(shop.clock.now())).toEqual({ sent: 0, skipped: 1, failed: 0, deferred: 0 });
    const list = renderHook(() => reactEntry.useRequests(shop.person));
    await waitFor(() => list.current().data !== null, 'the person list');
    expect(list.current().data!.tickets.find((ticket) => ticket.id === a.id)).toMatchObject({ derivedState: 'waiting_person', unread: false });

    // The person leaves the page; the next reply reaches no one there, so the list marks it unread and the mail run sends it.
    page.unmount();
    dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${a.id}/replies`, { body: 'Is there anything else on the invoice?' }));
    await act(async () => {
      await list.current().refresh();
    });
    expect(list.current().data!.tickets.find((ticket) => ticket.id === a.id)!.unread).toBe(true);
    shop.clock.advance(MAIL_WAIT_PASSED_MS);
    expect(await shop.tickets.sendDue(shop.clock.now())).toEqual({ sent: 1, skipped: 0, failed: 0, deferred: 0 });
    const mailed = shop.recorder.mails.filter((mail) => mail.kind === 'supportReply');
    expect(mailed).toEqual([{ kind: 'supportReply', accountId: PERSON.accountId, ticketId: a.id, category: 'billing', openedAt: a.createdAt, idempotencyKey: expect.any(String) }]);
    for (const kept of ['invoice', 'Refunded', 'Charged', 'charged', a.anonymousId]) expect(JSON.stringify(mailed)).not.toContain(kept);

    // A third reply inside the 30 minutes after that mail is left unmailed.
    dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${a.id}/replies`, { body: 'One more note on the refund.' }));
    shop.clock.advance(MAIL_WAIT_PASSED_MS);
    expect(await shop.tickets.sendDue(shop.clock.now())).toEqual({ sent: 0, skipped: 1, failed: 0, deferred: 0 });
    expect(shop.recorder.mails.filter((mail) => mail.kind === 'supportReply')).toHaveLength(1);
  });

  it('past three streams an account the route answers stream_busy and the page polls the thread while it is visible; behind a hidden page the polls stop, so the reply nobody saw is mailed, and they resume when the page shows', async () => {
    const shop = await product();
    const a = dataOf(await post<OpsTicket>(shop.person, `${PERSON_BASE}/requests`, { category: 'bug', subject: 'Export fails', body: 'The zip stops at 40 percent.' }));
    // Three other tabs of the person's hold the three streams an account may have.
    const held: OpsStream[] = [];
    for (let tab = 0; tab < 3; tab += 1) {
      const opened = await shop.tickets.stream(PERSON, a.id);
      if (isRefusal(opened)) throw new Error(`the stream was refused: ${opened.refused}`);
      held.push(opened);
    }
    const threadPath = `${PERSON_BASE}/requests/${a.id}`;
    const threadReads = (): number => shop.personCalls.filter((call) => call.method === 'GET' && call.path === threadPath).length;
    const page = renderHook(() => {
      const request = reactEntry.useRequest(shop.person, a.id);
      const stream = reactEntry.useStream(shop.person, a.id, { onPoll: () => void request.refresh(), pollMs: 80 });
      return { request, stream };
    });
    await waitFor(() => page.current().stream.mode === 'poll', 'the poll mode');
    expect(page.current().stream.error).toBe('stream_busy');
    expect(shop.personCalls.filter((call) => call.path === `${threadPath}/stream`).map((call) => call.status)).toEqual([503]);
    const polling = threadReads();
    await waitFor(() => threadReads() >= polling + 2, 'two polls');

    // A reply while the page polls shows at the next poll, whose read marks it read: no mail goes.
    shop.clock.advance(60_000);
    const seen = dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${a.id}/replies`, { body: 'We are looking into it.' }));
    await waitFor(() => (page.current().request.data?.messages ?? []).some((message) => message.id === seen.id), 'the polled reply');
    shop.clock.advance(MAIL_WAIT_PASSED_MS);
    expect(await shop.tickets.sendDue(shop.clock.now())).toEqual({ sent: 0, skipped: 1, failed: 0, deferred: 0 });

    // Behind a hidden page no poll reads the thread, so the next reply stays unread and is mailed.
    hidePage();
    await pause(200);
    const hiddenFrom = threadReads();
    const unseen = dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${a.id}/replies`, { body: 'Found it: one charge was a duplicate.' }));
    await pause(500);
    expect(threadReads()).toBe(hiddenFrom);
    expect((await shop.tickets.list(PERSON)).tickets.find((ticket) => ticket.id === a.id)!.unread).toBe(true);
    shop.clock.advance(MAIL_WAIT_PASSED_MS);
    expect(await shop.tickets.sendDue(shop.clock.now())).toEqual({ sent: 1, skipped: 0, failed: 0, deferred: 0 });
    expect(shop.recorder.mails.filter((mail) => mail.kind === 'supportReply')).toEqual([
      { kind: 'supportReply', accountId: PERSON.accountId, ticketId: a.id, category: 'bug', openedAt: a.createdAt, idempotencyKey: expect.any(String) },
    ]);

    // The page shows again: the polls resume and read the reply.
    showPage();
    await waitFor(() => (page.current().request.data?.messages ?? []).some((message) => message.id === unseen.id), 'the reply once the page shows');
    expect(threadReads()).toBeGreaterThan(hiddenFrom);
    expect(page.current().stream.mode).toBe('poll');
    for (const stream of held) stream.close();
  });

  it('a stream the server ends is opened again through the route with Last-Event-ID, sends nothing the page saw twice, and still delivers the next reply', async () => {
    const shop = await product({ streamLifeMs: 400 });
    const a = dataOf(await post<OpsTicket>(shop.person, `${PERSON_BASE}/requests`, { category: 'question', subject: 'Plans', body: 'Which plan has team seats?' }));
    const events: OpsStreamEvent[] = [];
    const page = renderHook(() => reactEntry.useStream(shop.person, a.id, { onEvent: (event) => events.push(event), reconnectMs: 100 }));
    const streamPath = `${PERSON_BASE}/requests/${a.id}/stream`;
    const streams = (): Call[] => shop.personCalls.filter((call) => call.path === streamPath);
    await waitFor(() => streams().length >= 2, 'a second connection');
    const [opening, again] = streams();
    expect(opening!.headers['last-event-id']).toBeUndefined();
    expect(again!.headers['last-event-id']).toBe(events[0]!.id);

    shop.clock.advance(60_000);
    const reply = dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${a.id}/replies`, { body: 'Team seats come with the Team plan.' }));
    await waitFor(() => events.some((event) => event.event === 'message' && event.id === reply.id), 'the reply');
    const before = streams().length;
    await waitFor(() => streams().length >= before + 1, 'the connection after the reply');
    await pause(150);
    expect(events.filter((event) => event.event === 'message').map((event) => event.id)).toEqual([reply.id]);
    expect(streams().at(-1)!.headers['last-event-id']).toBe(reply.id);
    expect(page.current().mode).toBe('stream');
    expect(shop.personCalls.filter((call) => call.path === `${PERSON_BASE}/requests/${a.id}/read`).map((call) => call.body)).toEqual([JSON.stringify({ messageId: reply.id })]);
  });

  it('a thread staff open to an account reaches the person by the bell and, unread five minutes on, by mail; the person list marks it unread until the page reads it, which opens with the system line', async () => {
    const shop = await product();
    const opened = dataOf(
      await post<OpsStaffTicket>(shop.staff, `${STAFF_BASE}/to/${encodeURIComponent(PERSON.accountId)}`, {
        category: 'account',
        subject: 'Your payment method',
        body: 'Your card on file expires this month.',
      }),
    );
    expect(opened).toMatchObject({
      source: 'staff',
      claimedBy: STAFF.accountId,
      shareIdentity: true,
      identityState: 'shared',
      identity: { name: 'Fixture Person', email: 'person@example.invalid' },
      derivedState: 'waiting_person',
    });
    expect(shop.recorder.audits).toEqual([{ kind: 'support_thread_opened', staffAccountId: STAFF.accountId, subject: opened.id, detail: { category: 'account' } }]);
    expect(shop.recorder.notices).toEqual([{ kind: 'supportReplied', accountIds: [PERSON.accountId], ticketId: opened.id, dedupeKey: expect.stringMatching(/^supportReplied:/) }]);

    const list = renderHook(() => reactEntry.useRequests(shop.person));
    await waitFor(() => list.current().data !== null, 'the person list');
    expect(list.current().data!.tickets.map((ticket) => [ticket.id, ticket.source, ticket.unread])).toEqual([[opened.id, 'staff', true]]);
    shop.clock.advance(MAIL_WAIT_PASSED_MS);
    expect(await shop.tickets.sendDue(shop.clock.now())).toEqual({ sent: 1, skipped: 0, failed: 0, deferred: 0 });
    const mailed = shop.recorder.mails.filter((mail) => mail.kind === 'supportReply');
    expect(mailed).toEqual([{ kind: 'supportReply', accountId: PERSON.accountId, ticketId: opened.id, category: 'account', openedAt: opened.createdAt, idempotencyKey: expect.any(String) }]);
    for (const kept of ['payment', 'expires', opened.anonymousId]) expect(JSON.stringify(mailed)).not.toContain(kept);

    const page = renderHook(() => reactEntry.useRequest(shop.person, opened.id));
    await waitFor(() => page.current().data !== null, 'the thread');
    const messages = page.current().data!.messages;
    expect(messages.map((message) => [message.sender, message.systemKey])).toEqual([
      ['system', 'opened_by_staff'],
      ['staff', null],
    ]);
    expect(messages[1]!.body).toBe('Your card on file expires this month.');
    await act(async () => {
      await list.current().refresh();
    });
    expect(list.current().data!.tickets[0]!.unread).toBe(false);
  });

  it('pictures go up through the routes within their bounds: PNG, JPEG or WebP under 5 MB, consent with the first, three a message and ten a request, stored upright as WebP with no metadata and shown with their headers to the person of the request and to staff alone', async () => {
    const shop = await product();
    const sharp = await loadSharp();
    // The bounds the server keeps whatever the page sends: the size, the leading bytes, and the declared type matching them.
    expect(await upload(shop.person, oversized(), 'image/png')).toEqual({ error: 'too_large', status: 413 });
    expect(await upload(shop.person, tinyPdf(), 'image/png')).toEqual({ error: 'not_an_image', status: 415 });
    expect(await upload(shop.person, tinyGif(), 'image/gif')).toEqual({ error: 'not_an_image', status: 415 });
    const jpeg = await jpegWithOrientationAndGps();
    expect(await upload(shop.person, jpeg, 'image/png')).toEqual({ error: 'not_an_image', status: 415 });
    const photo = dataOf(await upload(shop.person, jpeg, 'image/jpeg'));

    // The composer holds three pictures a message; the page sends its body and their ids through the route.
    const composer = renderHook(() => reactEntry.useComposer({ category: 'bug' }));
    act(() => {
      for (const id of [photo.id, 'pic_second', 'pic_third', 'pic_fourth']) composer.current().addPicture(id);
    });
    expect(composer.current().pictureIds).toEqual([photo.id, 'pic_second', 'pic_third']);
    act(() => {
      composer.current().removePicture('pic_second');
      composer.current().removePicture('pic_third');
      composer.current().setBody('The export button does nothing; a picture is attached.');
    });
    expect([composer.current().pictureIds, composer.current().canSend]).toEqual([[photo.id], true]);
    const input = { category: 'bug', subject: 'Export button', body: composer.current().body, pictureIds: composer.current().pictureIds };
    // The first picture of a request asks for the version of the words the person ticked.
    expect(await post(shop.person, `${PERSON_BASE}/requests`, input)).toEqual({ error: 'consent_needed', status: 428 });
    const opened = dataOf(await post<OpsTicket>(shop.person, `${PERSON_BASE}/requests`, { ...input, consent: { version: '2026-10-01' } }));
    const view = dataOf(await reactEntry.readJson<{ readonly ticket: OpsTicket; readonly messages: readonly OpsMessage[] }>(shop.person, `${PERSON_BASE}/requests/${opened.id}`));
    expect(view.messages[0]!.pictures).toEqual([{ id: photo.id, width: 4, height: 8 }]);

    // The picture as the page shows it: WebP, turned upright, its metadata gone, answered with the headers the route sets.
    const shown = await shop.person.fetch(`${PERSON_BASE}/pictures/${photo.id}`);
    expect(shown.status).toBe(200);
    expect(Object.fromEntries(shown.headers.entries())).toMatchObject({
      'content-type': 'image/webp',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
      'cache-control': 'no-store',
    });
    const bytes = new Uint8Array(await shown.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif, meta.orientation]).toEqual(['webp', 4, 8, undefined, undefined]);
    expect(Buffer.from(bytes).includes('GPS')).toBe(false);
    // Another person's session is told not_found; staff see the picture.
    const elsewhere = await shop.other.fetch(`${PERSON_BASE}/pictures/${photo.id}`);
    expect([elsewhere.status, await elsewhere.json()]).toEqual([404, { error: 'not_found' }]);
    expect((await shop.staff.fetch(`${STAFF_BASE}/pictures/${photo.id}`)).status).toBe(200);

    // Another account's upload cannot be attached: the write is refused as not_found.
    const small = await smallWebp();
    const theirs = dataOf(await upload(shop.other, small, 'image/webp'));
    expect(await post(shop.person, `${PERSON_BASE}/requests/${opened.id}/messages`, { body: 'Their picture.', pictureIds: [theirs.id] })).toEqual({ error: 'not_found', status: 404 });
    // A picture staff attach to the request is the person's to see.
    const fromStaff = dataOf(await upload(shop.staff, small, 'image/webp'));
    dataOf(await post<OpsMessage>(shop.staff, `${STAFF_BASE}/${opened.id}/replies`, { body: 'Is this the button?', pictureIds: [fromStaff.id] }));
    expect((await shop.person.fetch(`${PERSON_BASE}/pictures/${fromStaff.id}`)).status).toBe(200);

    // Four in one message is past three a message; later pictures on the request ask for no consent; the request holds ten.
    const ids: string[] = [];
    for (let picture = 0; picture < 9; picture += 1) ids.push(dataOf(await upload(shop.person, small, 'image/webp')).id);
    expect(await post(shop.person, `${PERSON_BASE}/requests/${opened.id}/messages`, { body: 'Four at once.', pictureIds: ids.slice(0, 4) })).toEqual({ error: 'too_many_pictures', status: 409 });
    for (const chunk of [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6, 8)]) {
      dataOf(await post<OpsMessage>(shop.person, `${PERSON_BASE}/requests/${opened.id}/messages`, { body: 'More pictures.', pictureIds: chunk }));
    }
    expect(await post(shop.person, `${PERSON_BASE}/requests/${opened.id}/messages`, { body: 'One more.', pictureIds: [ids[8]] })).toEqual({ error: 'too_many_pictures', status: 409 });
    const thread = dataOf(await reactEntry.readJson<{ readonly messages: readonly OpsMessage[] }>(shop.person, `${PERSON_BASE}/requests/${opened.id}`));
    expect(thread.messages.reduce((sum, message) => sum + message.pictures.length, 0)).toBe(10);
  });
});
