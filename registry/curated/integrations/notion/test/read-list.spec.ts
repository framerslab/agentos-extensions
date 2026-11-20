import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTION_READ_KIND, NOTION_VERSION, NotionFault, NotionReadConnector, type NotionReadOptions } from '../src/index.js';
import { NotionStandIn, edited, newestFirst, page, pages } from './standin.js';

const TOKEN = 'fake-access';
const standIn = new NotionStandIn();

/** A connector on the stand-in, read on CI, with the bounds a test does not name at their defaults. */
function connector(overrides: Partial<NotionReadOptions> = {}): NotionReadConnector {
  return new NotionReadConnector({ accessToken: TOKEN, maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000, apiBase: standIn.apiBase, ...overrides });
}

/** Lets every answer, its reading and the calls it starts run, on the real event loop, without moving faked time. */
async function settle(): Promise<void> {
  for (let i = 0; i < 400; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A cursor holding pages at the versions given. */
function cursorOf(list: readonly { id: string; lastEdited: string }[]): string {
  return JSON.stringify(Object.fromEntries(list.map((p) => [p.id, p.lastEdited])));
}

const [a, b, c, d] = [page(1, 'Alpha'), page(2, 'Bravo'), page(3, 'Charlie'), page(4, 'Delta')];
const a2 = edited(a, 30);
const d2 = edited(d, 10);

beforeAll(async () => {
  await standIn.start();
});

afterAll(async () => {
  await standIn.stop();
});

beforeEach(() => {
  vi.stubEnv('CI', 'true');
  standIn.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('NotionReadConnector list and changesSince', () => {
  it('names its kind notion', () => {
    expect(NOTION_READ_KIND).toBe('notion');
    expect(connector().kind).toBe('notion');
  });

  it('lists the pages the grant reaches, newest edited first, across search pages, up to maxPages, each with its parent', async () => {
    standIn.share(pages(250));
    const { items, gone } = await connector({ maxPages: 120 }).list({ ids: [] });
    expect(items).toHaveLength(120);
    expect(items.map((i) => i.version)).toEqual([...items.map((i) => i.version)].sort().reverse());
    expect(items[0]).toEqual({ id: standIn.newest.id, title: standIn.newest.title, size: null, version: standIn.newest.lastEdited, parent: standIn.newest.parent });
    expect(new Set(items.map((i) => i.parent.type))).toEqual(new Set(['workspace', 'page', 'database', 'block']));
    expect(gone).toEqual([]);
    const searches = standIn.seen('POST /v1/search');
    expect(searches.map((body) => body.filter)).toEqual(Array(2).fill({ property: 'object', value: 'page' }));
    expect(searches.map((body) => body.sort)).toEqual(Array(2).fill({ direction: 'descending', timestamp: 'last_edited_time' }));
    expect(searches[0]).not.toHaveProperty('start_cursor');
    expect(typeof searches[1]!.start_cursor).toBe('string');
  });

  it('narrows to the ids asked for by retrieving each: trashed or unshared removed, out of the grant no_access', async () => {
    standIn.share([a, b, d]);
    standIn.trash(b);
    standIn.unshare(c);
    standIn.forbid(d);
    const { items, gone } = await connector().list({ ids: [a.id, b.id, c.id, d.id] });
    expect(items).toEqual([{ id: a.id, title: a.title, size: null, version: a.lastEdited, parent: a.parent }]);
    expect(gone).toEqual([{ id: b.id, reason: 'removed' }, { id: c.id, reason: 'removed' }, { id: d.id, reason: 'no_access' }]);
    expect(standIn.seen('POST /v1/search')).toEqual([]);
  });

  it('answers a grant without Read content as restricted and reads nothing', async () => {
    standIn.share([a]);
    standIn.withoutReadContent();
    await expect(connector().list({ ids: [] })).rejects.toMatchObject({ name: 'NotionFault', reason: 'restricted', status: 403 });
    expect(standIn.calls()).toBe(1);
  });

  it("passes Notion's wait on a 429 and sends nothing after it", async () => {
    standIn.share(pages(150));
    standIn.rateLimitNext({ retryAfter: 75 });
    await expect(connector().list({ ids: [] })).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 75_000 });
    expect(standIn.calls()).toBe(1);
  });

  it('answers changes since a cursor by retrieving every page it holds, whatever search says', async () => {
    // a edited; b unshared while search still lists it at its old version; d edited while search omits it; c new.
    standIn.share([a2, b, c, d2]);
    standIn.searchListsStale(b);
    standIn.unshare(b);
    standIn.searchOmits(d2);
    const changes = await connector().changesSince(cursorOf([a, b, d]), { ids: [] });
    expect(changes.changed.map((i) => i.id)).toEqual(newestFirst([c, d2, a2]).map((p) => p.id));
    expect(changes.changed.find((i) => i.id === a.id)).toEqual({ id: a.id, title: a.title, size: null, version: a2.lastEdited, parent: a.parent });
    expect(changes.gone).toEqual([{ id: b.id, reason: 'removed' }]);
    expect(standIn.seen('GET /v1/pages/:id').map((r) => r.id).sort()).toEqual([a.id, b.id, d.id].sort());
    expect(JSON.parse(changes.cursor)).toEqual({ [a.id]: a2.lastEdited, [d.id]: d2.lastEdited, [c.id]: c.lastEdited });
  });

  it('keeps a held page search omits while its retrieve answers it at the same version', async () => {
    standIn.share([a]);
    standIn.searchOmits(a);
    const changes = await connector().changesSince(cursorOf([a]), { ids: [] });
    expect(changes).toMatchObject({ changed: [], gone: [] });
    expect(JSON.parse(changes.cursor)).toEqual({ [a.id]: a.lastEdited });
  });

  it('answers a held page in the trash removed and one the grant no longer reaches no_access', async () => {
    standIn.share([a, b, c]);
    standIn.trash(b);
    standIn.forbid(c);
    const changes = await connector().changesSince(cursorOf([a, b, c]), { ids: [] });
    expect(changes).toMatchObject({ changed: [], gone: [{ id: b.id, reason: 'removed' }, { id: c.id, reason: 'no_access' }] });
    expect(JSON.parse(changes.cursor)).toEqual({ [a.id]: a.lastEdited });
  });

  it('adds at most maxPages new pages from its relist', async () => {
    const held = pages(5, 1);
    const fresh = pages(8, 100);
    standIn.share([...held, ...fresh]);
    const changes = await connector({ maxPages: 3 }).changesSince(cursorOf(held), { ids: [] });
    expect(changes.changed.map((i) => i.id)).toEqual(newestFirst(fresh).slice(0, 3).map((p) => p.id));
  });

  it('never sends more than requestsPerMinute calls in a minute', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const held = pages(200);
    standIn.share(held);
    const reading = new NotionReadConnector({ accessToken: TOKEN, maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000, fetchImpl: standIn.fetchImpl, concurrency: 8 })
      .changesSince(cursorOf(held), { ids: [] });
    await settle();
    expect(standIn.calls()).toBe(180);
    await vi.advanceTimersByTimeAsync(59_999);
    await settle();
    expect(standIn.calls()).toBe(180);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(standIn.calls()).toBe(202); // two search pages, every one of them held, then the 200 retrieves
    const changes = await reading;
    expect(changes).toMatchObject({ changed: [], gone: [] });
  });

  it('sends every call through `send` when given, with its method word, and none around it', async () => {
    standIn.share([a]);
    const seen: string[] = [];
    await connector({ send: (method, call) => { seen.push(method); return call(new AbortController().signal); } }).changesSince(cursorOf([a]), { ids: [] });
    expect(seen).toEqual(['search', 'retrieve']);
    expect(standIn.calls()).toBe(2);
  });

  it('keeps at most `concurrency` calls in flight when it retrieves the held pages, and answers what one at a time answers', async () => {
    const held = pages(30);
    standIn.share(held);
    standIn.delayEach(5);
    const cursor = cursorOf(held);
    const one = await connector().changesSince(cursor, { ids: [] });
    expect(standIn.mostInFlight()).toBe(1);
    const three = await connector({ concurrency: 3 }).changesSince(cursor, { ids: [] });
    expect(three).toEqual(one);
    expect(standIn.mostInFlight()).toBe(3);
  });

  it('sends no call still waiting for the window once another call has failed, and throws the first fault', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    standIn.share([a, b]);
    standIn.rateLimitNext({ retryAfter: 30 });
    const listing = new NotionReadConnector({ accessToken: TOKEN, maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000, fetchImpl: standIn.fetchImpl, concurrency: 2, requestsPerMinute: 1 })
      .list({ ids: [a.id, b.id] });
    const outcome = listing.then(() => 'answered', (error: unknown) => error);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(await outcome).toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 30_000 });
    expect(standIn.calls()).toBe(1);
  });

  it("sends no call the host's budget held once another call has failed", async () => {
    standIn.share([a, b]);
    standIn.rateLimitNext({ retryAfter: 30 });
    let firstSettled!: () => void;
    const settled = new Promise<void>((resolve) => { firstSettled = resolve; });
    let given = 0;
    const send: NotionReadOptions['send'] = async (_method, call) => {
      given += 1;
      if (given === 1) return call(new AbortController().signal).finally(firstSettled);
      await settled;
      await new Promise((resolve) => setImmediate(resolve));
      return call(new AbortController().signal);
    };
    await expect(connector({ concurrency: 2, send }).list({ ids: [a.id, b.id] })).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 30_000 });
    expect(given).toBe(2);
    expect(standIn.calls()).toBe(1);
  });

  it('keeps the process alive while a call waits for the window, and lets it go once no call waits', async () => {
    const real = globalThis.setTimeout;
    const windowTimers: Array<{ hasRef(): boolean }> = [];
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((handler: (...args: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
      const timer = real(handler, ms, ...rest);
      if ((ms ?? 0) > 30_000) windowTimers.push(timer as unknown as { hasRef(): boolean });
      return timer;
    }) as unknown as typeof setTimeout);
    try {
      standIn.share([a, b]);
      const stop = new AbortController();
      const outcome = connector({ apiBase: undefined, fetchImpl: standIn.fetchImpl, requestsPerMinute: 1 })
        .list({ ids: [a.id, b.id] }, stop.signal)
        .then(() => 'answered', (error: unknown) => error);
      await vi.waitFor(() => expect(windowTimers).toHaveLength(1));
      await settle();
      expect(standIn.calls()).toBe(1);
      expect(windowTimers[0]!.hasRef()).toBe(true);
      stop.abort();
      expect(await outcome).toMatchObject({ name: 'NotionFault', reason: 'cancelled' });
      expect(windowTimers[0]!.hasRef()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('passes a place on when the call it woke has been stopped, so the next waiting call goes out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    standIn.share([a, b, c]);
    const pager = new NotionReadConnector({ accessToken: TOKEN, maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000, fetchImpl: standIn.fetchImpl, requestsPerMinute: 1 });
    await pager.list({ ids: [a.id] });
    const stopSecond = new AbortController();
    const second = pager.list({ ids: [b.id] }, stopSecond.signal).then(() => 'answered', (error: unknown) => error);
    const third = pager.list({ ids: [c.id] });
    await settle();
    setTimeout(() => stopSecond.abort(), 60_000); // fires right after the window gives its place to the second call
    vi.advanceTimersByTime(60_000);
    await settle();
    expect(await second).toMatchObject({ name: 'NotionFault', reason: 'cancelled' });
    expect(standIn.calls()).toBe(2);
    expect((await third).items.map((i) => i.id)).toEqual([c.id]);
  });

  it("stops waiting for a call the host's budget holds once the operation is stopped", async () => {
    standIn.share([a]);
    const stop = new AbortController();
    const send: NotionReadOptions['send'] = () => new Promise(() => {});
    const listing = connector({ send }).list({ ids: [a.id] }, stop.signal);
    await settle();
    stop.abort();
    await expect(listing).rejects.toMatchObject({ name: 'NotionFault', reason: 'cancelled' });
    expect(standIn.calls()).toBe(0);
  });

  it("stops waiting for a held call even when a listener on the caller's signal stops the abort event", async () => {
    standIn.share([a]);
    const stop = new AbortController();
    stop.signal.addEventListener('abort', (event) => event.stopImmediatePropagation());
    const send: NotionReadOptions['send'] = () => new Promise(() => {});
    const listing = connector({ send }).list({ ids: [a.id] }, stop.signal);
    await settle();
    stop.abort();
    await expect(listing).rejects.toMatchObject({ name: 'NotionFault', reason: 'cancelled' });
    expect(standIn.calls()).toBe(0);
  });

  it("sends no call that a host's budget starts as soon as a failed call settles", async () => {
    standIn.share([a, b]);
    standIn.rateLimitNext({ retryAfter: 30 });
    let gate: Promise<unknown> = Promise.resolve();
    const send: NotionReadOptions['send'] = (_method, call) => {
      const run = gate.then(() => call(new AbortController().signal));
      gate = run.then(() => undefined, () => undefined);
      return run;
    };
    await expect(connector({ concurrency: 2, send }).list({ ids: [a.id, b.id] })).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 30_000 });
    expect(standIn.calls()).toBe(1);
  });

  it('sends its token and Notion\'s version on every call', async () => {
    standIn.share([a]);
    const sent: Headers[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return standIn.fetchImpl(input, init);
    }) as typeof fetch;
    await new NotionReadConnector({ accessToken: TOKEN, maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000, fetchImpl }).changesSince(cursorOf([a]), { ids: [] });
    expect(sent).toHaveLength(2);
    for (const headers of sent) {
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.get('notion-version')).toBe(NOTION_VERSION);
    }
  });

  it('refuses a stand-in address off CI and a token that is not a credential, before any call', async () => {
    const base = { maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000 };
    expect(() => new NotionReadConnector({ ...base, accessToken: 'has a space', apiBase: standIn.apiBase })).toThrow(NotionFault);
    expect(() => new NotionReadConnector({ ...base, accessToken: '', apiBase: standIn.apiBase })).toThrow(expect.objectContaining({ reason: 'configuration' }));
    expect(() => new NotionReadConnector({ ...base, accessToken: TOKEN, maxPages: 0, apiBase: standIn.apiBase })).toThrow(expect.objectContaining({ reason: 'configuration' }));
    expect(() => new NotionReadConnector({ ...base, accessToken: TOKEN, concurrency: 0, apiBase: standIn.apiBase })).toThrow(expect.objectContaining({ reason: 'configuration' }));
    vi.stubEnv('CI', 'false');
    expect(() => new NotionReadConnector({ ...base, accessToken: TOKEN, apiBase: standIn.apiBase })).toThrow(expect.objectContaining({ reason: 'configuration' }));
    await expect(connector({ apiBase: undefined, fetchImpl: standIn.fetchImpl }).changesSince('not json', { ids: [] })).rejects.toMatchObject({ reason: 'configuration' });
    expect(standIn.calls()).toBe(0);
  });

  it('calls the revoke it is given, and nothing without one', async () => {
    const revoke = vi.fn(async () => undefined);
    await connector({ revoke }).revoke();
    expect(revoke).toHaveBeenCalledTimes(1);
    await expect(connector().revoke()).resolves.toBeUndefined();
    expect(standIn.calls()).toBe(0);
  });
});
