/**
 * @fileoverview A disconnected Drive grant revoked by the revoke-only queue of `@framers/agentos-ext-account-sources`
 * with `GoogleOAuthFlow` as its revoker, on PostgreSQL when `AGENTOS_TEST_POSTGRES_URL` names a server, as CI's build
 * job does. Google's revocation address is a stand-in that answers as Google does.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { sourceDerivationSchema } from '@framers/agentos/cognition/library';
import { SealedTokenStore, type SealedBytesStore, type SealingKeys } from '@framers/agentos/auth';
import {
  SOURCE_GRANT_KEY, SourceRevocations, SqlAccountSourceSyncStore, sourceGrantNamespace, sourceRevocationSchema,
  sourceSyncCoordinatorSchema, sourceSyncSchema, type SourceSyncPolicy, type SourceSyncScope, type SourceSyncStorageBindings,
} from '@framers/agentos-ext-account-sources';
import { GoogleOAuthFlow } from '../src/index.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('drive_revocation_database_required');

/** A plainly fake web client. */
const CLIENT = { clientId: 'fake-client-id.example.test', clientSecret: 'fake-client-secret' };
/** Google's revocation address. */
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** What a person granted: the scopes of signing in and drive.file. */
const GRANTED = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file';
/** Google's answer, with status 400, to a token that is already expired or revoked. */
const ALREADY_REVOKED = { error: 'invalid_token', error_description: 'Token expired or revoked' };

const prefix = `gd_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const syncPrefix = `${prefix}_s`;
const derivationPrefix = `${prefix}_d`;
const keys: SealingKeys = { current: { id: 'fixture', key: new Uint8Array(32).fill(29) } };
const policy: SourceSyncPolicy = {
  windowMs: 30 * 86_400_000, maxRetainedDocuments: 10, maxHeldCharacters: 10_000,
  maxIndexedCharacters: 100_000, scanPageSize: 100, maxScanPages: 5, maxCandidates: 500,
  maxChangedPerLease: 100, maxHistoryPagesPerLease: 20, leaseMs: 120_000,
  pollMs: 900_000, manualMinIntervalMs: 60_000, reconcileMs: 86_400_000,
};
let now = 1_000_000;
const fields = (scope: SourceSyncScope) => [scope.tenantId, scope.ownerId, scope.connectionId];

/** Google's revocation address as a fetch stand-in: answers queued in order, each token it was asked to revoke kept. */
const answers: Array<{ status: number; body?: unknown }> = [];
const revoked: string[] = [];
const google = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (String(input) !== REVOKE_URL) throw new Error('only the revocation address is expected');
  revoked.push(new URLSearchParams(String(init?.body)).get('token') ?? '');
  const next = answers.shift();
  if (next === undefined) throw new Error('no answer queued');
  return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

/** Exercises the queue's revocation of a disconnected grant, the Drive flow revoking each token it holds. */
describe.skipIf(!url)('a disconnected Drive grant in the revoke-only queue', () => {
  let db: StorageAdapter;
  let store: SqlAccountSourceSyncStore<string>;
  let service: SourceRevocations<string>;

  /** The host's sealed values, by connection and key. */
  function values(tx: StorageAdapter, scope: SourceSyncScope): SealedBytesStore {
    return {
      get: async (key) => (await tx.get<{ sealed: string }>(`SELECT sealed FROM "${prefix}_grants"
        WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(scope), key]))?.sealed ?? null,
      set: async (key, sealed) => {
        await tx.run(`INSERT INTO "${prefix}_grants" VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(tenant_id,owner_id,connection_id,key) DO UPDATE SET sealed=excluded.sealed`, [...fields(scope), key, sealed]);
      },
      delete: async (key) => {
        await tx.run(`DELETE FROM "${prefix}_grants"
          WHERE tenant_id=$1 AND owner_id=$2 AND connection_id=$3 AND key=$4`, [...fields(scope), key]);
      },
    };
  }

  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 4 });
    await db.open();
    for (const sql of [...sourceDerivationSchema(derivationPrefix), ...sourceSyncSchema(syncPrefix),
      ...sourceSyncCoordinatorSchema(syncPrefix), ...sourceRevocationSchema(prefix)]) await db.exec(sql);
    await db.exec(`CREATE TABLE "${prefix}_grants" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,key TEXT,
      sealed TEXT,PRIMARY KEY(tenant_id,owner_id,connection_id,key))`);
    // No document is ever read here, so the host's bindings hold nothing to write or purge.
    const bindings: SourceSyncStorageBindings<string> = {
      active: async (tx, scope) => service.permits(tx, scope),
      allowance: async () => ({ maximumConnectionDocuments: 10, maximumConnectionHeldCharacters: 10_000, additionalIndexedCharacters: 100_000 }),
      write: async () => {},
      chargeIndexed: async () => {},
      purge: async () => {},
      purgeResults: async () => {},
      rebind: async () => {},
    };
    store = new SqlAccountSourceSyncStore(db, { tablePrefix: syncPrefix, derivationPrefix, bindings, clock: () => now });
    service = new SourceRevocations(db, {
      tablePrefix: prefix, store, keys, values, clock: () => now,
      revoker: (signal) => new GoogleOAuthFlow(CLIENT, null, { fetchImpl: google, signal }),
    });
  });

  afterAll(async () => {
    if (!db) return;
    for (const name of ['blocks', 'intents', 'queue', 'grant_leases', 'exchanges', 'grants']) await db.exec(`DROP TABLE IF EXISTS "${prefix}_${name}" CASCADE`);
    for (const name of ['work', 'exclusions', 'documents', 'connections']) await db.exec(`DROP TABLE IF EXISTS "${syncPrefix}_${name}" CASCADE`);
    for (const name of ['edges', 'results', 'tombstones', 'journal', 'owners']) await db.exec(`DROP TABLE IF EXISTS "${derivationPrefix}_${name}" CASCADE`);
    await db.close();
  });

  /** A connected Drive connection whose sealed grant holds `refreshToken`. */
  async function connected(refreshToken: string): Promise<SourceSyncScope> {
    const scope: SourceSyncScope = { tenantId: 'fake-tenant', ownerId: randomUUID(), connectionId: 'fake-drive' };
    await store.create(scope, policy);
    await store.control(scope, { type: 'connect_started' });
    await new SealedTokenStore(values(db, scope), keys, { namespace: sourceGrantNamespace(scope) }).save(SOURCE_GRANT_KEY,
      { accessToken: 'fake-access', expiresAt: now + 60_000, refreshToken, metadata: { scope: GRANTED } });
    await store.control(scope, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
    return scope;
  }

  /** Disconnects a connection at its current generation, queueing its grant for revocation. */
  async function disconnect(scope: SourceSyncScope): Promise<void> {
    const generation = (await store.snapshot(scope))!.state.generation;
    expect(await service.disconnect(scope, generation)).toMatchObject({ revocation: 'pending' });
  }

  it("confirms the revocation when Google answers that the person's grant is already expired or revoked", async () => {
    const scope = await connected('fake-refresh-1');
    await disconnect(scope);
    answers.push({ status: 400, body: ALREADY_REVOKED });
    expect(await service.revokeBatch()).toMatchObject({ attempted: 1, confirmed: 1, deferred: 0 });
    expect(revoked).toEqual(['fake-refresh-1']);
    expect((await service.status(scope)).revocation).toBe('confirmed');
  });

  it('keeps a revocation Google refuses for another reason pending, and confirms it once Google revokes the token', async () => {
    const scope = await connected('fake-refresh-2');
    await disconnect(scope);
    answers.push({ status: 400, body: { error: 'invalid_request', error_description: 'Bad Request' } });
    expect(await service.revokeBatch()).toMatchObject({ attempted: 1, confirmed: 0, deferred: 1 });
    expect((await service.status(scope)).revocation).toBe('pending');
    // The queue retries a minute after the first failure.
    now += 60_000;
    answers.push({ status: 200 });
    expect(await service.revokeBatch()).toMatchObject({ attempted: 1, confirmed: 1, deferred: 0 });
    expect(revoked.slice(-2)).toEqual(['fake-refresh-2', 'fake-refresh-2']);
    expect((await service.status(scope)).revocation).toBe('confirmed');
  });
});
