import { describe, it, expect } from 'vitest';
import { ZoomApi, ZoomApiError } from '../src/api.js';

function fake(answers: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string | undefined }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', headers: (init?.headers ?? {}) as Record<string, string>, body: typeof init?.body === 'string' ? init.body : undefined });
    const next = answers.shift() ?? { status: 500 };
    return next.body === undefined ? new Response(null, { status: next.status }) : new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, impl };
}

describe('ZoomApi', () => {
  it('reads the user', async () => {
    const f = fake([{ status: 200, body: { id: 'u-1', email: 'USER@Example.test', account_id: 'a-1', first_name: 'Sender' } }]);
    expect(await new ZoomApi({ fetchImpl: f.impl }).me('access-1')).toEqual({ id: 'u-1', email: 'USER@Example.test', accountId: 'a-1' });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.zoom.us/v2/users/me', method: 'GET', headers: { authorization: 'Bearer access-1' } });
  });
  it('reads a meeting with its host, alternative hosts and invitees', async () => {
    const f = fake([{ status: 200, body: { id: 81234567890, uuid: 'm-uuid', status: 'started', host_id: 'u-1', settings: { alternative_hosts: 'alt@example.test; u-7', meeting_invitees: [{ email: 'inv@example.test' }, {}] } } }]);
    expect(await new ZoomApi({ fetchImpl: f.impl }).meeting('access-1', '81234567890')).toEqual({ id: '81234567890', uuid: 'm-uuid', status: 'started', hostId: 'u-1', alternativeHosts: ['alt@example.test', 'u-7'], invitees: ['inv@example.test'] });
    expect(f.calls[0].url).toBe('https://api.zoom.us/v2/meetings/81234567890');
  });
  it('reads a meeting that names no alternative host and no invitee', async () => {
    const f = fake([{ status: 200, body: { id: 81234567890, uuid: 'm-uuid', status: 'waiting', host_id: 'u-1' } }]);
    expect(await new ZoomApi({ fetchImpl: f.impl }).meeting('t', '81234567890')).toMatchObject({ status: 'waiting', alternativeHosts: [], invitees: [] });
  });
  it("starts and stops a participant's stream", async () => {
    const f = fake([{ status: 204 }, { status: 204 }]);
    const api = new ZoomApi({ fetchImpl: f.impl, baseUrl: 'http://127.0.0.1:9421/v2' });
    await api.setRtmsStatus('access-1', '81234567890', 'start', { clientId: 'client-id-1', participantUserId: 'u-1' });
    await api.setRtmsStatus('access-1', '81234567890', 'stop', { clientId: 'client-id-1', participantUserId: 'u-1' });
    expect(f.calls[0]).toMatchObject({ url: 'http://127.0.0.1:9421/v2/live_meetings/81234567890/rtms_app/status', method: 'PATCH' });
    expect(JSON.parse(f.calls[0].body!)).toEqual({ action: 'start', settings: { client_id: 'client-id-1', participant_user_id: 'u-1' } });
    expect(JSON.parse(f.calls[1].body!)).toMatchObject({ action: 'stop' });
  });
  it("throws the status and Zoom's code, and never Zoom's words", async () => {
    const f = fake([{ status: 403, body: { code: 2308, message: "User 'u-1' is not allowed to start the RTMS app." } }, { status: 502, body: 'bad gateway' }]);
    const api = new ZoomApi({ fetchImpl: f.impl });
    const refused = await api.setRtmsStatus('t', '81234567890', 'start', { clientId: 'c', participantUserId: 'u-1' }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ZoomApiError);
    expect(refused).toMatchObject({ status: 403, code: 2308 });
    expect((refused as Error).message).not.toContain('u-1');
    await expect(api.me('t')).rejects.toMatchObject({ status: 502, code: undefined });
  });
});
