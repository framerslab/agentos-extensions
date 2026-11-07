import { readFileSync } from 'node:fs';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dialectOf, migrateTriggers, triggersMigrations } from '../src/store/migrations.js';
import { requirePrefix, triggersTables } from '../src/store/prefix.js';
import { MIGRATION_FILES } from '../src/store/sql/index.js';
import { describeBackends, dropTriggersTables, freshPrefix } from './helpers/adapters.js';

/** Every column of the three tables and the ledger, by table, without the prefix. */
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  jobs: ['name', 'title', 'process', 'kind', 'schedule', 'schedule_words', 'rule', 'stall_after_ms', 'safe_to_repeat', 'retries', 'timeout_ms', 'legal_duty', 'enabled', 'paused_by', 'paused_at', 'paused_note', 'next_due_at', 'lease_holder', 'lease_token', 'lease_until', 'last_run_at', 'last_outcome', 'last_ms', 'last_did', 'tries', 'retry_at', 'failed_at', 'failed_kind', 'alerted_at', 'hand_run_by', 'hand_run_at', 'stall_since', 'stall_ref', 'registered_at', 'updated_at'],
  runs: ['id', 'job', 'started_at', 'ended_at', 'outcome', 'ms', 'tries', 'kind', 'did', 'by_hand', 'covers_from', 'covers_to', 'lease_token'],
  missed: ['id', 'job', 'due_at', 'cause', 'action', 'acted_at', 'run_id'],
  schema_migrations: ['name', 'checksum', 'applied_at'],
};

describe('the SQL as text', () => {
  it('matches the readable files, dialect by dialect', () => {
    for (const file of MIGRATION_FILES) {
      for (const dialect of ['postgres', 'sqlite'] as const) {
        expect(file[dialect]).toBe(readFileSync(new URL(`../src/store/sql/${dialect}/${file.name}`, import.meta.url), 'utf8'));
      }
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
});
