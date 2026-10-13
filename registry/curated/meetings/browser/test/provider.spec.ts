import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { hashWorkerToken } from '@framers/agentos/io/channels/meetings';
import { BrowserMeetingProvider } from '../src/BrowserMeetingProvider.js';

const run = (hash: string) => ({ runId: 'r1', ownerRef: 'a', providerName: 'browser', platform: 'google_meet' as const, state: 'in_call' as const, keep: 'none' as const, meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0, dispatch: { roomName: 'bot-r1', workerTokenHash: hash } });

describe('BrowserMeetingProvider', () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/capacity')) return new Response(JSON.stringify({ workerId: 'w1', slots: 4, busy: 4, paused: false }), { status: 200 });
      if (url.endsWith('/runs') && init.method === 'POST') return new Response(JSON.stringify({ runId: 'r1', state: 'starting', startedAt: 1, seconds: 0 }), { status: 201 });
      if (url.endsWith('/runs') && init.method === 'GET') return new Response(JSON.stringify([{ runId: 'r1', state: 'running', startedAt: 1, seconds: 42 }]), { status: 200 });
      return new Response('{}', { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const provider = () => new BrowserMeetingProvider({ schedulerUrl: 'https://worker.test', schedulerToken: 'client-credential', workerId: 'w1' });

  it('declares a chat-stop participant that records nothing', () => {
    expect(provider().capabilities).toEqual({ joinsAsParticipant: true, postsChat: true, readsChat: true, audioPath: 'livekit_room', recordsAudio: false, transcribes: false, keeps: 'nothing', stopPath: 'chat' });
    expect(provider().platforms).toEqual(['google_meet', 'microsoft_teams']);
  });
  it('checks join urls against each platform\'s hosts and refuses the rest', () => {
    const p = provider();
    expect(p.checkJoinUrl('https://meet.google.com/abc-defg-hij')).toEqual({ ok: true, platform: 'google_meet' });
    expect(p.checkJoinUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x/0?context=%7b%7d')).toEqual({ ok: true, platform: 'microsoft_teams' });
    expect(p.checkJoinUrl('https://teams.live.com/meet/9876543210?p=abc')).toEqual({ ok: true, platform: 'microsoft_teams' });
    expect(p.checkJoinUrl('http://meet.google.com/abc-defg-hij').ok).toBe(false);
    expect(p.checkJoinUrl('https://meet.google.com.evil.test/abc-defg-hij').ok).toBe(false);
    expect(p.checkJoinUrl('https://zoom.us/j/123').ok).toBe(false);
    expect(p.checkJoinUrl('https://10.0.0.1/abc-defg-hij').ok).toBe(false);
  });
  it('dispatches to the scheduler with the client credential and the job, and reads the worker id', async () => {
    const p = provider();
    const r = await p.dispatch({ run: run('h'), room: { url: 'wss://lk.test', name: 'bot-r1', publishToken: 'jwt' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/events/browser/r1' });
    expect(r).toEqual({ workerId: 'w1', providerRunRef: 'r1' });
    const post = calls.find((c) => c.url === 'https://worker.test/runs')!;
    expect((post.init.headers as Record<string, string>).authorization).toBe('Bearer client-credential');
    const body = JSON.parse(post.init.body as string);
    expect(body).toMatchObject({ runId: 'r1', platform: 'google_meet', livekit: { url: 'wss://lk.test', token: 'jwt', identity: 'bot' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/events/browser/r1' });
  });
  it('throws NoCapacityError on a 409 from the scheduler', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no slot"}', { status: 409 })));
    await expect(provider().dispatch({ run: run('h'), room: { url: 'wss://lk.test', name: 'bot-r1', publishToken: 'jwt' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/e' })).rejects.toMatchObject({ name: 'NoCapacityError' });
  });
  it('verifies a report by the run token and parses it with a stable id', () => {
    const p = provider();
    const body = JSON.stringify({ type: 'report', runId: 'r1', workerId: 'w1', seq: 7, event: 'chat_message', at: 5, data: { text: 'hello', sender: 'Sam' } });
    const ctx = { providerName: 'browser', method: 'POST', url: '/events/browser/r1', headers: { authorization: 'Bearer tok-1' }, body, runId: 'r1' };
    expect(p.verifyEvent(ctx, run(hashWorkerToken('tok-1'))).valid).toBe(true);
    expect(p.verifyEvent(ctx, run(hashWorkerToken('tok-2'))).valid).toBe(false);
    expect(p.verifyEvent({ ...ctx, headers: {} }, run(hashWorkerToken('tok-1'))).valid).toBe(false);
    expect(p.parseEvent(ctx).events).toEqual([{ eventId: 'browser:r1:7:chat_message', runId: 'r1', type: 'chat_message', at: 5, data: { text: 'hello', sender: 'Sam' } }]);
    expect(() => p.parseEvent({ ...ctx, body: '{"type":"report"}' })).toThrow();
  });
  it('sends commands, deletes, and reads usage', async () => {
    const p = provider();
    await p.command('r1', { name: 'postChat', text: 'hi' });
    expect(calls.at(-1)).toMatchObject({ url: 'https://worker.test/runs/r1/command' });
    expect(JSON.parse(calls.at(-1)!.init.body as string)).toEqual({ name: 'postChat', text: 'hi' });
    expect(await p.deleteRun({ runId: 'r1' })).toEqual({ deleted: false });
    expect(await p.usage({ runIds: ['r1', 'r2'] })).toEqual([{ runId: 'r1', alive: true, seconds: 42 }, { runId: 'r2', alive: false, seconds: 0 }]);
  });
  it('deletes through the scheduler, takes a run it no longer holds as gone, and throws on any other answer so a purge tries again', async () => {
    await provider().deleteRun({ runId: 'r1' });
    const del = calls.at(-1)!;
    expect(del.url).toBe('https://worker.test/runs/r1');
    expect(del.init).toMatchObject({ method: 'DELETE', redirect: 'error' });
    expect((del.init.headers as Record<string, string>).authorization).toBe('Bearer client-credential');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"no such run"}', { status: 404 })));
    await expect(provider().deleteRun({ runId: 'r1' })).resolves.toEqual({ deleted: false });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 502 })));
    await expect(provider().deleteRun({ runId: 'r1' })).rejects.toThrow('scheduler refused the delete: 502');
  });
});
