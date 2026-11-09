import { describe, expect, it } from 'vitest';
import { WildweaveStudioClient } from '../src/client.js';
import { FAKE_KEY, capturedLogger } from './helpers.js';

/** A fetch stand-in answering each call from the list in turn, recording what it was asked. */
function scripted(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (!next) throw new Error('no answer scripted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetchStub, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** An answer whose headers arrive and whose body is cut off. */
const cutOff = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error('socket hang up'));
      },
    }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );

/** A client over the scripted answers; `key: null` makes one without a key. */
function client(answers: Array<Response | Error>, key: string | null = FAKE_KEY) {
  const { fetchStub, calls } = scripted(answers);
  const waits: number[] = [];
  const c = new WildweaveStudioClient({
    baseUrl: 'https://studio.example.invalid/',
    ...(key === null ? {} : { key }),
    fetch: fetchStub,
    sleep: async (ms) => void waits.push(ms),
    requestId: () => 'client-req-1',
  });
  return { c, calls, waits };
}

describe('the studio client', () => {
  it('answers key_missing without a key, and calls nothing', async () => {
    const { c, calls } = client([], null);
    const answer = await c.listFilms();
    expect(answer).toMatchObject({ ok: false, error: { code: 'key_missing' } });
    expect(calls).toHaveLength(0);
  });

  it('sends the key in Authorization alone, with the request id, to the studio path', async () => {
    const { c, calls } = client([json(200, { films: [] }, { 'x-request-id': 'proxy-req-9' })]);
    const answer = await c.listFilms();
    expect(answer).toEqual({ ok: true, result: { films: [] }, status: 200, requestId: 'proxy-req-9' });
    expect(calls[0]!.url).toBe('https://studio.example.invalid/api/v1/wildweave/studio/films');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(headers['x-client-request-id']).toBe('client-req-1');
    expect(calls[0]!.url).not.toContain(FAKE_KEY);
  });

  it('retries a GET on a 503 after 1 s and 4 s, then answers', async () => {
    const { c, calls, waits } = client([json(503, { error: 'unavailable' }), json(503, {}), json(200, { films: [] })]);
    const answer = await c.listFilms();
    expect(answer.ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([1000, 4000]);
  });

  it('gives up after the third try and reports the last answer', async () => {
    const { c, calls } = client([json(502, {}), json(504, {}), json(502, {})]);
    const answer = await c.timeline('f1');
    expect(answer).toMatchObject({ ok: false, error: { code: 'http_502', status: 502 } });
    expect(calls).toHaveLength(3);
  });

  it('passes a 503 not_open through unretried', async () => {
    const { c, calls } = client([json(503, { error: 'not_open' })]);
    const answer = await c.job('f1', 'j1');
    expect(answer).toMatchObject({ ok: false, error: { code: 'not_open', status: 503 } });
    expect(calls).toHaveLength(1);
  });

  it('never retries a 403 or a 401', async () => {
    const forbidden = client([json(403, { error: 'scope_required' })]);
    expect(await forbidden.c.listFilms()).toMatchObject({ ok: false, error: { code: 'scope_required', status: 403 } });
    expect(forbidden.calls).toHaveLength(1);
    const unauthorized = client([new Response('', { status: 401 })]);
    expect(await unauthorized.c.listFilms()).toMatchObject({ ok: false, error: { code: 'key_rejected', status: 401 } });
    expect(unauthorized.calls).toHaveLength(1);
    const bare = client([new Response('', { status: 403 })]);
    expect(await bare.c.listFilms()).toMatchObject({ ok: false, error: { code: 'forge_required' } });
  });

  it('waits out a 429 by its Retry-After, even for a write, since the gate refused it before the route ran', async () => {
    const { c, calls, waits } = client([json(429, { error: 'rate_limited' }, { 'retry-after': '2' }), json(200, { seq: 3, restored: [] })]);
    const answer = await c.revert('f1', { toSeq: 1, ifUpdatedAtMs: { a: 1 } });
    expect(answer.ok).toBe(true);
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(2);
  });

  it('stops after three 429s', async () => {
    const { c, calls } = client([json(429, { error: 'rate_limited' }), json(429, { error: 'rate_limited' }), json(429, { error: 'rate_limited' }), json(429, { error: 'rate_limited' })]);
    expect(await c.listFilms()).toMatchObject({ ok: false, error: { code: 'rate_limited', status: 429 } });
    expect(calls).toHaveLength(4);
  });

  it('never retries a write without an id of its own, on a 503 or a network error', async () => {
    const gateway = client([json(503, {})]);
    expect(await gateway.c.revert('f1', { toSeq: 1, ifUpdatedAtMs: { a: 1 } })).toMatchObject({ ok: false, error: { code: 'http_503' } });
    expect(gateway.calls).toHaveLength(1);
    const network = client([new TypeError('fetch failed')]);
    expect(await network.c.acknowledge('f1', { ack: { timeline: 'a'.repeat(64) }, ifUpdatedAtMs: { a: 1 } })).toMatchObject({ ok: false, error: { code: 'network' } });
    expect(network.calls).toHaveLength(1);
  });

  it('retries an edit, which its editId makes idempotent on the route', async () => {
    const { c, calls } = client([new TypeError('fetch failed'), json(200, { seq: 2, applied: 1 })]);
    const answer = await c.edit('f1', { editId: 'e1', ifUpdatedAtMs: { a: 1 }, ops: [{ op: 'trim', sceneId: 's01', durMs: 4000 }] });
    expect(answer.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries a submit only when it carries its proposalId', async () => {
    const without = client([json(502, {})]);
    expect((await without.c.submitProposal('f1', { sceneId: 's01' })).ok).toBe(false);
    expect(without.calls).toHaveLength(1);
    const withId = client([json(502, {}), json(201, { proposal: { proposalId: 'p' } })]);
    expect((await withId.c.submitProposal('f1', { sceneId: 's01', proposalId: 'p' })).ok).toBe(true);
    expect(withId.calls).toHaveLength(2);
  });

  it("reads a 2xx { ok: false } with no refusal code as the route's answer (the validate's errors)", async () => {
    const { c } = client([json(200, { ok: false, findings: [{ level: 'error', code: 'sum_mismatch', message: 'm' }], counts: { errors: 1 } })]);
    const answer = await c.validate('f1');
    expect(answer).toMatchObject({ ok: true, result: { ok: false, counts: { errors: 1 } } });
  });

  it("maps a refusal's code, findings and the rest of its answer", async () => {
    const stale = client([json(409, { error: 'stale_write', updatedAtMs: { a: 2 } })]);
    expect(await stale.c.edit('f1', { editId: 'e1', ifUpdatedAtMs: { a: 1 }, ops: [] })).toMatchObject({
      ok: false,
      error: { code: 'stale_write', status: 409, details: { updatedAtMs: { a: 2 } }, requestId: 'client-req-1' },
    });
    const refused = client([json(422, { error: 'edit_refused', refused: { op: 0, code: 'trim_below_frame', message: '10 ms is less than one frame' } })]);
    expect(await refused.c.edit('f1', { editId: 'e2', ifUpdatedAtMs: { a: 1 }, ops: [] })).toMatchObject({
      ok: false,
      error: { code: 'edit_refused', message: '10 ms is less than one frame', details: { refused: { code: 'trim_below_frame' } } },
    });
    const scene = client([json(422, { error: 'scene_unknown', sceneId: 's09' })]);
    expect(await scene.c.submitProposal('f1', { sceneId: 's09' })).toMatchObject({ ok: false, error: { code: 'scene_unknown', sceneId: 's09' } });
  });

  it('reads an answer cut off after its headers as a failed call, retried for a read, never as an empty success', async () => {
    const read = client([cutOff(200), json(200, { films: [] })]);
    expect(await read.c.listFilms()).toMatchObject({ ok: true, result: { films: [] } });
    expect(read.calls).toHaveLength(2);
    expect(read.waits).toEqual([1000]);
    const write = client([cutOff(200)]);
    expect(await write.c.revert('f', { toSeq: 1, ifUpdatedAtMs: {} })).toMatchObject({ ok: false, error: { code: 'network', status: 200 } });
    expect(write.calls).toHaveLength(1);
  });

  it('keeps the status rules for an answer cut off after its headers: a 429 waits out its Retry-After, a 401 is never retried', async () => {
    const limited = client([cutOff(429, { 'retry-after': '2' }), json(200, { seq: 3, restored: [] })]);
    expect(await limited.c.revert('f', { toSeq: 1, ifUpdatedAtMs: {} })).toMatchObject({ ok: true, result: { seq: 3 } });
    expect(limited.waits).toEqual([2000]);
    const refused = client([cutOff(401), json(200, { films: [] }), json(200, { films: [] })]);
    expect(await refused.c.listFilms()).toMatchObject({ ok: false, error: { code: 'key_rejected', status: 401 } });
    expect(refused.calls).toHaveLength(1);
  });

  it('never puts the key in an error or a log line', async () => {
    const { log, lines } = capturedLogger([FAKE_KEY]);
    const { fetchStub } = scripted([new TypeError(`connect failed for Bearer ${FAKE_KEY}`), new TypeError('x'), new TypeError(`again ${FAKE_KEY}`)]);
    const c = new WildweaveStudioClient({ baseUrl: 'https://studio.example.invalid', key: FAKE_KEY, fetch: fetchStub, sleep: async () => undefined, log });
    const answer = await c.listFilms();
    expect(answer.ok).toBe(false);
    expect(JSON.stringify(answer)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(lines)).not.toContain(FAKE_KEY);
    expect(lines.filter((l) => l.event === 'wildweave_film.retry')).toHaveLength(2);
  });

  it("keeps a file's storage key out of the log lines of its fetch, and out of the refusal of an address that is not the files route", async () => {
    const sha = 'a'.repeat(64);
    const storageKey = `wildweave-film/account-7f3e/studio/${sha}`;
    const { log, lines } = capturedLogger([FAKE_KEY]);
    const { fetchStub, calls } = scripted([json(503, { error: 'storage_unavailable' }), json(404, { error: 'not_found' })]);
    const c = new WildweaveStudioClient({ baseUrl: 'https://studio.example.invalid', key: FAKE_KEY, fetch: fetchStub, sleep: async () => undefined, log });
    const answer = await c.file(`/api/v1/wildweave/studio/files/${sha}?key=${encodeURIComponent(storageKey)}`, sha);
    expect(answer).toMatchObject({ ok: false, error: { code: 'not_found', status: 404 } });
    // The key reached the route, and no log line repeats it.
    expect(calls.map((call) => new URL(call.url).searchParams.get('key'))).toEqual([storageKey, storageKey]);
    expect(lines.filter((l) => l.event === 'wildweave_film.retry')).toHaveLength(1);
    expect(lines.filter((l) => l.event === 'wildweave_film.refused')).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('account-7f3e');
    const elsewhere = await c.file(`https://elsewhere.example.invalid/files/${sha}?key=${encodeURIComponent(storageKey)}`, sha);
    expect(elsewhere).toMatchObject({ ok: false, error: { code: 'fetch_failed' } });
    expect(JSON.stringify(elsewhere)).not.toContain('account-7f3e');
  });
});
