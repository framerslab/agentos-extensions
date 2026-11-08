import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { OpsBeatOutcome, OpsHealthStatus } from '../src/contract.js';
import { createOperations, migrateOperations } from '../src/index.js';
import { OpsNotBuilt } from '../src/not-built.js';
import { describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

const MINUTE = 60_000;

/** `beat` writes in the background: reads `health.status()` until `ready` holds of it, for at most 5 seconds. */
async function statusOnce(read: () => Promise<OpsHealthStatus>, ready: (status: OpsHealthStatus) => boolean): Promise<OpsHealthStatus> {
  const until = Date.now() + 5_000;
  for (;;) {
    const status = await read();
    if (ready(status) || Date.now() > until) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const beatOf = (status: OpsHealthStatus, job: string) => status.beats.find((beat) => beat.job === job);

describeBackends('health.beat and health.status().beats', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();

  beforeAll(async () => {
    db = await backend.open();
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it("beat writes the job's row and status() answers it, keeping the last ok time through a failed run; a failed first run has none", async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 8, 3, 0));
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);
    const okAt = clock.now();

    expect(ops.health.beat('nightly_backup', 'ok')).toBeUndefined();
    const first = await statusOnce(() => ops.health.status(), (status) => beatOf(status, 'nightly_backup') !== undefined);
    expect(first).toEqual({ checks: [], beats: [{ job: 'nightly_backup', lastAt: okAt, outcome: 'ok', lastOkAt: okAt }], outages: [] });

    clock.advance(5 * MINUTE);
    const failedAt = clock.now();
    ops.health.beat('x', 'failed');
    ops.health.beat('nightly_backup', 'failed');
    const second = await statusOnce(
      () => ops.health.status(),
      (status) => beatOf(status, 'x') !== undefined && beatOf(status, 'nightly_backup')?.outcome === 'failed',
    );
    expect(second.checks).toEqual([]);
    expect(second.outages).toEqual([]);
    expect(second.beats).toEqual([
      { job: 'nightly_backup', lastAt: failedAt, outcome: 'failed', lastOkAt: okAt },
      { job: 'x', lastAt: failedAt, outcome: 'failed', lastOkAt: null },
    ]);
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
    await ops.stop();
  });

  it('beat refuses a job that is not a word and an outcome that is none of the three: no row, one ops_job line each, and nothing thrown', async () => {
    const fixture = fixtureOptions(db, { prefix }, fakeClock());
    const ops = createOperations(fixture.options);
    const before = await ops.health.status();

    expect(ops.health.beat('Not A Word', 'ok')).toBeUndefined();
    expect(ops.health.beat('a'.repeat(33), 'ok')).toBeUndefined();
    expect(ops.health.beat('refused_outcome', 'passed' as OpsBeatOutcome)).toBeUndefined();
    // A beat written after the refusals lands, so the refusals had their chance to write too.
    ops.health.beat('after_refusals', 'skipped');
    const after = await statusOnce(() => ops.health.status(), (status) => beatOf(status, 'after_refusals') !== undefined);
    expect(after.beats.map((beat) => beat.job)).toEqual([...before.beats.map((beat) => beat.job), 'after_refusals'].sort());
    expect(beatOf(after, 'after_refusals')).toMatchObject({ outcome: 'skipped', lastOkAt: null });
    expect(fixture.recorder.linesOf('ops_job').map((line) => [line.level, line.fields])).toEqual([
      ['warn', { job: 'beat', outcome: 'refused', count: 1 }],
      ['warn', { job: 'beat', outcome: 'refused', count: 1 }],
      ['warn', { job: 'beat', outcome: 'refused', count: 1 }],
    ]);
    expect(JSON.stringify(fixture.recorder.lines)).not.toContain('Not A Word');
    await ops.stop();
  });

  it('check, queue, box and outage still throw not_built at the call', async () => {
    const ops = createOperations(fixtureOptions(db, { prefix }, fakeClock()).options);
    expect(() => ops.health.check('db', async () => ({ ok: true }))).toThrow(OpsNotBuilt);
    expect(() => ops.health.queue('mail', async () => null, MINUTE)).toThrow(OpsNotBuilt);
    expect(() => ops.health.box({ memoryAvailableMb: 1, swapUsedMb: 0, diskFreePercent: 50, containers: [] })).toThrow(OpsNotBuilt);
    expect(() => ops.health.outage({ watcher: 'edge', startedAt: 0, misses: 1 })).toThrow(OpsNotBuilt);
    await ops.stop();
  });

  it('stop() waits for a beat in flight, and a beat once stop() has begun writes nothing and leaves one ops_job line', async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 8, 4, 0));
    const fixture = fixtureOptions(db, { prefix }, clock);
    const ops = createOperations(fixture.options);

    ops.health.beat('before_stop', 'ok');
    const stopping = ops.stop();
    ops.health.beat('after_stop', 'ok');
    await stopping;
    ops.health.beat('after_stopped', 'ok');

    // stop() answered, so the beat it began with is written; the two after it never begin.
    const rows = await db.all<{ job: string }>(`SELECT job FROM ${prefix}_beats WHERE job IN ('before_stop', 'after_stop', 'after_stopped')`);
    expect(rows.map((row) => row.job)).toEqual(['before_stop']);
    expect(fixture.recorder.linesOf('ops_job').map((line) => [line.level, line.fields])).toEqual([
      ['warn', { job: 'beat', outcome: 'stopped', count: 1 }],
      ['warn', { job: 'beat', outcome: 'stopped', count: 1 }],
    ]);
  });
});
