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

/** A write to the beats table held until the test lets it go; `release` answers once the statement has settled. */
interface HeldWrite {
  release(): Promise<void>;
}

/** `db` with every write to `<prefix>_beats` held, in the order the package began them, until the test lets it go. */
function heldBeats(db: StorageAdapter, prefix: string): { db: StorageAdapter; held: HeldWrite[] } {
  const held: HeldWrite[] = [];
  const proxy = new Proxy(db, {
    get(target, property) {
      if (property === 'run') {
        return (...args: Parameters<StorageAdapter['run']>) => {
          if (!String(args[0]).includes(`${prefix}_beats`)) return target.run(...args);
          return new Promise<Awaited<ReturnType<StorageAdapter['run']>>>((resolve, reject) => {
            held.push({
              release() {
                const running = target.run(...args);
                running.then(resolve, reject);
                return running.then(
                  () => undefined,
                  () => undefined,
                );
              },
            });
          });
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { db: proxy as StorageAdapter, held };
}

/**
 * Lets the held writes go one at a time, the newest first, each settled before the next goes, as a
 * pool's connections can finish them; then reads `status()` until `ready` holds and nothing more is
 * held, for at most 5 seconds.
 */
async function releaseNewestFirst(
  held: HeldWrite[],
  read: () => Promise<OpsHealthStatus>,
  ready: (status: OpsHealthStatus) => boolean,
): Promise<OpsHealthStatus> {
  const until = Date.now() + 5_000;
  for (;;) {
    while (held.length > 0) await held.pop()!.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const status = await read();
    if ((held.length === 0 && ready(status)) || Date.now() > until) return status;
  }
}

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

  it("writes one job's beats in the order they were made, so a write that finishes late never puts back an older run or an older last ok time", async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 8, 5, 0));
    const gate = heldBeats(db, prefix);
    const fixture = fixtureOptions(gate.db, { prefix }, clock);
    const ops = createOperations(fixture.options);

    ops.health.beat('ordered', 'ok');
    clock.advance(MINUTE);
    const secondOk = clock.now();
    ops.health.beat('ordered', 'ok');
    clock.advance(MINUTE);
    const failedAt = clock.now();
    ops.health.beat('ordered', 'failed');

    const status = await releaseNewestFirst(gate.held, () => ops.health.status(), (read) => beatOf(read, 'ordered')?.lastAt === failedAt);
    expect(beatOf(status, 'ordered')).toEqual({ job: 'ordered', lastAt: failedAt, outcome: 'failed', lastOkAt: secondOk });
    expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
    await ops.stop();
  });

  it("holds one write and one waiting beat a job, and past beatQueue jobs at once drops a further job's beat with one ops_job line", async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 8, 6, 0));
    const gate = heldBeats(db, prefix);
    const fixture = fixtureOptions(gate.db, { prefix, limits: { beatQueue: 2 } }, clock);
    const ops = createOperations(fixture.options);

    let lastAt = 0;
    let lastOkAt = 0;
    for (let n = 0; n < 100; n += 1) {
      const outcome = n % 2 === 0 ? 'ok' : 'failed';
      lastAt = clock.now();
      if (outcome === 'ok') lastOkAt = lastAt;
      ops.health.beat('busy_one', outcome);
      clock.advance(1_000);
    }
    ops.health.beat('busy_two', 'ok');
    ops.health.beat('busy_three', 'ok');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A write a job reaches the database while the job's first is held; the hundred beats of one job wait as one.
    expect(gate.held).toHaveLength(2);
    expect(fixture.recorder.linesOf('ops_job').map((line) => [line.level, line.fields])).toEqual([['warn', { job: 'beat', outcome: 'dropped', count: 1 }]]);

    const status = await releaseNewestFirst(
      gate.held,
      () => ops.health.status(),
      (read) => beatOf(read, 'busy_one')?.lastAt === lastAt && beatOf(read, 'busy_two') !== undefined,
    );
    expect(beatOf(status, 'busy_one')).toEqual({ job: 'busy_one', lastAt, outcome: 'failed', lastOkAt });
    expect(beatOf(status, 'busy_two')).toMatchObject({ outcome: 'ok' });
    expect(beatOf(status, 'busy_three')).toBeUndefined();
    await ops.stop();
  });

  it("a beat still waiting when stop() passes its deadline writes nothing and leaves one ops_job line", async () => {
    const clock = fakeClock(Date.UTC(2026, 10, 8, 7, 0));
    const gate = heldBeats(db, prefix);
    const fixture = fixtureOptions(gate.db, { prefix }, clock);
    const ops = createOperations(fixture.options);

    const firstAt = clock.now();
    ops.health.beat('late_job', 'ok');
    clock.advance(MINUTE);
    ops.health.beat('late_job', 'failed');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The first write is held past stop()'s 3 seconds, so stop() answers with the second still waiting.
    await ops.stop();
    while (gate.held.length > 0) await gate.held.shift()!.release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await db.all<{ last_at: number | string; outcome: string }>(`SELECT last_at, outcome FROM ${prefix}_beats WHERE job = ?`, ['late_job']);
    expect(rows.map((row) => [Number(row.last_at), row.outcome])).toEqual([[firstAt, 'ok']]);
    expect(fixture.recorder.linesOf('ops_job').map((line) => [line.level, line.fields])).toEqual([['warn', { job: 'beat', outcome: 'stopped', count: 1 }]]);
  });
});
