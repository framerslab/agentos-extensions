import { describe, it, expect } from 'vitest';
import { InMemoryZoomTokenStore, ZOOM_SCOPES, ZoomNotConnectedError, ZoomTokenKeeper, missingScopes } from '../src/tokens.js';

const oauthBase = { clientId: 'client-id-1', clientSecret: 'not-a-real-secret', redirectUri: 'https://product.example.test/zoom/return' };

/** A fake of Zoom's token endpoint: each refresh answers the next pair, or the status a test set. */
function zoom() {
  const state = { refreshes: 0, fail: undefined as undefined | { status: number; error: string }, revoked: [] as string[], gate: undefined as undefined | Promise<void> };
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    if (String(url).endsWith('/oauth/revoke')) {
      state.revoked.push(form.get('token') ?? '');
      return new Response('{"status":"success"}', { status: 200 });
    }
    if (state.gate) await state.gate;
    if (state.fail) return new Response(JSON.stringify({ error: state.fail.error }), { status: state.fail.status });
    state.refreshes += 1;
    return new Response(JSON.stringify({ access_token: `access-${state.refreshes + 1}`, refresh_token: `refresh-${state.refreshes + 1}`, expires_in: 3600, scope: ZOOM_SCOPES.join(' ') }), { status: 200 });
  }) as typeof fetch;
  return { state, impl };
}

async function connected(now: { t: number }) {
  const z = zoom();
  const store = new InMemoryZoomTokenStore();
  const keeper = new ZoomTokenKeeper({ store, oauth: { ...oauthBase, fetchImpl: z.impl }, clock: () => now.t });
  await keeper.connect({ ownerRef: 'owner-1', zoomUserId: 'u-1', zoomAccountId: 'a-1', tokens: { accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: now.t + 3_600_000, scope: ZOOM_SCOPES.join(' ') } });
  return { z, store, keeper };
}

describe('ZoomTokenKeeper', () => {
  it('answers the held token while it is good for a minute more, and refreshes when it is not', async () => {
    const now = { t: 1_000_000 };
    const { z, store, keeper } = await connected(now);
    expect(await keeper.accessToken('owner-1')).toBe('access-1');
    now.t += 3_600_000 - 60_001;
    expect(await keeper.accessToken('owner-1')).toBe('access-1');
    expect(z.state.refreshes).toBe(0);
    now.t += 2;
    expect(await keeper.accessToken('owner-1')).toBe('access-2');
    expect(await store.get('owner-1')).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2', version: 2, expiresAt: now.t + 3_600_000 });
  });
  it('makes one refresh for two callers at once', async () => {
    const now = { t: 0 };
    const { z, keeper } = await connected(now);
    now.t = 3_600_000;
    let open!: () => void;
    z.state.gate = new Promise<void>((resolve) => (open = resolve));
    const both = Promise.all([keeper.accessToken('owner-1'), keeper.accessToken('owner-1')]);
    open();
    expect(await both).toEqual(['access-2', 'access-2']);
    expect(z.state.refreshes).toBe(1);
  });
  it('refreshes on demand after Zoom refused the held token', async () => {
    const now = { t: 0 };
    const { z, keeper } = await connected(now);
    expect(await keeper.accessToken('owner-1', true)).toBe('access-2');
    expect(z.state.refreshes).toBe(1);
  });
  it('removes a connection whose grant is dead and says so', async () => {
    const now = { t: 0 };
    const { z, store, keeper } = await connected(now);
    now.t = 3_600_000;
    z.state.fail = { status: 400, error: 'invalid_grant' };
    await expect(keeper.accessToken('owner-1')).rejects.toMatchObject({ name: 'ZoomNotConnectedError', why: 'dead' });
    expect(await store.get('owner-1')).toBeUndefined();
    await expect(keeper.accessToken('owner-1')).rejects.toBeInstanceOf(ZoomNotConnectedError);
  });
  it('uses the row another writer rotated first, and never removes it', async () => {
    const now = { t: 0 };
    const { z, store, keeper } = await connected(now);
    now.t = 3_600_000;
    z.state.fail = { status: 400, error: 'invalid_grant' };
    // another process refreshed between this one's read and its call: the row moved to version 2
    const held = await store.get('owner-1');
    const original = store.get.bind(store);
    let reads = 0;
    store.get = async (ownerRef: string) => {
      reads += 1;
      if (reads === 2) await store.rotate(ownerRef, held!.version, { accessToken: 'access-other', refreshToken: 'refresh-other', expiresAt: now.t + 3_600_000, scope: '' }, now.t);
      return original(ownerRef);
    };
    expect(await keeper.accessToken('owner-1')).toBe('access-other');
    expect(await original('owner-1')).toMatchObject({ version: 2 });
  });
  it('holds the shared refresh lease until the rotated pair has been written', async () => {
    const now = { t: 0 };
    const { z, store, keeper } = await connected(now);
    now.t = 3_600_000;
    let writing!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { writing = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const rotate = store.rotate.bind(store);
    store.rotate = async (...args) => { writing(); await gate; return rotate(...args); };
    const second = new ZoomTokenKeeper({ store, oauth: { ...oauthBase, fetchImpl: z.impl }, clock: () => now.t });
    const first = keeper.accessToken('owner-1');
    await entered;
    const other = second.accessToken('owner-1');
    await Promise.resolve();
    expect(z.state.refreshes).toBe(1);
    expect(await store.get('owner-1')).toMatchObject({ version: 1 });
    resume();
    expect(await Promise.all([first, other])).toEqual(['access-2', 'access-2']);
    expect(z.state.refreshes).toBe(1);
    expect(await store.get('owner-1')).toMatchObject({ refreshToken: 'refresh-2', version: 2 });
    expect(await store.remove('owner-1', 1)).toBe(false);
    expect(await store.get('owner-1')).toMatchObject({ version: 2 });
  });

  it('keeps the connection through a fault of the moment', async () => {
    const now = { t: 0 };
    const { z, store, keeper } = await connected(now);
    now.t = 3_600_000;
    z.state.fail = { status: 503, error: 'unavailable' };
    await expect(keeper.accessToken('owner-1')).rejects.toMatchObject({ name: 'ZoomOAuthError', status: 503 });
    expect(await store.get('owner-1')).toMatchObject({ version: 1 });
  });
  it('disconnects: revokes at Zoom, removes the row, and removes it even when Zoom cannot be reached', async () => {
    const now = { t: 0 };
    const { z, store, keeper } = await connected(now);
    expect(await keeper.disconnect('owner-1')).toBe(true);
    expect(z.state.revoked).toEqual(['access-1']);
    expect(await store.get('owner-1')).toBeUndefined();
    expect(await keeper.disconnect('owner-1')).toBe(false);
    const again = await connected(now);
    again.z.state.revoked = [];
    const failing = new ZoomTokenKeeper({ store: again.store, oauth: { ...oauthBase, fetchImpl: (async () => { throw new Error('unreachable'); }) as typeof fetch }, clock: () => now.t });
    expect(await failing.disconnect('owner-1')).toBe(true);
    expect(await again.store.get('owner-1')).toBeUndefined();
  });
  it('finds connections by Zoom user, and names the scopes a grant lacks', async () => {
    const now = { t: 0 };
    const { store } = await connected(now);
    expect((await store.byZoomUser('u-1')).map((c) => c.ownerRef)).toEqual(['owner-1']);
    expect(await store.byZoomUser('u-2')).toEqual([]);
    expect(missingScopes(ZOOM_SCOPES.join(' '))).toEqual([]);
    expect(missingScopes('meeting:read:meeting user:read:user')).toEqual(['meeting:read:meeting_audio', 'meeting:update:participant_rtms_app_status']);
  });
});
