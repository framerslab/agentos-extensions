import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dialectOf, migrateTriggers, triggersMigrations } from '../src/store/migrations.js';
import { requirePrefix, triggersTables } from '../src/store/prefix.js';
import { MIGRATION_FILES } from '../src/store/sql/index.js';
import { type Backend, describeBackends, dropTriggersTables, freshPrefix, sqlite } from './helpers/adapters.js';

/** Every column of the three tables and the ledger, by table, without the prefix. */
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  jobs: ['name', 'title', 'process', 'kind', 'schedule', 'schedule_words', 'rule', 'stall_after_ms', 'safe_to_repeat', 'retries', 'timeout_ms', 'legal_duty', 'enabled', 'paused_by', 'paused_at', 'paused_note', 'next_due_at', 'lease_holder', 'lease_token', 'lease_until', 'last_run_at', 'last_outcome', 'last_ms', 'last_did', 'tries', 'retry_at', 'failed_at', 'failed_kind', 'alerted_at', 'hand_run_by', 'hand_run_at', 'stall_since', 'stall_ref', 'registered_at', 'updated_at'],
  runs: ['id', 'job', 'started_at', 'ended_at', 'outcome', 'ms', 'tries', 'kind', 'did', 'by_hand', 'covers_from', 'covers_to', 'lease_token'],
  missed: ['id', 'job', 'due_at', 'cause', 'action', 'acted_at', 'run_id'],
  schema_migrations: ['name', 'checksum', 'applied_at'],
};

/** The columns that hold a time or a span in milliseconds, by table: BIGINT on PostgreSQL, since an epoch time passes 32 bits. */
const TIME_COLUMNS: Readonly<Record<'jobs' | 'runs' | 'missed', readonly string[]>> = {
  jobs: ['stall_after_ms', 'timeout_ms', 'paused_at', 'next_due_at', 'lease_until', 'last_run_at', 'last_ms', 'retry_at', 'failed_at', 'alerted_at', 'hand_run_at', 'stall_since', 'registered_at', 'updated_at'],
  runs: ['started_at', 'ended_at', 'ms', 'covers_from', 'covers_to'],
  missed: ['due_at', 'acted_at'],
};

/** Each index the tables carry beside their primary keys: its table, whether it is unique, its columns in order. */
const INDEXES: Readonly<Record<string, { readonly table: string; readonly unique: boolean; readonly columns: readonly string[] }>> = {
  jobs_next_due_at: { table: 'jobs', unique: false, columns: ['next_due_at'] },
  runs_job_started_at: { table: 'runs', unique: false, columns: ['job', 'started_at'] },
  missed_job_due_at: { table: 'missed', unique: true, columns: ['job', 'due_at'] },
};

/** One index of `table` by its full name, read from the backend's catalog: whether it is unique and its columns in order. */
async function readIndex(db: StorageAdapter, backend: Backend, table: string, name: string): Promise<{ unique: boolean; columns: string[] } | undefined> {
  if (backend.name === 'postgres') {
    const row = await db.get<{ definition: string }>('SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ? AND indexname = ?', [table, name]);
    if (row === null || row === undefined) return undefined;
    return {
      unique: /^CREATE UNIQUE INDEX/.test(row.definition),
      columns: (/\(([^)]*)\)/.exec(row.definition)?.[1] ?? '').split(',').map((column) => column.trim()),
    };
  }
  const list = await db.all<{ name: string; unique: number }>('SELECT name, "unique" FROM pragma_index_list(?)', [table]);
  const entry = list.find((item) => item.name === name);
  if (entry === undefined) return undefined;
  const columns = await db.all<{ name: string }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [name]);
  return { unique: entry.unique === 1, columns: columns.map((column) => column.name) };
}

describe('the SQL as text', () => {
  it('matches the readable files, dialect by dialect', () => {
    for (const file of MIGRATION_FILES) {
      for (const dialect of ['postgres', 'sqlite'] as const) {
        expect(file[dialect]).toBe(readFileSync(new URL(`../src/store/sql/${dialect}/${file.name}`, import.meta.url), 'utf8'));
      }
    }
  });

  it('keeps the SQLite text the PostgreSQL text with INTEGER for BIGINT and its first line naming SQLite', () => {
    for (const file of MIGRATION_FILES) {
      expect(file.postgres.startsWith('-- The triggers tables on PostgreSQL.')).toBe(true);
      expect(file.sqlite).toBe(file.postgres.replaceAll('BIGINT', 'INTEGER').replace('-- The triggers tables on PostgreSQL.', '-- The triggers tables on SQLite.'));
    }
  });

  it('writes the prefix into every statement and refuses a prefix outside the rule', () => {
    expect(triggersMigrations('postgres', 'a')[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS a_jobs');
    expect(triggersMigrations('sqlite')[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS trig_jobs');
    for (const dialect of ['postgres', 'sqlite'] as const) {
      expect(triggersMigrations(dialect, 'a')[0]?.sql).not.toContain('{{prefix}}');
    }
    expect(triggersMigrations('sqlite', 'a')[0]?.sql).not.toContain('BIGINT');
    expect(() => requirePrefix('Trig')).toThrow(RangeError);
    expect(() => requirePrefix(`a${'b'.repeat(33)}`)).toThrow(RangeError);
    expect(() => triggersMigrations('sqlite', 'sqlite_x')).toThrow(RangeError);
    expect(triggersMigrations('postgres', 'sqlite_x')[0]?.sql).toContain('sqlite_x_jobs');
    expect(dialectOf({ kind: 'postgres' })).toBe('postgres');
    expect(dialectOf({ kind: 'supabase-postgres' })).toBe('postgres');
    expect(dialectOf({ kind: 'sqljs' })).toBe('sqlite');
  });
});

describe('migrateTriggers refuses a prefix outside the rule before any statement', () => {
  const stub = (kind: string) => {
    let statements = 0;
    const touch = async () => {
      statements += 1;
      throw new Error('a statement ran');
    };
    const db = { kind, capabilities: new Set(), run: touch, get: touch, all: touch, exec: touch, transaction: touch, open: touch, close: touch } as unknown as StorageAdapter;
    return { db, count: () => statements };
  };

  it('throws a RangeError and runs nothing, on either dialect', async () => {
    for (const prefix of ['Trig', '1trig', 'trig-x', 'trig x', 'trig;drop', `a${'b'.repeat(33)}`, '']) {
      for (const kind of ['sqljs', 'postgres']) {
        const { db, count } = stub(kind);
        await expect(migrateTriggers(db, { prefix })).rejects.toBeInstanceOf(RangeError);
        expect(count()).toBe(0);
      }
    }
  });

  it('on SQLite, refuses sqlite and a prefix beginning sqlite_ before any statement, and takes them on PostgreSQL', async () => {
    for (const prefix of ['sqlite', 'sqlite_x']) {
      const { db, count } = stub('sqljs');
      await expect(migrateTriggers(db, { prefix })).rejects.toBeInstanceOf(RangeError);
      expect(count()).toBe(0);
      expect(triggersMigrations('postgres', prefix)[0]?.sql).toContain(`CREATE TABLE IF NOT EXISTS ${prefix}_jobs`);
    }
    expect(triggersMigrations('sqlite', 'sqlites')[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS sqlites_jobs');
  });

  it('takes the longest prefix, 33 characters, and a trailing underscore, every name staying inside 63 bytes', () => {
    const longest = `a${'b'.repeat(32)}`;
    expect(requirePrefix(longest)).toBe(longest);
    expect(requirePrefix('trig_')).toBe('trig_');
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const sql = triggersMigrations(dialect, longest)[0]?.sql ?? '';
      const names = [...sql.matchAll(/CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/g)].map((match) => match[1] ?? '');
      expect(names).toHaveLength(6);
      expect(Math.max(...names.map((name) => name.length), `${longest}_schema_migrations`.length)).toBeLessThanOrEqual(63);
    }
  });
});

describe('migrateTriggers with no prefix', () => {
  it('builds the tables and the ledger under trig', async () => {
    const db = await sqlite.open();
    try {
      const report = await migrateTriggers(db);
      expect(report.applied).toEqual(['0001_triggers.sql']);
      const tables = await db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
      expect(tables.map((row) => row.name).filter((name) => name.startsWith('trig_'))).toEqual([...triggersTables('trig')].sort());
    } finally {
      await db.close();
    }
  });
});

describeBackends('migrateTriggers', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  beforeAll(async () => {
    db = await backend.open();
  });
  afterAll(async () => {
    await dropTriggersTables(db, prefix);
    await db.close();
  });

  it('makes the four tables with their columns, and a second run applies nothing', async () => {
    const first = await migrateTriggers(db, { prefix });
    expect(first.applied).toEqual(['0001_triggers.sql']);
    const second = await migrateTriggers(db, { prefix });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(['0001_triggers.sql']);
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const rows = backend.name === 'postgres'
        ? await db.all<{ name: string }>('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', [`${prefix}_${table}`])
        : await db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [`${prefix}_${table}`]);
      expect(rows.map((row) => row.name).sort()).toEqual([...columns].sort());
    }
    expect(triggersTables(prefix)).toHaveLength(4);
  });

  it('records one missed due time once a job: a second row for the same job and due time is refused', async () => {
    await db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m1', 'sweep', 1_000, 'worker_down', 'caught_up']);
    await expect(db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m2', 'sweep', 1_000, 'paused', 'skipped'])).rejects.toThrow();
    await db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m3', 'sweep', 2_000, 'paused', 'skipped']);
    const rows = await db.all<{ id: string }>(`SELECT id FROM ${prefix}_missed WHERE job = ? ORDER BY due_at`, ['sweep']);
    expect(rows.map((row) => row.id)).toEqual(['m1', 'm3']);
  });

  it('refuses a kind, a rule, an outcome, a cause or a flag outside its list', async () => {
    const job = (overrides: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        name: 'x', title: 'X', process: 'sweeper', kind: 'scheduled', schedule_words: 'Every hour', rule: 'skip',
        stall_after_ms: 900_000, registered_at: 1, updated_at: 1, ...overrides,
      };
      const keys = Object.keys(row);
      return db.run(`INSERT INTO ${prefix}_jobs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((key) => row[key]));
    };
    await expect(job({ name: 'bad_kind', kind: 'other' })).rejects.toThrow();
    await expect(job({ name: 'bad_rule', rule: 'always' })).rejects.toThrow();
    await expect(job({ name: 'bad_flag', safe_to_repeat: 2 })).rejects.toThrow();
    await job({ name: 'good' });
    const [row] = await db.all<{ retries: number; timeout_ms: number | string; enabled: number; tries: number }>(`SELECT retries, timeout_ms, enabled, tries FROM ${prefix}_jobs WHERE name = ?`, ['good']);
    expect({ ...row, timeout_ms: Number(row?.timeout_ms) }).toEqual({ retries: 5, timeout_ms: 600_000, enabled: 1, tries: 0 });
    await expect(db.run(`INSERT INTO ${prefix}_runs (id, job, started_at, outcome) VALUES (?, ?, ?, ?)`, ['r1', 'good', 1, 'done'])).rejects.toThrow();
    await expect(db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m9', 'good', 9, 'crash', 'skipped'])).rejects.toThrow();
  });

  it('refuses an action outside its list and an enabled or legal duty flag other than 0 or 1, takes a reports-only job, and starts the three flags at their defaults', async () => {
    const job = (name: string, overrides: Record<string, unknown>) => {
      const row: Record<string, unknown> = {
        name, title: 'X', process: 'sweeper', kind: 'reports_only', schedule_words: 'Every hour', rule: 'catch_up_once',
        stall_after_ms: 900_000, registered_at: 1, updated_at: 1, ...overrides,
      };
      const keys = Object.keys(row);
      return db.run(`INSERT INTO ${prefix}_jobs (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((key) => row[key]));
    };
    await expect(job('bad_enabled', { enabled: 2 })).rejects.toThrow();
    await expect(job('bad_legal', { legal_duty: -1 })).rejects.toThrow();
    await job('flags', { rule: 'required' });
    const [row] = await db.all<{ safe_to_repeat: number; legal_duty: number; enabled: number }>(`SELECT safe_to_repeat, legal_duty, enabled FROM ${prefix}_jobs WHERE name = ?`, ['flags']);
    expect(row).toEqual({ safe_to_repeat: 0, legal_duty: 0, enabled: 1 });
    await expect(db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m_bad', 'flags', 7, 'paused', 'retried'])).rejects.toThrow();
  });

  it('refuses a second row with the same primary key in each table', async () => {
    const jobRow = (name: string) => db.run(
      `INSERT INTO ${prefix}_jobs (name, title, process, kind, schedule_words, rule, stall_after_ms, registered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [name, 'K', 'sweeper', 'scheduled', 'Every hour', 'skip', 900_000, 1, 1],
    );
    await jobRow('keyed');
    await expect(jobRow('keyed')).rejects.toThrow();
    await db.run(`INSERT INTO ${prefix}_runs (id, job, started_at, outcome) VALUES (?, ?, ?, ?)`, ['r_keyed', 'keyed', 1, 'running']);
    await expect(db.run(`INSERT INTO ${prefix}_runs (id, job, started_at, outcome) VALUES (?, ?, ?, ?)`, ['r_keyed', 'keyed', 2, 'ok'])).rejects.toThrow();
    await db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m_keyed', 'keyed', 1, 'paused', 'skipped']);
    await expect(db.run(`INSERT INTO ${prefix}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['m_keyed', 'keyed', 2, 'paused', 'skipped'])).rejects.toThrow();
  });

  it('builds the next-due, the runs-by-job and the unique missed index with their columns in order', async () => {
    for (const [name, index] of Object.entries(INDEXES)) {
      const read = await readIndex(db, backend, `${prefix}_${index.table}`, `${prefix}_${name}`);
      expect({ name, ...read }).toEqual({ name, unique: index.unique, columns: [...index.columns] });
    }
  });

  it('holds a time in milliseconds since the epoch, past 32 bits, in every time column', async () => {
    const at = Date.UTC(2026, 10, 4, 9, 0);
    expect(at).toBeGreaterThan(2 ** 31);
    const write = async (table: 'jobs' | 'runs' | 'missed', fixed: Record<string, unknown>) => {
      const row: Record<string, unknown> = { ...fixed };
      TIME_COLUMNS[table].forEach((column, i) => {
        row[column] = at + i;
      });
      const keys = Object.keys(row);
      await db.run(`INSERT INTO ${prefix}_${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, keys.map((key) => row[key]));
      const read = await db.get<Record<string, unknown>>(`SELECT ${TIME_COLUMNS[table].join(', ')} FROM ${prefix}_${table} WHERE ${Object.keys(fixed)[0]} = ?`, [Object.values(fixed)[0]]);
      expect(TIME_COLUMNS[table].map((column) => Number(read?.[column]))).toEqual(TIME_COLUMNS[table].map((_, i) => at + i));
    };
    await write('jobs', { name: 'epoch', title: 'E', process: 'sweeper', kind: 'scheduled', schedule_words: 'Every hour', rule: 'skip' });
    await write('runs', { id: 'r_epoch', job: 'epoch', outcome: 'ok' });
    await write('missed', { id: 'm_epoch', job: 'epoch', cause: 'worker_down', action: 'caught_up' });
  });

  it('starts against a ledger that names a file this release does not hold (unknown ignore)', async () => {
    await db.run(`INSERT INTO ${prefix}_schema_migrations (name, checksum) VALUES (?, ?)`, ['0099_later.sql', 'f'.repeat(64)]);
    try {
      const report = await migrateTriggers(db, { prefix });
      expect(report.unknown).toEqual(['0099_later.sql']);
      expect(report.applied).toEqual([]);
      expect(report.skipped).toEqual(['0001_triggers.sql']);
    } finally {
      await db.run(`DELETE FROM ${prefix}_schema_migrations WHERE name = ?`, ['0099_later.sql']);
    }
  });

  it('keeps the tables and the ledger of each prefix apart in one database', async () => {
    const other = freshPrefix();
    try {
      const report = await migrateTriggers(db, { prefix: other });
      expect(report.applied).toEqual(['0001_triggers.sql']);
      await db.run(`INSERT INTO ${other}_missed (id, job, due_at, cause, action) VALUES (?, ?, ?, ?, ?)`, ['apart', 'apart', 5, 'paused', 'skipped']);
      expect(await db.all(`SELECT id FROM ${prefix}_missed WHERE job = ?`, ['apart'])).toEqual([]);
      const ledger = await db.all<{ name: string }>(`SELECT name FROM ${other}_schema_migrations`);
      expect(ledger.map((row) => row.name)).toEqual(['0001_triggers.sql']);
    } finally {
      await dropTriggersTables(db, other);
    }
  });

  it('builds every table and index whole under the longest prefix', async () => {
    const longest = `p${randomUUID().replace(/-/g, '')}`;
    expect(longest).toHaveLength(33);
    try {
      expect((await migrateTriggers(db, { prefix: longest })).applied).toEqual(['0001_triggers.sql']);
      for (const [name, index] of Object.entries(INDEXES)) {
        expect(await readIndex(db, backend, `${longest}_${index.table}`, `${longest}_${name}`)).toEqual({ unique: index.unique, columns: [...index.columns] });
      }
      const ledger = await db.all<{ name: string }>(`SELECT name FROM ${longest}_schema_migrations`);
      expect(ledger.map((row) => row.name)).toEqual(['0001_triggers.sql']);
    } finally {
      await dropTriggersTables(db, longest);
    }
  });
});
