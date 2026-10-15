import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import {
  SourceQuota, sourceQuotaSchema, sourceRetryAt,
  type SourceQuotaPolicy, type SourceQuotaRequest,
} from '../src/sync/SourceQuota.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('source_quota_database_required');
const prefix = `sq_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
/** The compaction case's own tables, so the counts compact answers there are that case's rows alone. */
const compactPrefix = `${prefix}_c`;
const policy: SourceQuotaPolicy = {
  projectMinute: 120, mailboxMinute: 60, projectDay: 200,
  projectConcurrency: 3, mailboxConcurrency: 2,
  timeoutMs: 15_000, slotGraceMs: 15_000,
  weights: { list: 10, read: 40, changes: 2, profile: 1, labels: 1 },
};
/** One slot a project and a mailbox: an admission then proves that no earlier slot still counts. */
const single: SourceQuotaPolicy = { ...policy, projectConcurrency: 1, mailboxConcurrency: 1 };
let now = 100_000;
function request(projectKey: string, mailboxKey = 'mailbox-a', method: SourceQuotaRequest['method'] = 'read'): SourceQuotaRequest {
  return { projectKey, mailboxKey, method, attemptId: randomUUID() };
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe.skipIf(!url)('persistent source quotas', () => {
  let db: StorageAdapter; let other: StorageAdapter;
  let quota: SourceQuota; let peer: SourceQuota;
  beforeAll(async () => {
    db = createPostgresAdapter({ connectionString: url!, max: 8 });
    other = createPostgresAdapter({ connectionString: url!, max: 8 });
    await db.open(); await other.open();
    for (const sql of sourceQuotaSchema(prefix)) await db.exec(sql);
    quota = new SourceQuota(db, { tablePrefix: prefix, policy, clock: async () => now });
    peer = new SourceQuota(other, { tablePrefix: prefix, policy, clock: async () => now });
  });
  afterAll(async () => {
    if (!db) return;
    for (const tablePrefix of [prefix, compactPrefix]) {
      for (const suffix of ['attempts', 'mailboxes', 'projects', 'pm_reservations', 'pm_meter',
        'mm_reservations', 'mm_meter', 'pd_reservations', 'pd_meter']) {
        await db.exec(`DROP TABLE IF EXISTS "${tablePrefix}_${suffix}" CASCADE`);
      }
    }
    await db.close(); await other.close();
  });

  it('admits only one competing weighted read when the mailbox has sixty units', async () => {
    const project = randomUUID(); let sent = 0;
    const run = () => { sent++; return Promise.resolve('ok'); };
    const results = await Promise.all([quota.run(request(project), run), peer.run(request(project), run)]);
    expect(results.filter((r) => r.kind === 'completed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'deferred')).toHaveLength(1);
    expect(sent).toBe(1);
    expect(results.find((r) => r.kind === 'deferred')).toMatchObject({ reason: 'mailbox_minute' });
  });

  it('rolls back the project meter if the mailbox or day meter denies the same attempt', async () => {
    const project = randomUUID();
    await quota.run(request(project), async () => 'first');
    const denied = request(project);
    expect(await peer.run(denied, async () => 'must-not-send')).toMatchObject({ kind: 'deferred', reason: 'mailbox_minute' });
    for (const suffix of ['pm', 'mm', 'pd']) {
      expect(await db.get(`SELECT operation_id FROM "${prefix}_${suffix}_reservations" WHERE operation_id=$1`,
        [denied.attemptId])).toBeNull();
    }
    expect(await db.get(`SELECT attempt_id FROM "${prefix}_attempts" WHERE attempt_id=$1`, [denied.attemptId])).toBeNull();
    for (let n = 0; n < 4; n++) {
      now += 60_001;
      expect(await quota.run(request(project), async () => 'ok')).toMatchObject({ kind: 'completed' });
    }
    now += 60_001;
    const next = request(project);
    expect(await quota.run(next, async () => 'must-not-send')).toMatchObject({
      kind: 'deferred', reason: 'project_day', retryAt: 86_400_000,
    });
    expect(await db.get(`SELECT operation_id FROM "${prefix}_pm_reservations" WHERE operation_id=$1`, [next.attemptId])).toBeNull();
  });

  it('shares project and mailbox slots between pools and releases them after body consumption', async () => {
    const project = randomUUID(); const entered = [gate(), gate(), gate()]; const finish = gate();
    const start = (mailbox: string, index: number, worker: SourceQuota) => worker.run(
      request(project, mailbox, 'profile'), async () => { entered[index]!.resolve(); await finish.promise; return index; });
    const one = start('mailbox-a', 0, quota); await entered[0]!.promise;
    const two = start('mailbox-a', 1, peer); await entered[1]!.promise;
    expect(await quota.run(request(project, 'mailbox-a', 'profile'), async () => 'forbidden'))
      .toMatchObject({ kind: 'deferred', reason: 'mailbox_concurrency' });
    const three = start('mailbox-b', 2, quota); await entered[2]!.promise;
    expect(await peer.run(request(project, 'mailbox-c', 'profile'), async () => 'forbidden'))
      .toMatchObject({ kind: 'deferred', reason: 'project_concurrency' });
    finish.resolve(); expect((await Promise.all([one, two, three])).every((r) => r.kind === 'completed')).toBe(true);
    expect(await peer.run(request(project, 'mailbox-c', 'profile'), async () => 'ok')).toMatchObject({ kind: 'completed' });
  });

  it('never sends a duplicate id or refunds units on a failed network attempt', async () => {
    const project = randomUUID(); const first = request(project);
    await expect(quota.run(first, async () => { throw new Error('synthetic_transport_failure'); }))
      .rejects.toThrow('synthetic_transport_failure');
    let sent = false;
    expect(await peer.run(first, async () => { sent = true; })).toMatchObject({ kind: 'duplicate' });
    expect(sent).toBe(false);
    expect(await peer.run(request(project), async () => 'forbidden')).toMatchObject({ kind: 'deferred', reason: 'mailbox_minute' });
  });

  it('answers a call that misses its send window as late, keeps its units spent and admits a fresh attempt', async () => {
    const project = randomUUID(); const start = now; let reads = 0; let sent = false;
    // The second clock reading, the one that starts the call, lands past the reservation's one-second send window.
    const slow = new SourceQuota(db, { tablePrefix: prefix, policy: single,
      clock: async () => (++reads === 2 ? start + 1001 : start) });
    const missed = request(project, 'mailbox-a', 'profile');
    expect(await slow.run(missed, async () => { sent = true; })).toEqual({ kind: 'late', retryAt: start + 2001 });
    expect(sent).toBe(false);
    const spent = await db.get<{ state: string }>(`SELECT state FROM "${prefix}_pd_reservations" WHERE operation_id=$1`,
      [missed.attemptId]);
    expect(spent?.state).toBe('consumed');
    const worker = new SourceQuota(other, { tablePrefix: prefix, policy: single, clock: async () => now });
    expect(await worker.run(missed, async () => 'forbidden')).toEqual({ kind: 'duplicate' });
    // One slot a mailbox: the fresh attempt is admitted only because the late one gave its slot back.
    expect(await worker.run(request(project, 'mailbox-a', 'profile'), async () => 'ok'))
      .toEqual({ kind: 'completed', value: 'ok' });
  });

  it('honors an unclamped persisted provider wait after worker replacement and shorter updates', async () => {
    const project = randomUUID(); const until = now + 3 * 86_400_000;
    await quota.defer({ projectKey: project, mailboxKey: 'mailbox-a' }, until);
    await peer.defer({ projectKey: project, mailboxKey: 'mailbox-a' }, now + 1_000);
    expect(await peer.run(request(project), async () => 'forbidden')).toMatchObject({ kind: 'deferred', retryAt: until });
    expect(await quota.run(request(project, 'mailbox-b', 'profile'), async () => 'ok')).toMatchObject({ kind: 'completed' });
    await quota.defer({ projectKey: project }, until + 1_000);
    expect(await peer.run(request(project, 'mailbox-b'), async () => 'forbidden')).toMatchObject({ retryAt: until + 1_000 });
    now = until + 1_000;
    expect(await peer.run(request(project), async () => 'ok')).toMatchObject({ kind: 'completed' });
  });

  it('does not forget an ambiguous attempt when a process dies or a slot expires', async () => {
    // One slot a project: the admission after expiry passes only because the expired slot no longer counts.
    const dying = new SourceQuota(db, { tablePrefix: prefix, policy: single, clock: async () => now });
    const survivor = new SourceQuota(other, { tablePrefix: prefix, policy: single, clock: async () => now });
    const project = randomUUID(); const entered = gate(); const finish = gate(); const start = now;
    const original = request(project, 'mailbox-a', 'profile');
    const pending = dying.run(original, async () => { entered.resolve(); await finish.promise; return 'done'; });
    await entered.promise;
    expect(await survivor.run(request(project, 'mailbox-b', 'profile'), async () => 'forbidden')).toEqual({
      kind: 'deferred', reason: 'project_concurrency', retryAt: start + 1000 + single.timeoutMs + single.slotGraceMs,
    });
    now += single.timeoutMs + single.slotGraceMs + 1001;
    expect(await survivor.run(original, async () => 'forbidden')).toMatchObject({ kind: 'duplicate' });
    expect(await survivor.run(request(project, 'mailbox-b', 'profile'), async () => 'ok')).toMatchObject({ kind: 'completed' });
    finish.resolve(); await pending;
    const row = await db.get<{ state: string }>(`SELECT state FROM "${prefix}_pd_reservations" WHERE operation_id=$1`, [original.attemptId]);
    expect(row?.state).toBe('consumed');
  });

  it('compacts old attempt keys without erasing daily project totals and says when more remain', async () => {
    for (const sql of sourceQuotaSchema(compactPrefix)) await db.exec(sql);
    const compacting = new SourceQuota(db, { tablePrefix: compactPrefix, policy, clock: async () => now });
    const project = randomUUID(); const first = request(project, 'mailbox-a', 'profile');
    await compacting.run(first, async () => true);
    await compacting.defer({ projectKey: project, mailboxKey: 'mailbox-a' }, now + 1);
    now += 2 * 86_400_000;
    // The attempt, the passed wait, its reservation in each of the three meters and the two minute budgets' rows.
    expect(await compacting.compact()).toEqual({ attempts: 1, mailboxWaits: 1, reservations: 3, windows: 2, more: false });
    expect(await db.get(`SELECT attempt_id FROM "${compactPrefix}_attempts" WHERE attempt_id=$1`, [first.attemptId])).toBeNull();
    const total = await db.get<{ used: string }>(`SELECT SUM(used) AS used FROM "${compactPrefix}_pd_meter" WHERE account_id=$1`,
      [JSON.stringify([project])]);
    expect(Number(total?.used)).toBe(1);
    // More than a page left in one table: the call says so, and the next one takes the rest.
    await db.run(`INSERT INTO "${compactPrefix}_attempts"(attempt_id,project_key,mailbox_key,token,send_by,expires_at,finished)
      SELECT 'expired-' || n,'project-x','mailbox-x','token-x',0,1,TRUE FROM generate_series(1,1001) AS n`);
    expect(await compacting.compact()).toEqual({ attempts: 1000, mailboxWaits: 0, reservations: 0, windows: 0, more: true });
    expect(await compacting.compact()).toEqual({ attempts: 1, mailboxWaits: 0, reservations: 0, windows: 0, more: false });
  });

  it('reads the database clock in epoch milliseconds when no clock is given', async () => {
    const live = new SourceQuota(db, { tablePrefix: prefix, policy });
    const attempt = request(randomUUID(), 'mailbox-a', 'profile');
    const before = Date.now();
    expect(await live.run(attempt, async () => 'ok')).toEqual({ kind: 'completed', value: 'ok' });
    const after = Date.now();
    const row = await db.get<{ send_by: string | number }>(`SELECT send_by FROM "${prefix}_attempts" WHERE attempt_id=$1`,
      [attempt.attemptId]);
    // The send window closes a second after the reservation's reading of the database clock, which shares this host's.
    const reservedAt = Number(row?.send_by) - 1000;
    expect(reservedAt).toBeGreaterThanOrEqual(before - 60_000);
    expect(reservedAt).toBeLessThanOrEqual(after + 60_000);
  });

  it('fails closed with a fixed error on storage loss and refuses inconsistent worker policies', async () => {
    const project = randomUUID();
    await quota.run(request(project, 'mailbox-a', 'profile'), async () => true);
    const wrong = new SourceQuota(other, { tablePrefix: prefix, policy: { ...policy, projectMinute: 121 }, clock: async () => now });
    await expect(wrong.run(request(project), async () => true)).rejects.toThrow('source_sync_storage_unavailable');
    const closed = createPostgresAdapter({ connectionString: url!, max: 1 });
    let called = false;
    await expect(new SourceQuota(closed, { tablePrefix: prefix, policy }).run(request(project), async () => { called = true; }))
      .rejects.toThrow('source_sync_storage_unavailable');
    expect(called).toBe(false);
  });
});

it('computes bounded jitter while preserving long Retry-After and rejects unsafe clocks', () => {
  const start = 100_000;
  expect(sourceRetryAt(start, 1, null, 0)).toBe(start + 1000);
  expect(sourceRetryAt(start, 5, null, 1)).toBe(start + 32_000);
  expect(sourceRetryAt(start, 1, '259200', 0)).toBe(start + 259_200_000);
  const date = new Date(start + 86_400_000).toUTCString();
  expect(sourceRetryAt(start, 2, date, 0)).toBe(start + 86_400_000);
  expect(sourceRetryAt(start, 1, 'bad-header', 0)).toBe(start + 1000);
  expect(() => sourceRetryAt(start, 0, null, 0)).toThrow('source_sync_invalid_response');
  expect(() => sourceRetryAt(start, 1, '9'.repeat(50), 0)).toThrow('source_sync_invalid_response');
});
