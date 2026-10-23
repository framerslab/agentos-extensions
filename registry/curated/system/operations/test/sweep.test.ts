import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createContext } from '../src/context.js';
import { DAY_MS, dayStartOf } from '../src/events/totals.js';
import { SWEEP_AT_MS, SWEEP_BATCH, SWEEP_JOB, createSweepJob, nextSweepRunAt } from '../src/jobs/sweep.js';
import { migrateOperations } from '../src/store/migrations.js';
import { describeBackends, dropOperationsTables, freshPrefix, type Backend } from './helpers/adapters.js';
import { fakeClock } from './helpers/clock.js';
import { fixtureOptions } from './helpers/host.js';

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR_MS = 3_600_000;
const TODAY = dayStartOf(NOW);

interface Statement {
  readonly sql: string;
  readonly changes: number;
}

interface BeatRow {
  outcome: string;
  last_at: number | string;
  last_ok_at: number | string | null;
}

/** `db` with every DELETE it runs recorded with the rows it removed, inside its transactions too. */
function recording(db: StorageAdapter, statements: Statement[]): StorageAdapter {
  const wrap = (target: StorageAdapter): StorageAdapter =>
    new Proxy(target, {
      get(object, property) {
        if (property === 'run') {
          return async (sql: string, parameters?: unknown) => {
            const result = await object.run(sql, parameters as never);
            if (/^\s*DELETE\b/i.test(sql)) statements.push({ sql, changes: result.changes });
            return result;
          };
        }
        if (property === 'transaction') {
          return (work: (trx: StorageAdapter) => Promise<unknown>, options?: unknown) =>
            object.transaction((trx) => work(wrap(trx)), options as never);
        }
        const value: unknown = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
  return wrap(db);
}

/** The rows a test seeds, each under the prefix it is given. */
function seeds(db: StorageAdapter, prefix: string) {
  const t = (name: string) => `${prefix}_${name}`;
  return {
    t,
    ticket: (id: string, state: 'open' | 'resolved' | 'closed', closedAt: number | null) =>
      db.run(
        `INSERT INTO ${t('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, closed_at, created_at, updated_at)
         VALUES (?, ?, ?, 'A subject', 'bug', 'normal', ?, 'person', ?, ?, ?)`,
        [id, `acct_${id}`, `P-${id}`, state, closedAt, NOW - 400 * DAY_MS, NOW - 400 * DAY_MS],
      ),
    message: (id: string, ticketId: string) =>
      db.run(`INSERT INTO ${t('messages')} (id, ticket_id, sender, body, created_at) VALUES (?, ?, 'person', 'A message', ?)`, [
        id,
        ticketId,
        NOW - 400 * DAY_MS,
      ]),
    picture: (id: string, ticketId: string, messageId: string) =>
      db.run(
        `INSERT INTO ${t('attachments')} (id, ticket_id, message_id, media_type, bytes, width, height, created_at)
         VALUES (?, ?, ?, 'image/webp', ?, 1, 1, ?)`,
        [id, ticketId, messageId, Buffer.from([1, 2, 3]), NOW - 400 * DAY_MS],
      ),
    group: (id: string, lastSeen: number) =>
      db.run(
        `INSERT INTO ${t('error_groups')} (id, fingerprint, origin, process, kind, state, first_seen, last_seen)
         VALUES (?, ?, 'server', 'web', 'TypeError', 'open', ?, ?)`,
        [id, `fp_${id}`, lastSeen - DAY_MS, lastSeen],
      ),
    day: (groupId: string, day: number) =>
      db.run(`INSERT INTO ${t('error_days')} (group_id, day, count) VALUES (?, ?, 1)`, [groupId, day]),
    occurrence: (id: string, groupId: string, at: number) =>
      db.run(`INSERT INTO ${t('error_events')} (id, group_id, at, process) VALUES (?, ?, ?, 'web')`, [id, groupId, at]),
    line: (id: string, at: number) =>
      db.run(`INSERT INTO ${t('log_lines')} (id, at, process, kind) VALUES (?, ?, 'web', 'request')`, [id, at]),
    event: (id: string, at: number) => db.run(`INSERT INTO ${t('events')} (id, at, kind) VALUES (?, ?, 'search')`, [id, at]),
    daily: (day: number) =>
      db.run(`INSERT INTO ${t('daily')} (day, metric, plan, value, updated_at) VALUES (?, 'signups', 'all', 1, ?)`, [day, day]),
    sample: (id: string, at: number) =>
      db.run(`INSERT INTO ${t('health_samples')} (id, at, name, state) VALUES (?, ?, 'database', 'ok')`, [id, at]),
    outage: (id: string, startedAt: number, endedAt: number | null) =>
      db.run(`INSERT INTO ${t('outages')} (id, started_at, ended_at, misses) VALUES (?, ?, ?, 1)`, [id, startedAt, endedAt]),
    ids: async (name: string, column = 'id') =>
      (await db.all<{ id: string | number }>(`SELECT ${column} AS id FROM ${t(name)} ORDER BY ${column}`)).map((row) => String(row.id)),
    beat: () => db.get<BeatRow>(`SELECT outcome, last_at, last_ok_at FROM ${t('beats')} WHERE job = ?`, [SWEEP_JOB]),
  };
}

describeBackends('the hourly sweep', (backend: Backend) => {
  let db: StorageAdapter;

  beforeAll(async () => {
    db = await backend.open();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Runs `body` over tables of its own, dropped at the end. */
  async function within(body: (prefix: string) => Promise<void>): Promise<void> {
    const prefix = freshPrefix();
    await migrateOperations(db, { prefix });
    try {
      await body(prefix);
    } finally {
      await dropOperationsTables(db, prefix);
    }
  }

  it('runs at 40 minutes past each hour (UTC), armed by start only in the process that runs the shared jobs, and ended by stop', () => {
    const hour = Date.UTC(2026, 9, 22, 12);
    expect(SWEEP_AT_MS).toBe(40 * 60_000);
    expect(nextSweepRunAt(hour)).toBe(hour + SWEEP_AT_MS);
    expect(nextSweepRunAt(hour + SWEEP_AT_MS)).toBe(hour + SWEEP_AT_MS);
    expect(nextSweepRunAt(hour + SWEEP_AT_MS + 1)).toBe(hour + HOUR_MS + SWEEP_AT_MS);

    const context = createContext(fixtureOptions(db, {}, fakeClock(NOW)).options);
    const job = createSweepJob(context);
    expect(context.timers.has(job)).toBe(true);
    job.start();
    expect(job.armed).toBe(false);
    context.shared = true;
    job.start();
    expect(job.armed).toBe(true);
    job.start();
    expect(job.armed).toBe(true);
    job.stop();
    expect(job.armed).toBe(false);
  });

  it('removes what each retention has outlived and keeps what is younger: a request a year after it closed with its messages and pictures, pictures 90 days after their request closed, an error group 90 days after it was last seen with its days, occurrences after 30 days, lines and health samples after 14 days, events after 90 days, daily rows and outages after two years', async () => {
    await within(async (prefix) => {
      const seed = seeds(db, prefix);
      await seed.ticket('tkt_old', 'closed', NOW - 366 * DAY_MS);
      await seed.message('msg_old', 'tkt_old');
      await seed.picture('pic_old', 'tkt_old', 'msg_old');
      await seed.ticket('tkt_year', 'closed', NOW - 365 * DAY_MS);
      await seed.message('msg_year', 'tkt_year');
      await seed.picture('pic_year', 'tkt_year', 'msg_year');
      await seed.ticket('tkt_recent', 'closed', NOW - 89 * DAY_MS);
      await seed.message('msg_recent', 'tkt_recent');
      await seed.picture('pic_recent', 'tkt_recent', 'msg_recent');
      await seed.ticket('tkt_open', 'open', null);
      await seed.message('msg_open', 'tkt_open');
      await seed.picture('pic_open', 'tkt_open', 'msg_open');
      await seed.ticket('tkt_resolved', 'resolved', null);

      await seed.group('grp_old', NOW - 91 * DAY_MS);
      await seed.day('grp_old', dayStartOf(NOW - 91 * DAY_MS));
      await seed.group('grp_live', NOW - 89 * DAY_MS);
      await seed.day('grp_live', dayStartOf(NOW - 200 * DAY_MS));
      await seed.occurrence('occ_31', 'grp_live', NOW - 31 * DAY_MS);
      await seed.occurrence('occ_29', 'grp_live', NOW - 29 * DAY_MS);

      await seed.line('ln_old', NOW - 14 * DAY_MS - 1);
      await seed.line('ln_edge', NOW - 14 * DAY_MS);
      await seed.line('ln_new', NOW);
      await seed.event('evt_old', NOW - 91 * DAY_MS);
      await seed.event('evt_kept', NOW - 89 * DAY_MS);
      await seed.daily(TODAY - 731 * DAY_MS);
      await seed.daily(TODAY - 729 * DAY_MS);
      await seed.sample('smp_old', NOW - 15 * DAY_MS);
      await seed.sample('smp_new', NOW - 13 * DAY_MS);
      await seed.outage('out_old', NOW - 731 * DAY_MS, NOW - 731 * DAY_MS + HOUR_MS);
      await seed.outage('out_new', NOW - 729 * DAY_MS, NOW - 729 * DAY_MS + HOUR_MS);
      await seed.outage('out_open', NOW - DAY_MS, null);

      const fixture = fixtureOptions(db, { prefix }, fakeClock(NOW));
      const run = await createSweepJob(createContext(fixture.options)).run();
      expect(run).toEqual({
        outcome: 'ok',
        removed: { requests: 1, pictures: 1, error_groups: 1, occurrences: 1, lines: 1, events: 1, daily: 1, samples: 1, outages: 1 },
        failed: [],
      });

      expect(await seed.ids('tickets')).toEqual(['tkt_open', 'tkt_recent', 'tkt_resolved', 'tkt_year']);
      expect(await seed.ids('messages')).toEqual(['msg_open', 'msg_recent', 'msg_year']);
      expect(await seed.ids('attachments')).toEqual(['pic_open', 'pic_recent']);
      expect(await seed.ids('error_groups')).toEqual(['grp_live']);
      expect(await seed.ids('error_days', 'group_id')).toEqual(['grp_live']);
      expect(await seed.ids('error_events')).toEqual(['occ_29']);
      expect(await seed.ids('log_lines')).toEqual(['ln_edge', 'ln_new']);
      expect(await seed.ids('events')).toEqual(['evt_kept']);
      expect((await seed.ids('daily', 'day')).map(Number)).toEqual([TODAY - 729 * DAY_MS]);
      expect(await seed.ids('health_samples')).toEqual(['smp_new']);
      expect(await seed.ids('outages')).toEqual(['out_new', 'out_open']);

      const beat = await seed.beat();
      expect(beat?.outcome).toBe('ok');
      expect(Number(beat?.last_at)).toBe(NOW);
      expect(Number(beat?.last_ok_at)).toBe(NOW);
      expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
    });
  });

  it('removes at most 1,000 rows a statement and goes on until the retention is done', async () => {
    await within(async (prefix) => {
      const seed = seeds(db, prefix);
      const old = 2_345;
      for (let first = 0; first < old; first += 250) {
        const rows = Array.from({ length: Math.min(250, old - first) }, (_, index) => first + index);
        await db.run(
          `INSERT INTO ${seed.t('log_lines')} (id, at, process, kind) VALUES ${rows.map(() => "(?, ?, 'web', 'request')").join(', ')}`,
          rows.flatMap((index) => [`ln_old_${String(index).padStart(5, '0')}`, NOW - 20 * DAY_MS - index]),
        );
      }
      await seed.line('ln_new_1', NOW - DAY_MS);
      await seed.line('ln_new_2', NOW);

      const statements: Statement[] = [];
      const fixture = fixtureOptions(recording(db, statements), { prefix }, fakeClock(NOW));
      const run = await createSweepJob(createContext(fixture.options)).run();
      expect(SWEEP_BATCH).toBe(1_000);
      expect(run.outcome).toBe('ok');
      expect(run.removed.lines).toBe(old);
      expect(statements.filter((statement) => statement.sql.includes(`${prefix}_log_lines`)).map((statement) => statement.changes)).toEqual([
        1_000, 1_000, 345,
      ]);
      expect(Math.max(...statements.map((statement) => statement.changes))).toBeLessThanOrEqual(SWEEP_BATCH);
      expect(await seed.ids('log_lines')).toEqual(['ln_new_1', 'ln_new_2']);
    });
  });

  it('a second process holding the sweep lock skips the run on PostgreSQL, where SQLite runs without a lock', async () => {
    await within(async (prefix) => {
      const seed = seeds(db, prefix);
      await seed.line('ln_old', NOW - 20 * DAY_MS);
      const fixture = fixtureOptions(db, { prefix }, fakeClock(NOW));
      const job = createSweepJob(createContext(fixture.options));
      expect(fixture.options.locks[1]).toBe(102);
      if (backend.name === 'postgres') {
        const other = await backend.open();
        try {
          await other.transaction(async (trx) => {
            await trx.get('SELECT pg_advisory_xact_lock(?)', [fixture.options.locks[1]]);
            const skipped = await job.run();
            expect(skipped.outcome).toBe('skipped');
            expect(skipped.failed).toEqual([]);
            expect(Object.values(skipped.removed).every((count) => count === 0)).toBe(true);
          });
        } finally {
          await other.close();
        }
        expect(await seed.ids('log_lines')).toEqual(['ln_old']);
        const beat = await seed.beat();
        expect(beat?.outcome).toBe('skipped');
        expect(beat?.last_ok_at ?? null).toBeNull();
      }
      expect((await job.run()).outcome).toBe('ok');
      expect(await seed.ids('log_lines')).toEqual([]);
      expect((await seed.beat())?.outcome).toBe('ok');
      expect(fixture.recorder.linesOf('ops_job')).toEqual([]);
    });
  });

  it('a retention whose statement fails writes one ops_job line naming it and no word of the error, the run is marked failed, and the retentions after it still land', async () => {
    await within(async (prefix) => {
      const seed = seeds(db, prefix);
      await db.exec(`DROP TABLE ${seed.t('log_lines')}`);
      await seed.event('evt_old', NOW - 91 * DAY_MS);
      await seed.sample('smp_old', NOW - 15 * DAY_MS);
      await seed.outage('out_old', NOW - 731 * DAY_MS, NOW - 731 * DAY_MS + HOUR_MS);

      const fixture = fixtureOptions(db, { prefix }, fakeClock(NOW));
      const run = await createSweepJob(createContext(fixture.options)).run();
      expect(run.outcome).toBe('failed');
      expect(run.failed).toEqual(['lines']);
      expect(run.removed).toMatchObject({ lines: 0, events: 1, samples: 1, outages: 1 });
      expect(await seed.ids('events')).toEqual([]);
      expect(await seed.ids('health_samples')).toEqual([]);
      expect(await seed.ids('outages')).toEqual([]);
      expect(fixture.recorder.linesOf('ops_job')).toEqual([
        { level: 'warn', message: 'ops_job', fields: { job: 'sweep', step: 'lines', outcome: 'failed' } },
      ]);
      expect(JSON.stringify(fixture.recorder.lines)).not.toContain('log_lines');
      expect((await seed.beat())?.outcome).toBe('failed');
    });
  });
});
