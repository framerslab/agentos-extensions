import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { SecretBox, SqlDurableInbox, durableInboxDdl } from '@framers/agentos/io/channels/meetings';
import { SqlZoomTokenStore, zoomTokenStoreDdl } from '../src/sqlStore.js';
import { ZoomTokenKeeper } from '../src/tokens.js';

const POSTGRES_URL = process.env.ZOOM_RTMS_TEST_POSTGRES_URL;
const describeIfPostgres = POSTGRES_URL ? describe : describe.skip;
const PREFIX = `zt_${Date.now().toString(36)}`;

describeIfPostgres('SqlZoomTokenStore on Postgres', () => {
  let db: StorageAdapter;
  let store: SqlZoomTokenStore;
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: POSTGRES_URL!, max: 4 });
    await db.open();
    await db.exec(zoomTokenStoreDdl(PREFIX));
    await db.exec(durableInboxDdl(PREFIX));
    store = new SqlZoomTokenStore({ db, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 7)) });
  });
  afterAll(async () => {
    await db.exec(`DROP TABLE IF EXISTS ${PREFIX}_inbox`);
    await db.exec(`DROP TABLE IF EXISTS ${PREFIX}_connections`);
    await db.close();
  });
  const connection = (ownerRef: string, user = 'u-1') => ({ ownerRef, zoomUserId: user, zoomAccountId: 'a-1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 3_600_000, scope: 's1 s2', createdAt: 10, updatedAt: 10 });

  it('recovers pending deliveries from another instance and keeps acknowledged replay tombstones', async () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const first = new SqlDurableInbox<{ rawBody: string }>(db, PREFIX, box);
    const entry = { id: 'delivery-1', acceptedAt: 10, value: { rawBody: 'private-fixture' } };
    expect(await first.accept(entry)).toBe(true);
    const raw = await db.get<{ payload: string }>(`SELECT payload FROM ${PREFIX}_inbox WHERE id = ?`, [entry.id]);
    expect(raw?.payload).not.toContain('private-fixture');
    const restarted = new SqlDurableInbox<{ rawBody: string }>(db, PREFIX, box);
    expect(await restarted.pending()).toEqual([entry]);
    expect(await restarted.accept(entry)).toBe(false);
    await restarted.acknowledge(entry.id);
    const third = new SqlDurableInbox<{ rawBody: string }>(db, PREFIX, box);
    expect(await third.pending()).toEqual([]);
    expect(await third.accept(entry)).toBe(false);
  });
  it('keeps both tokens sealed at rest and opens them on read', async () => {
    expect(await store.put(connection('o1'))).toMatchObject({ ownerRef: 'o1', accessToken: 'access-1', refreshToken: 'refresh-1', expiresAt: 3_600_000, version: 1 });
    const raw = await db.get<{ access_token_sealed: string; refresh_token_sealed: string }>(`SELECT access_token_sealed, refresh_token_sealed FROM ${PREFIX}_connections WHERE owner_ref = ?`, ['o1']);
    expect(raw?.access_token_sealed).not.toContain('access-1');
    expect(raw?.refresh_token_sealed).not.toContain('refresh-1');
    expect(await store.get('o1')).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1', zoomUserId: 'u-1', scope: 's1 s2', createdAt: 10 });
    expect(await store.get('nobody')).toBeUndefined();
  });
  it('serializes two keeper instances while a successful refresh is paused before its write', async () => {
    const first = new SqlZoomTokenStore({ db, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 7)) });
    const second = new SqlZoomTokenStore({ db, tablePrefix: PREFIX, box: new SecretBox(Buffer.alloc(32, 7)) });
    await first.put(connection('leased'));
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const lease = first.withRefreshLease.bind(first);
    first.withRefreshLease = (owner, work) => lease(owner, async (locked) => {
      const rotate = locked.rotate.bind(locked);
      locked.rotate = async (...args) => { reached(); await gate; return rotate(...args); };
      return work(locked);
    });
    let calls = 0;
    const oauth = { clientId: 'client-1', clientSecret: 'secret', redirectUri: 'https://host.test/return',
      fetchImpl: (async () => {
        calls += 1;
        if (calls > 1) return new Response('{"error":"invalid_grant"}', { status: 400 });
        return new Response('{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600,"scope":""}', { status: 200 });
      }) as typeof fetch };
    const a = new ZoomTokenKeeper({ store: first, oauth, clock: () => 4_000_000 });
    const b = new ZoomTokenKeeper({ store: second, oauth, clock: () => 4_000_000 });
    const one = a.accessToken('leased');
    await entered;
    const two = b.accessToken('leased');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();
    expect(await Promise.all([one, two])).toEqual(['new-access', 'new-access']);
    expect(await second.remove('leased', 1)).toBe(false);
    expect(await second.get('leased')).toMatchObject({ version: 2, refreshToken: 'new-refresh' });
  });

  it('writes a refresh only over the version it read', async () => {
    await store.put(connection('o2'));
    const first = await store.rotate('o2', 1, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: 7_200_000, scope: 's1 s2' }, 20);
    expect(first).toMatchObject({ applied: true, connection: { accessToken: 'access-2', version: 2, updatedAt: 20 } });
    const late = await store.rotate('o2', 1, { accessToken: 'access-lost', refreshToken: 'refresh-lost', expiresAt: 9, scope: '' }, 30);
    expect(late).toMatchObject({ applied: false, connection: { accessToken: 'access-2', refreshToken: 'refresh-2', version: 2 } });
    expect(await store.rotate('nobody', 1, { accessToken: 'a', refreshToken: 'r', expiresAt: 1, scope: '' }, 1)).toBeUndefined();
  });
  it('replaces an owner\'s connection on a new connect, finds by Zoom user, and removes', async () => {
    await store.put(connection('o3', 'u-3'));
    const again = await store.put({ ...connection('o3', 'u-3b'), accessToken: 'access-new', createdAt: 50, updatedAt: 50 });
    expect(again).toMatchObject({ zoomUserId: 'u-3b', accessToken: 'access-new', version: 2, createdAt: 50 });
    await store.put(connection('o4', 'u-3b'));
    expect((await store.byZoomUser('u-3b')).map((c) => c.ownerRef).sort()).toEqual(['o3', 'o4']);
    expect(await store.remove('o3')).toBe(true);
    expect(await store.remove('o3')).toBe(false);
    expect((await store.byZoomUser('u-3b')).map((c) => c.ownerRef)).toEqual(['o4']);
  });
  it('disconnects past the hour: refreshes under the lease, revokes the live token and removes the row', async () => {
    await store.put(connection('gone'));
    const revoked: string[] = [];
    const oauth = { clientId: 'client-1', clientSecret: 'secret', redirectUri: 'https://host.test/return',
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).endsWith('/oauth/revoke')) {
          revoked.push(new URLSearchParams(String(init?.body ?? '')).get('token') ?? '');
          return new Response('{"status":"success"}', { status: 200 });
        }
        return new Response('{"access_token":"live-access","refresh_token":"live-refresh","expires_in":3600,"scope":""}', { status: 200 });
      }) as typeof fetch };
    const keeper = new ZoomTokenKeeper({ store, oauth, clock: () => 4_000_000 });
    expect(await keeper.disconnect('gone')).toBe(true);
    expect(revoked).toEqual(['live-access']);
    expect(await store.get('gone')).toBeUndefined();
  });
});
