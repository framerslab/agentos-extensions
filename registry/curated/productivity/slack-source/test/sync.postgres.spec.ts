/**
 * @fileoverview The Slack read end to end on PostgreSQL: the released account-source store, coordinator and quota, the
 * quota built with the Slack ceilings, and the connector against the stand-in. A connection's first sync walks its
 * channels and writes each channel-day; a signed message event, checked and parsed, queues its day and the next run
 * writes the day again with the new message; and at the unlisted tier the history method's minute defers the run. The
 * suite skips without `AGENTOS_TEST_POSTGRES_URL`, which CI sets.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { sourceDerivationSchema } from '@framers/agentos/cognition/library';
import {
  SourceQuota, SqlAccountSourceSyncStore, sourceQuotaSchema, sourceSyncCoordinatorSchema, sourceSyncSchema,
  type SourceSyncLifecycle, type SourceSyncPolicy, type SourceSyncScope, type SourceSyncStorageBindings,
} from '@framers/agentos-ext-account-sources';
import {
  SlackApi, enqueueSlackEvent, parseSlackEnvelope, slackCeilings, slackQuotaWeights, slackSourceSync, slackDayOf,
  verifySlackSignature, type SlackSourceConnectorOptions, type SlackTier,
} from '../src/index.js';
import { SlackStandin, day, tsAt } from './standin.js';

const postgresUrl = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !postgresUrl) throw new Error('slack_sync_database_required');

/** The policy of the end-to-end connection. */
const policy: SourceSyncPolicy = Object.freeze({
  windowMs: 90 * day, maxRetainedDocuments: 100, maxHeldCharacters: 1_000_000, maxIndexedCharacters: 1_000_000,
  scanPageSize: 100, maxScanPages: 5, maxCandidates: 500, maxChangedPerLease: 100, maxHistoryPagesPerLease: 50,
  leaseMs: 120_000, pollMs: 900_000, manualMinIntervalMs: 1, reconcileMs: day,
});

interface Harness {
  readonly db: StorageAdapter;
  readonly standin: SlackStandin;
  readonly scope: SourceSyncScope;
  readonly sync: ReturnType<typeof slackSourceSync<string>>;
  /** The channel-days the host holds, by source id. */
  documents(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

let open: Harness | null = null;
afterEach(async () => { await open?.close(); open = null; });

/**
 * A connection made two days ago to a workspace of two channels, on fresh tables.
 *
 * @param tier - The tier whose ceilings the quota holds.
 * @param waitMs - How long a read may wait for a method's minute; zero answers a retry at once.
 * @returns The harness.
 */
async function harness(tier: SlackTier, waitMs?: number): Promise<Harness> {
  const prefix = `slack_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
  const derivation = `${prefix}_d`; const quotaPrefix = `${prefix}_q`;
  const db = createPostgresAdapter({ connectionString: postgresUrl!, max: 8 });
  await db.open();
  for (const statement of [...sourceDerivationSchema(derivation), ...sourceSyncSchema(prefix),
    ...sourceSyncCoordinatorSchema(prefix), ...sourceQuotaSchema(quotaPrefix)]) await db.exec(statement);
  await db.exec(`CREATE TABLE "${prefix}_host" (tenant_id TEXT,owner_id TEXT,active BOOLEAN,PRIMARY KEY(tenant_id,owner_id))`);
  await db.exec(`CREATE TABLE "${prefix}_body" (tenant_id TEXT,owner_id TEXT,connection_id TEXT,source_id TEXT,body TEXT,
    PRIMARY KEY(tenant_id,owner_id,connection_id,source_id))`);
  const bindings: SourceSyncStorageBindings<string> = {
    active: async (tx, owner) => (await tx.get<{ active: boolean }>(`SELECT active FROM "${prefix}_host"
      WHERE tenant_id=$1 AND owner_id=$2`, [owner.tenantId, owner.ownerId]))?.active === true,
    allowance: async () => ({ maximumConnectionDocuments: 100, maximumConnectionHeldCharacters: 1_000_000,
      additionalIndexedCharacters: 1_000_000 }),
    write: async (tx, at, dependency, document) => {
      await tx.run(`INSERT INTO "${prefix}_body" VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,owner_id,connection_id,source_id)
        DO UPDATE SET body=excluded.body`, [at.tenantId, at.ownerId, at.connectionId, dependency.sourceId, document.read.content.text]);
    },
    chargeIndexed: async () => {},
    purge: async (tx, owner, affected) => {
      await tx.run(`DELETE FROM "${prefix}_body" WHERE tenant_id=$1 AND owner_id=$2
        AND ($3::text IS NULL OR connection_id=$3) AND ($4::text IS NULL OR source_id=$4)`,
      [owner.tenantId, owner.ownerId, affected.kind === 'owner' ? null : affected.connectionId,
        affected.kind === 'source' ? affected.sourceId : null]);
    },
    purgeResults: async () => {},
    rebind: async () => {},
  };
  const store = new SqlAccountSourceSyncStore<string>(db, { tablePrefix: prefix, derivationPrefix: derivation, bindings });
  const lifecycle: SourceSyncLifecycle = {
    recover: async () => {},
    loseGrant: async (handle, reason) => {
      if (!await store.renew(handle)) return false;
      await store.control(handle.lease.scope, { type: 'grant_lost', reason }); return true;
    },
  };
  const quota = new SourceQuota(db, { tablePrefix: quotaPrefix, ceilings: slackCeilings(tier), policy: {
    projectMinute: 1000, mailboxMinute: 1000, projectDay: 100_000, projectConcurrency: 4, mailboxConcurrency: 2,
    timeoutMs: 15_000, slotGraceMs: 20_000, weights: slackQuotaWeights() } });
  const standin = new SlackStandin(); await standin.open();
  const now = Date.now(); const connectedAt = now - 2 * day;
  standin.people.set('U0ADA', { name: 'Ada', email: null });
  standin.channel({ id: 'C0GENERAL', name: 'general', messages: [{ ts: tsAt(now - day), user: 'U0ADA', text: 'Budget is final' }] });
  standin.channel({ id: 'G0SECRET', name: 'secret', is_private: true, messages: [{ ts: tsAt(now - day + 60_000), user: 'U0ADA', text: 'Offer signed' }] });
  const api = new SlackApi({ accessToken: async () => 'xoxe.xoxb-fixture-access', quota, projectKey: 'project-a',
    mailboxKey: 'installation-a', apiOrigin: standin.origin });
  const connector: SlackSourceConnectorOptions = {
    api, connectedAt, backfillDays: null, ownBotIds: ['B0SAYSHERE'],
    permission: async () => ({ evidenceId: 'fixture-permission', retentionMs: 90 * day }),
    sourceDetailUrl: (_scope, id) => `/app/sources/slack/${id}`, revoke: async () => {},
    ...(waitMs === undefined ? {} : { waitMs }),
  };
  const scope: SourceSyncScope = { tenantId: 'tenant-a', ownerId: randomUUID(), connectionId: 'connection-a' };
  await db.run(`INSERT INTO "${prefix}_host" VALUES($1,$2,TRUE)`, [scope.tenantId, scope.ownerId]);
  await store.create(scope, policy);
  await store.control(scope, { type: 'connect_started' });
  await store.control(scope, { type: 'grant_ready', use: { searchAskEnabled: true, liveEnabled: false } });
  const sync = slackSourceSync<string>({ scope, coordinator: { store, prepare: async () => 'vectors', lifecycle },
    connector: async () => connector });
  return {
    db, standin, scope, sync,
    async documents() {
      const rows = await db.all<{ source_id: string; body: string }>(`SELECT source_id, body FROM "${prefix}_body"
        WHERE owner_id=$1 ORDER BY source_id`, [scope.ownerId]);
      return Object.fromEntries(rows.map((row) => [row.source_id, row.body]));
    },
    async close() {
      await standin.close();
      for (const suffix of ['cursors', 'work', 'exclusions', 'charges', 'documents', 'connections', 'body', 'host']) {
        await db.exec(`DROP TABLE IF EXISTS "${prefix}_${suffix}" CASCADE`);
      }
      const tables = await db.all<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE tablename LIKE $1`, [`${prefix}%`]);
      for (const table of tables) await db.exec(`DROP TABLE IF EXISTS "${table.tablename}" CASCADE`);
      await db.close();
    },
  };
}

describe.skipIf(!postgresUrl)('the Slack read on the released store, coordinator and quota', () => {
  it('writes each channel-day on the first sync, and a signed message event queues its day for the next run', async () => {
    const h = open = await harness('listed');
    expect(await h.sync.run(h.scope, 'manual')).toMatchObject({ kind: 'completed' });
    const yesterday = slackDayOf(Date.now() - day);
    expect(await h.documents()).toEqual({
      [`C0GENERAL:${yesterday}`]: expect.stringMatching(/^Ada \d{1,2}:\d{2} (AM|PM): Budget is final$/),
      [`G0SECRET:${yesterday}`]: expect.stringMatching(/^Ada \d{1,2}:\d{2} (AM|PM): Offer signed$/),
    });

    const ts = tsAt(Date.now() - day + 120_000);
    h.standin.channels.get('C0GENERAL')!.messages.push({ ts, user: 'U0ADA', text: 'And the plan' });
    const secret = 'fixture-signing-secret'; const now = Date.now();
    const { rawBody, headers } = SlackStandin.signed({ token: 'legacy', team_id: 'T0FIXTURE', type: 'event_callback',
      event_id: 'Ev0LIVE', event_time: Math.floor(now / 1000), event: { type: 'message', channel: 'C0GENERAL', user: 'U0ADA',
        text: 'And the plan', ts, event_ts: ts } }, secret, Math.floor(now / 1000));
    expect(verifySlackSignature({ headers, rawBody, signingSecret: secret, now })).toEqual({ valid: true });
    expect(await enqueueSlackEvent(h.sync, h.scope, parseSlackEnvelope(rawBody))).toMatchObject({ kind: 'queued', queued: 1 });
    const before = h.standin.calls('conversations.list').length;
    expect(await h.sync.run(h.scope, 'manual')).toMatchObject({ kind: 'completed' });
    expect((await h.documents())[`C0GENERAL:${yesterday}`]).toMatch(/Budget is final\nAda \d{1,2}:\d{2} (AM|PM): And the plan$/);
    expect(h.standin.calls('conversations.list')).toHaveLength(before);
  });

  it("defers the run on the history method's minute at the unlisted tier", async () => {
    const h = open = await harness('unlisted', 0);
    const result = await h.sync.run(h.scope, 'manual');
    expect(result).toMatchObject({ kind: 'deferred', reason: 'rate_limited' });
    expect(h.standin.calls('conversations.history')).toHaveLength(1);
    expect(h.standin.calls('conversations.list')).toHaveLength(1);
  });
});
