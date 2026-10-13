import { describe, it, expect } from 'vitest';
import { DispatchRefusedError, NoCapacityError, MemoryDurableInbox, hashWorkerToken, type MeetingRunRecord } from '@framers/agentos/io/channels/meetings';
import { ZoomApi } from '../src/api.js';
import { InMemoryZoomTokenStore, ZoomTokenKeeper } from '../src/tokens.js';
import { zoomWebhookSignature } from '../src/webhook.js';
import { ZoomRtmsProvider, type ZoomInboxValue } from '../src/ZoomRtmsProvider.js';

const SECRET = 'not-a-real-secret';
const STARTED = '{"event":"meeting.rtms_started","event_ts":1739923528000,"payload":{"meeting_uuid":"m-uuid","operator_id":"u-1","rtms_stream_id":"s-1","meeting_id":81234567890,"account_id":"a-1","is_original_host":true,"server_urls":"wss://rtms.example.test/signaling"}}';
const stopped = (reason: number) => `{"event":"meeting.rtms_stopped","event_ts":1739923528000,"payload":{"meeting_uuid":"m-uuid","rtms_stream_id":"s-1","stop_reason":${reason}}}`;
const signed = (body: string) => ({ 'x-zm-signature': zoomWebhookSignature(SECRET, '1739923528', body), 'x-zm-request-timestamp': '1739923528' });

const run = (over: Partial<MeetingRunRecord> = {}): MeetingRunRecord => ({
  runId: 'r1', ownerRef: 'owner-1', providerName: 'zoom-rtms', platform: 'zoom', state: 'dispatching', keep: 'none',
  meetingUrl: 'https://zoom.us/j/81234567890?pwd=x', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop',
  limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 14_400_000 }, requestedAt: 0, joinAt: 0, billedSeconds: 0, ...over,
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

async function setup() {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: string | undefined }> = [];
  const state = {
    workerStatus: 201,
    commandStatus: 200,
    closed: true,
    forwardFails: false,
    /** The answers of the next calls of Zoom's status endpoint; 204 once it is empty. */
    zoom: [] as Array<{ status: number; code?: number }>,
  };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    calls.push({ method, url: u, headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? init.body : undefined });
    if (u === 'https://worker.test/runs' && method === 'POST') return json(state.workerStatus, state.workerStatus === 409 ? { error: 'no slot' } : { runId: 'r1', state: 'waiting', startedAt: 1, seconds: 0 });
    if (u === 'https://worker.test/runs' && method === 'GET') return json(200, [{ runId: 'r1', state: 'streaming', startedAt: 1, seconds: 42 }, { runId: 'r3', state: 'ended', startedAt: 1, seconds: 9 }]);
    if (u.startsWith('https://worker.test/runs/') && u.endsWith('/command')) {
      if (state.commandStatus !== 200) return json(state.commandStatus, {});
      if (JSON.parse(String(init?.body)).name === 'confirmClosed') state.closed = true;
      return json(200, { closed: state.closed });
    }
    if (u.startsWith('https://worker.test/runs/') && method === 'DELETE') return new Response(null, { status: 204 });
    if (u === 'https://worker.test/zoom/webhook') {
      if (state.forwardFails) throw new Error('down');
      return json(200, { matched: true });
    }
    if (u.includes('/rtms_app/status')) {
      const next = state.zoom.shift() ?? { status: 204 };
      return next.status === 204 ? new Response(null, { status: 204 }) : json(next.status, { code: next.code, message: "words Zoom wrote about 'u-1'" });
    }
    if (u.endsWith('/oauth/token')) return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: '' });
    if (u.endsWith('/oauth/revoke')) return json(200, {});
    return json(404, {});
  }) as typeof fetch;
  const store = new InMemoryZoomTokenStore();
  const tokens = new ZoomTokenKeeper({ store, oauth: { clientId: 'client-id-1', clientSecret: SECRET, redirectUri: 'https://product.test/return', fetchImpl: impl }, clock: () => 1_000 });
  await tokens.connect({ ownerRef: 'owner-1', zoomUserId: 'u-1', zoomAccountId: 'a-1', tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 3_600_000, scope: '' } });
  const runs = new Map<string, MeetingRunRecord>([['r1', run()]]);
  const deauthorized: Array<{ zoomUserId: string; connections: Array<{ ownerRef: string; generation: string }> }> = [];
  const provider = new ZoomRtmsProvider({
    clientId: 'client-id-1', webhookSecret: SECRET, workerUrl: 'https://worker.test', workerToken: 'client-credential', workerId: 'w1', tokens,
    api: new ZoomApi({ fetchImpl: impl }), fetchImpl: impl, runOf: async (id) => runs.get(id), clock: () => 1_739_923_528_000,
    onDeauthorized: async (input) => { deauthorized.push(input); },
  });
  const dispatchInput = { run: run(), room: { url: 'wss://lk.test', name: 'bot-r1', publishToken: 'jwt' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/events/zoom-rtms/r1' };
  return { calls, state, store, tokens, provider, runs, deauthorized, dispatchInput, impl };
}

describe('ZoomRtmsProvider', () => {
  it('declares a provider with no participant, no chat, a media stream and a stop link', async () => {
    const { provider } = await setup();
    expect(provider.name).toBe('zoom-rtms');
    expect(provider.platforms).toEqual(['zoom']);
    expect(provider.capabilities).toEqual({ joinsAsParticipant: false, postsChat: false, readsChat: false, audioPath: 'media_stream', recordsAudio: false, transcribes: false, keeps: 'nothing', stopPath: 'link' });
    expect(provider.checkJoinUrl('https://us06web.zoom.us/j/81234567890')).toEqual({ ok: true, platform: 'zoom' });
    expect(provider.checkJoinUrl('https://meet.google.com/abc-defg-hij').ok).toBe(false);
  });

  it("registers the run with the worker, then starts the stream at Zoom with the owner's token", async () => {
    const { provider, calls, dispatchInput } = await setup();
    expect(await provider.dispatch(dispatchInput)).toEqual({ workerId: 'w1', providerRunRef: 'r1' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST https://worker.test/runs', 'PATCH https://api.zoom.us/v2/live_meetings/81234567890/rtms_app/status']);
    expect(calls[0].headers.authorization).toBe('Bearer client-credential');
    expect(JSON.parse(calls[0].body!)).toMatchObject({ runId: 'r1', connectionGeneration: expect.any(String), connectionCreatedAt: 1000, runGeneration: expect.any(String), requestedAt: 0, meetingNumber: '81234567890', zoomUserId: 'u-1', livekit: { url: 'wss://lk.test', token: 'jwt', identity: 'bot' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/events/zoom-rtms/r1', totalMs: 14_400_000 });
    expect(calls[1].headers.authorization).toBe('Bearer access-1');
    expect(JSON.parse(calls[1].body!)).toEqual({ action: 'start', settings: { client_id: 'client-id-1', participant_user_id: 'u-1' } });
  });

  it('refuses for good with a code word what Zoom will never allow, takes the run back from the worker, and keeps no word of Zoom', async () => {
    const table: Array<[number, number, 'permission_denied' | 'no_capacity', string]> = [[403, 2308, 'permission_denied', 'not_allowed'], [403, 13267, 'permission_denied', 'rtms_off'], [403, 13262, 'permission_denied', 'app_not_allowed'], [400, 3000, 'permission_denied', 'not_started'], [400, 2310, 'no_capacity', 'no_credits']];
    for (const [status, code, reason, word] of table) {
      const { provider, calls, state, dispatchInput } = await setup();
      state.zoom.push({ status, code });
      const refused = await provider.dispatch(dispatchInput).catch((error: unknown) => error);
      expect(refused, word).toBeInstanceOf(DispatchRefusedError);
      expect(refused, word).toMatchObject({ reason, message: word });
      expect(calls.at(-1), word).toMatchObject({ method: 'DELETE', url: 'https://worker.test/runs/r1' });
    }
  });

  it('refuses for good an owner with no connection, without a call to the worker', async () => {
    const { provider, calls, dispatchInput } = await setup();
    await expect(provider.dispatch({ ...dispatchInput, run: run({ ownerRef: 'nobody' }) })).rejects.toMatchObject({ name: 'DispatchRefusedError', reason: 'permission_denied', message: 'not_connected' });
    expect(calls).toEqual([]);
  });

  it('throws NoCapacityError when the worker is full, and a plain error for a fault of the moment at Zoom, with the run taken back', async () => {
    const full = await setup();
    full.state.workerStatus = 409;
    await expect(full.provider.dispatch(full.dispatchInput)).rejects.toBeInstanceOf(NoCapacityError);
    expect(full.calls.length).toBe(1);
    const flaky = await setup();
    flaky.state.zoom.push({ status: 503 });
    const error = await flaky.provider.dispatch(flaky.dispatchInput).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(DispatchRefusedError);
    expect(error).toMatchObject({ name: 'ZoomApiError', status: 503 });
    expect(flaky.calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://worker.test/runs/r1' });
  });

  it('takes a run back from the worker with a withdrawal when the start fails, so the worker reports no end of an attempt the manager tries again', async () => {
    const flaky = await setup();
    flaky.state.closed = false; // no stream reached the run at the worker: the closure is proved through Zoom's API
    flaky.state.zoom.push({ status: 503 });
    const error = await flaky.provider.dispatch(flaky.dispatchInput).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ZoomApiError', status: 503 });
    const commands = flaky.calls.filter((call) => call.url === 'https://worker.test/runs/r1/command').map((call) => JSON.parse(call.body!).name);
    expect(commands).toEqual(['withdraw', 'confirmClosed']);
    expect(flaky.calls.at(-2)).toMatchObject({ method: 'POST', url: 'https://worker.test/runs/r1/command' });
    expect(flaky.calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://worker.test/runs/r1' });
    expect(flaky.calls.filter((call) => call.method === 'PATCH').map((call) => JSON.parse(call.body!).action)).toEqual(['start', 'stop']);
  });

  it('refreshes once when Zoom refuses the held token, and tries the start again', async () => {
    const { provider, calls, state, dispatchInput } = await setup();
    state.zoom.push({ status: 401, code: 124 });
    await provider.dispatch(dispatchInput);
    const starts = calls.filter((c) => c.url.includes('/rtms_app/status'));
    expect(starts.map((c) => c.headers.authorization)).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it("verifies a worker's report by the run's token, and a forwarded webhook by the token and Zoom's signature both", async () => {
    const { provider } = await setup();
    const withToken = run({ dispatch: { roomName: 'bot-r1', workerTokenHash: hashWorkerToken('tok-1') } });
    const report = JSON.stringify({ type: 'report', runId: 'r1', workerId: 'w1', seq: 2, event: 'in_call', at: 5 });
    const ctx = (body: string, headers: Record<string, string>) => ({ providerName: 'zoom-rtms', method: 'POST', url: '/events/zoom-rtms/r1', headers, body, runId: 'r1' });
    expect(provider.verifyEvent(ctx(report, { authorization: 'Bearer tok-1' }), withToken).valid).toBe(true);
    expect(provider.verifyEvent(ctx(report, { authorization: 'Bearer tok-2' }), withToken).valid).toBe(false);
    expect(provider.verifyEvent(ctx(report, {}), withToken).valid).toBe(false);
    expect(provider.verifyEvent(ctx(report, { authorization: 'Bearer tok-1' }), undefined).valid).toBe(false);
    expect(provider.verifyEvent(ctx(STARTED, { authorization: 'Bearer tok-1', ...signed(STARTED) }), withToken).valid).toBe(true);
    expect(provider.verifyEvent(ctx(STARTED, { authorization: 'Bearer tok-1' }), withToken)).toEqual({ valid: false, error: "Zoom's signature did not verify" });
    expect(provider.verifyEvent(ctx(STARTED, signed(STARTED)), withToken).valid).toBe(false);
    expect(provider.verifyEvent(ctx(STARTED.replace('s-1', 's-2'), { authorization: 'Bearer tok-1', ...signed(STARTED) }), withToken).valid).toBe(false);
  });

  it("parses a report with a stable id, a forwarded start as joining, a host's stop as a stop command, and another stop as nothing", async () => {
    const { provider } = await setup();
    const ctx = (body: string) => ({ providerName: 'zoom-rtms', method: 'POST', url: '/events/zoom-rtms/r1', headers: {}, body, runId: 'r1' });
    expect(provider.parseEvent(ctx(JSON.stringify({ type: 'report', runId: 'r1', workerId: 'w1', seq: 7, event: 'left', at: 5, data: { reason: 'ended', seconds: 90 } }))).events).toEqual([{ eventId: 'zoom-rtms:r1:7:left', runId: 'r1', type: 'left', at: 5, data: { reason: 'ended', seconds: 90 } }]);
    expect(provider.parseEvent(ctx(STARTED)).events).toEqual([{ eventId: 'zoom-rtms:r1:s-1:started:1739923528000', runId: 'r1', type: 'joining', at: 1739923528000 }]);
    expect(provider.parseEvent(ctx(stopped(1))).events).toEqual([{ eventId: 'zoom-rtms:r1:s-1:stopped:1739923528000', runId: 'r1', type: 'stop_command', at: 1739923528000 }]);
    expect(provider.parseEvent(ctx(stopped(6))).events).toEqual([]);
    expect(() => provider.parseEvent(ctx('{"type":"report"}'))).toThrow();
    // a report's reason and word come from fixed lists: anything else does not reach the manager
    expect(() => provider.parseEvent(ctx(JSON.stringify({ type: 'report', runId: 'r1', workerId: 'w1', seq: 8, event: 'left', at: 5, data: { reason: 'ended', message: 'the host said so' } })))).toThrow();
    expect(() => provider.parseEvent(ctx(JSON.stringify({ type: 'report', runId: 'r1', workerId: 'w1', seq: 9, event: 'left', at: 5, data: { reason: 'went_home' } })))).toThrow();
    expect(() => provider.parseEvent({ ...ctx(STARTED), runId: undefined })).toThrow();
  });

  it("relays commands; a leave the worker closed needs nothing of Zoom, and one it could not close is stopped at Zoom with the owner's token", async () => {
    const closed = await setup();
    await closed.provider.command('r1', { name: 'startCapture' });
    await closed.provider.command('r1', { name: 'leave', reason: 'stopped_by_owner' });
    expect(closed.calls.map((c) => `${c.method} ${c.url}`)).toEqual(['POST https://worker.test/runs/r1/command', 'POST https://worker.test/runs/r1/command']);
    expect(JSON.parse(closed.calls[1].body!)).toEqual({ name: 'leave', reason: 'stopped_by_owner' });
    const open = await setup();
    open.state.closed = false;
    await open.provider.command('r1', { name: 'leave', reason: 'stopped_by_participant' });
    expect(open.calls.at(-2)).toMatchObject({ method: 'PATCH', url: 'https://api.zoom.us/v2/live_meetings/81234567890/rtms_app/status' });
    expect(JSON.parse(open.calls.at(-2)!.body!)).toEqual({ action: 'stop', settings: { client_id: 'client-id-1', participant_user_id: 'u-1' } });
    expect(JSON.parse(open.calls.at(-1)!.body!)).toMatchObject({ name: 'confirmClosed' });
    const gone = await setup();
    gone.state.commandStatus = 404;
    gone.state.zoom.push({ status: 400, code: 13277 });
    await expect(gone.provider.command('r1', { name: 'kill' })).rejects.toThrow('closure acknowledgement pending');
    expect(gone.calls.some((call) => call.body?.includes('confirmClosed'))).toBe(true); // REST proved closure, but recovery and final usage still need acknowledgement
    const down = await setup();
    down.state.commandStatus = 500;
    await expect(down.provider.command('r1', { name: 'startCapture' })).rejects.toThrow();
  });

  it.each([403, 429, 500])('keeps an unconfirmed stop recoverable after REST status %s', async (status) => {
    const { provider, state, calls } = await setup();
    state.closed = false;
    state.zoom.push({ status, code: 999 });
    await expect(provider.command('r1', { name: 'leave', reason: 'stopped_by_owner' })).rejects.toThrow();
    expect(calls.some((call) => call.body?.includes('confirmClosed'))).toBe(false);
    provider.close();
  });

  it('retries a durable handover after replacing the provider instance', async () => {
    const h = await setup();
    h.provider.close();
    const inbox = new MemoryDurableInbox<ZoomInboxValue>();
    const makeProvider = () => new ZoomRtmsProvider({
      clientId: 'client-id-1', webhookSecret: SECRET, workerUrl: 'https://worker.test',
      workerToken: 'client-credential', workerId: 'w1', tokens: h.tokens,
      inbox, fetchImpl: h.impl, clock: () => 1739923528000,
    });
    let provider = makeProvider();
    h.state.forwardFails = true;
    expect((await provider.handleWebhook({ headers: signed(STARTED), rawBody: STARTED })).status).toBe(200);
    await expect(provider.drainInbox()).rejects.toThrow();
    expect(await inbox.pending()).toHaveLength(1);
    provider.close();
    provider = makeProvider();
    h.state.forwardFails = false;
    await provider.drainInbox();
    expect(await inbox.pending()).toEqual([]);
    expect(h.calls.at(-1)?.body).toBe(STARTED);
    provider.close();
  });

  it('does not remove a reconnected generation for an old signed deauthorization', async () => {
    const h = await setup();
    const previous = (await h.store.get('owner-1'))!;
    const current = await h.store.put({ ...previous, createdAt: 1739923528001, updatedAt: 1739923528001 });
    const body = JSON.stringify({ event: 'app_deauthorized', event_ts: 1739923528000,
      payload: { account_id: 'a-1', user_id: 'u-1', client_id: 'client-id-1', deauthorization_time: new Date(1739923528000).toISOString() } });
    expect((await h.provider.handleWebhook({ headers: signed(body), rawBody: body })).status).toBe(200);
    await h.provider.drainInbox();
    expect(await h.store.get('owner-1')).toMatchObject({ generation: current.generation, closing: false });
    expect(h.deauthorized).toEqual([{ zoomUserId: 'u-1', connections: [] }]);
    h.provider.close();
  });

  it('never sends a chat command to the worker', async () => {
    const { provider, calls } = await setup();
    await provider.command('r1', { name: 'postChat', text: 'x' });
    expect(calls).toEqual([]);
  });

  it('deletes a run at the worker and reads usage', async () => {
    const { provider, calls } = await setup();
    expect(await provider.deleteRun({ runId: 'r1' })).toEqual({ deleted: true });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://worker.test/runs/r1' });
    expect(await provider.usage({ runIds: ['r1', 'r2', 'r3'] })).toEqual([{ runId: 'r1', alive: true, seconds: 42 }, { runId: 'r2', alive: false, seconds: 0 }, { runId: 'r3', alive: false, seconds: 9 }]);
  });

  it("answers every run's usage while one ending run's closure cannot be proved yet, and warns with its id alone", async () => {
    const h = await setup();
    const listed = [{ runId: 'r1', state: 'streaming', startedAt: 1, seconds: 42 }, { runId: 'r4', state: 'ending', startedAt: 1, seconds: 7 }];
    const impl = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url) === 'https://worker.test/runs' && (init?.method ?? 'GET') === 'GET' ? json(200, listed) : h.impl(url, init)) as typeof fetch;
    const warned: string[] = [];
    const provider = new ZoomRtmsProvider({
      clientId: 'client-id-1', webhookSecret: SECRET, workerUrl: 'https://worker.test', workerToken: 'client-credential', workerId: 'w1', tokens: h.tokens,
      api: new ZoomApi({ fetchImpl: impl }), fetchImpl: impl, runOf: async () => undefined, clock: () => 1_739_923_528_000,
      logger: { warn: (message) => { warned.push(message); } },
    });
    h.state.closed = false; // the worker cannot close r4 itself, and no run record names its meeting for a stop through Zoom's API
    expect(await provider.usage({ runIds: ['r1', 'r4'] })).toEqual([{ runId: 'r1', alive: true, seconds: 42 }, { runId: 'r4', alive: true, seconds: 7 }]);
    expect(h.calls.filter((call) => call.url === 'https://worker.test/runs/r4/command').map((call) => JSON.parse(call.body!).name)).toEqual(['kill']);
    expect(warned).toEqual(['[ZoomRtmsProvider] closure of r4 pending: stop recovery run unavailable']);
    h.provider.close();
    provider.close();
  });

  it("checks eligibility with the owner's token, and says when there is no connection", async () => {
    const { provider } = await setup();
    provider.api.me = async () => ({ id: 'u-1', email: 'd@example.test', accountId: 'a-1' });
    provider.api.meeting = async () => ({ id: '81234567890', uuid: 'm', status: 'started', hostId: 'u-1', alternativeHosts: [], invitees: [] });
    expect(await provider.eligibility('owner-1', 'https://zoom.us/j/81234567890')).toEqual({ ok: true, role: 'host' });
    expect(await provider.eligibility('nobody', 'https://zoom.us/j/81234567890')).toEqual({ ok: false, reason: 'not_connected' });
    expect(await provider.eligibility('owner-1', 'https://example.test/x')).toEqual({ ok: false, reason: 'bad_link' });
  });

  describe("Zoom's webhook, as the host's route hands it over", () => {
    it('refuses a body whose signature does not verify', async () => {
      const { provider, calls } = await setup();
      expect(await provider.handleWebhook({ headers: {}, rawBody: STARTED })).toMatchObject({ status: 401 });
      expect(await provider.handleWebhook({ headers: { ...signed(STARTED) }, rawBody: STARTED.replace('u-1', 'u-2') })).toMatchObject({ status: 401 });
      expect(calls).toEqual([]);
    });
    it('answers the endpoint validation', async () => {
      const { provider } = await setup();
      const body = '{"event":"endpoint.url_validation","event_ts":1739923528000,"payload":{"plainToken":"qgg8vlvZRS6UYooatFL8Aw"}}';
      expect(await provider.handleWebhook({ headers: signed(body), rawBody: body })).toEqual({ status: 200, body: { plainToken: 'qgg8vlvZRS6UYooatFL8Aw', encryptedToken: '5c60e2f8e51bc255c11491273f33b50f223b6f4a023f9c46fa858fa078031ddd' } });
    });
    it('answers 503 and hands nothing over when the inbox cannot keep a delivery, so Zoom sends it again', async () => {
      const h = await setup();
      h.provider.close();
      const inbox = new MemoryDurableInbox<ZoomInboxValue>();
      inbox.accept = async () => { throw new Error('the database is down'); };
      const provider = new ZoomRtmsProvider({
        clientId: 'client-id-1', webhookSecret: SECRET, workerUrl: 'https://worker.test', workerToken: 'client-credential', workerId: 'w1',
        tokens: h.tokens, inbox, fetchImpl: h.impl, clock: () => 1_739_923_528_000,
      });
      expect(await provider.handleWebhook({ headers: signed(STARTED), rawBody: STARTED })).toEqual({ status: 503, body: { error: 'durable acceptance unavailable' } });
      expect(await inbox.pending()).toEqual([]);
      expect(h.calls).toEqual([]);
      provider.close();
    });
    it("hands a stream event to the worker unchanged with Zoom's two headers, and answers 200 even when the worker cannot be reached", async () => {
      const { provider, calls, state } = await setup();
      expect(await provider.handleWebhook({ headers: signed(STARTED), rawBody: STARTED })).toEqual({ status: 200, body: { ok: true } });
      await provider.drainInbox();
      expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://worker.test/zoom/webhook', body: STARTED });
      expect(calls[0].headers).toMatchObject({ authorization: 'Bearer client-credential', ...signed(STARTED) });
      state.forwardFails = true;
      expect(await provider.handleWebhook({ headers: signed(stopped(6)), rawBody: stopped(6) })).toEqual({ status: 200, body: { ok: true } });
      await expect(provider.drainInbox()).rejects.toThrow();
      state.forwardFails = false;
      await provider.drainInbox();
      expect(calls.at(-1)?.body).toBe(stopped(6));
    });
    it("removes a user's connections when Zoom says the app was removed, and tells the host whose they were", async () => {
      const { provider, tokens, store, deauthorized } = await setup();
      await tokens.connect({ ownerRef: 'owner-2', zoomUserId: 'u-1', zoomAccountId: 'a-1', tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 9, scope: '' } });
      const generations = (await store.byZoomUser('u-1')).map(({ ownerRef, generation }) => ({ ownerRef, generation }));
      const body = JSON.stringify({ event: 'app_deauthorized', event_ts: 1739923528000,
        payload: { account_id: 'a-1', user_id: 'u-1', client_id: 'client-id-1', deauthorization_time: new Date(1739923528000).toISOString() } });
      expect(await provider.handleWebhook({ headers: signed(body), rawBody: body })).toEqual({ status: 200, body: { ok: true } });
      await provider.drainInbox();
      expect(await store.byZoomUser('u-1')).toEqual([]);
      expect(deauthorized).toEqual([{ zoomUserId: 'u-1', connections: generations }]);
      expect(await provider.handleWebhook({ headers: signed(body), rawBody: body })).toMatchObject({ status: 200 }); // a repeat changes nothing
      await provider.drainInbox();
      expect(deauthorized).toHaveLength(1);
    });
    it('answers 200 to an event it has no use for, and 400 to a signed body it cannot read', async () => {
      const { provider, calls } = await setup();
      const other = '{"event":"meeting.started","event_ts":1739923528000,"payload":{}}';
      expect(await provider.handleWebhook({ headers: signed(other), rawBody: other })).toEqual({ status: 200, body: { ok: true } });
      const broken = '{"event":"meeting.rtms_started","event_ts":1,"payload":{}}';
      expect(await provider.handleWebhook({ headers: signed(broken), rawBody: broken })).toMatchObject({ status: 400 });
      expect(calls).toEqual([]);
    });
  });
});
