import { readFileSync } from 'node:fs';
import { createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dialectOf, migrateOperations, operationsMigrations } from '../src/store/migrations.js';
import { operationsTables, requirePrefix } from '../src/store/prefix.js';
import { MIGRATION_FILES } from '../src/store/sql/index.js';
import { type Backend, describeBackends, dropOperationsTables, freshPrefix } from './helpers/adapters.js';

/** Every column of "Its tables", by table, without the prefix. */
const COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tickets: [
    'id', 'account_id', 'anonymous_id', 'subject', 'category', 'priority', 'state', 'source', 'claimed_by', 'share_identity',
    'identity_opened_at', 'consent_at', 'consent_version', 'plan_at_open', 'person_read_at', 'staff_read_at', 'last_person_at', 'last_staff_at',
    'last_system_at', 'last_mail_at', 'resolved_at', 'closed_at', 'created_at', 'updated_at',
  ],
  messages: [
    'id', 'ticket_id', 'sender', 'sender_account_id', 'body', 'system_key', 'system_params', 'source_event_type', 'source_event_id',
    'mail_state', 'mail_attempts', 'notified_at', 'notify_attempts', 'created_at',
  ],
  attachments: ['id', 'ticket_id', 'message_id', 'uploaded_by', 'media_type', 'bytes', 'width', 'height', 'created_at'],
  error_groups: [
    'id', 'fingerprint', 'origin', 'process', 'kind', 'code', 'route', 'template', 'state', 'resolved_release', 'resolved_at',
    'first_seen', 'last_seen', 'count', 'last_release', 'last_status', 'alerted_at',
  ],
  error_events: ['id', 'group_id', 'at', 'release', 'process', 'route', 'method', 'status', 'frames'],
  error_days: ['group_id', 'day', 'count'],
  log_lines: ['id', 'at', 'process', 'kind', 'status', 'path', 'fields'],
  events: ['id', 'at', 'kind', 'plan', 'n', 'fields'],
  daily: ['day', 'metric', 'plan', 'value', 'updated_at'],
  health: ['name', 'state', 'since', 'last_at', 'last_ms', 'failures', 'detail'],
  health_samples: ['id', 'at', 'name', 'state', 'ms', 'value'],
  beats: ['job', 'last_at', 'outcome', 'last_ok_at'],
  outages: ['id', 'started_at', 'ended_at', 'misses'],
  alerts: ['key', 'last_sent_at', 'pending', 'pending_count'],
  schema_migrations: ['name', 'checksum', 'applied_at'],
};

/** The package's migrations in number order. */
const MIGRATIONS = ['0001_operations.sql', '0002_outbox_indexes.sql'];

/** The primary keys, by table. */
const PRIMARY: Readonly<Record<string, readonly string[]>> = {
  tickets: ['id'], messages: ['id'], attachments: ['id'], error_groups: ['id'], error_events: ['id'],
  error_days: ['group_id', 'day'], log_lines: ['id'], events: ['id'], daily: ['day', 'metric', 'plan'],
  health: ['name'], health_samples: ['id'], beats: ['job'], outages: ['id'], alerts: ['key'], schema_migrations: ['name'],
};

/** The indexes and unique keys, by table: the name's tail after the table, its columns, whether it is unique. */
const INDEXES: ReadonlyArray<{ table: string; tail: string; columns: readonly string[]; unique: boolean }> = [
  { table: 'tickets', tail: 'anonymous_id', columns: ['anonymous_id'], unique: true },
  { table: 'tickets', tail: 'account_created', columns: ['account_id', 'created_at'], unique: false },
  { table: 'tickets', tail: 'state_priority_person', columns: ['state', 'priority', 'last_person_at'], unique: false },
  { table: 'tickets', tail: 'claimed_state', columns: ['claimed_by', 'state'], unique: false },
  { table: 'messages', tail: 'source_event', columns: ['source_event_type', 'source_event_id'], unique: true },
  { table: 'messages', tail: 'ticket_created', columns: ['ticket_id', 'created_at'], unique: false },
  { table: 'messages', tail: 'sender_created', columns: ['sender_account_id', 'created_at'], unique: false },
  { table: 'messages', tail: 'mail_owed', columns: ['created_at'], unique: false },
  { table: 'messages', tail: 'unnotified', columns: ['created_at'], unique: false },
  { table: 'attachments', tail: 'ticket', columns: ['ticket_id'], unique: false },
  { table: 'attachments', tail: 'message', columns: ['message_id'], unique: false },
  { table: 'error_groups', tail: 'fingerprint', columns: ['fingerprint'], unique: true },
  { table: 'error_groups', tail: 'state_last_seen', columns: ['state', 'last_seen'], unique: false },
  { table: 'error_events', tail: 'group_at', columns: ['group_id', 'at'], unique: false },
  { table: 'error_events', tail: 'at', columns: ['at'], unique: false },
  { table: 'log_lines', tail: 'at', columns: ['at'], unique: false },
  { table: 'log_lines', tail: 'kind_at', columns: ['kind', 'at'], unique: false },
  { table: 'events', tail: 'kind_at', columns: ['kind', 'at'], unique: false },
  { table: 'events', tail: 'at', columns: ['at'], unique: false },
  { table: 'health_samples', tail: 'name_at', columns: ['name', 'at'], unique: false },
  { table: 'health_samples', tail: 'at', columns: ['at'], unique: false },
  { table: 'outages', tail: 'started_at', columns: ['started_at'], unique: false },
];

/** The cascading keys, by table: the column, the parent table. */
const CASCADES: ReadonlyArray<{ table: string; column: string; parent: string }> = [
  { table: 'messages', column: 'ticket_id', parent: 'tickets' },
  { table: 'attachments', column: 'ticket_id', parent: 'tickets' },
  { table: 'attachments', column: 'message_id', parent: 'messages' },
  { table: 'error_events', column: 'group_id', parent: 'error_groups' },
  { table: 'error_days', column: 'group_id', parent: 'error_groups' },
];

/** The catalog as the two engines expose it. */
function catalog(db: StorageAdapter, backend: Backend) {
  const postgres = backend.name === 'postgres';
  return {
    async tables(prefix: string): Promise<string[]> {
      const rows = postgres
        ? await db.all<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() AND tablename LIKE ? ESCAPE '\\'`, [`${prefix}\\_%`])
        : await db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\'`, [`${prefix}\\_%`]);
      return rows.map((row) => row.name).sort();
    },
    async columns(table: string): Promise<string[]> {
      const rows = postgres
        ? await db.all<{ name: string }>('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?', [table])
        : await db.all<{ name: string }>('SELECT name FROM pragma_table_info(?)', [table]);
      return rows.map((row) => row.name).sort();
    },
    async primary(table: string): Promise<string[]> {
      if (postgres) {
        const rows = await db.all<{ name: string }>(
          `SELECT a.attname AS name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
           WHERE i.indrelid = CAST(? AS regclass) AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`,
          [table],
        );
        return rows.map((row) => row.name);
      }
      const rows = await db.all<{ name: string; pk: number }>('SELECT name, pk FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk', [table]);
      return rows.map((row) => row.name);
    },
    async indexes(table: string): Promise<Array<{ name: string; unique: boolean; columns: string[] }>> {
      if (postgres) {
        const rows = await db.all<{ name: string; definition: string }>('SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ?', [table]);
        return rows.map((row) => ({
          name: row.name,
          unique: /^CREATE UNIQUE INDEX/.test(row.definition),
          columns: (/\(([^)]*)\)/.exec(row.definition)?.[1] ?? '').split(',').map((column) => column.trim()),
        }));
      }
      const list = await db.all<{ name: string; unique: number }>('SELECT name, "unique" FROM pragma_index_list(?)', [table]);
      const indexes = [];
      for (const entry of list) {
        const columns = await db.all<{ name: string }>('SELECT name FROM pragma_index_info(?) ORDER BY seqno', [entry.name]);
        indexes.push({ name: entry.name, unique: entry.unique === 1, columns: columns.map((column) => column.name) });
      }
      return indexes;
    },
    async cascades(table: string): Promise<Array<{ column: string; parent: string }>> {
      if (postgres) {
        const rows = await db.all<{ col: string; parent: string }>(
          `SELECT a.attname AS col, c.confrelid::regclass::text AS parent FROM pg_constraint c
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
           WHERE c.conrelid = CAST(? AS regclass) AND c.contype = 'f' AND c.confdeltype = 'c'`,
          [table],
        );
        return rows.map((row) => ({ column: row.col, parent: row.parent }));
      }
      const rows = await db.all<{ from: string; table: string; on_delete: string }>('SELECT "from", "table", on_delete FROM pragma_foreign_key_list(?)', [table]);
      return rows.filter((row) => row.on_delete === 'CASCADE').map((row) => ({ column: row.from, parent: row.table }));
    },
  };
}

/** What a deleted message, request and error group leave of their rows. */
const NOTHING_LEFT = {
  afterMessage: { pictures: 2, ofTheMessage: 0 },
  messages: 0,
  pictures: 0,
  occurrences: 0,
  days: 0,
};

/**
 * Writes a request with two messages and three pictures (one on each message, one on none) and an
 * error group with an occurrence and a day, deletes one message, then the request and the group,
 * and counts what is left. A request takes its messages and pictures, a message its pictures and a
 * group its occurrences and days: on PostgreSQL by the keys, on SQLite whether or not the
 * connection enforces foreign keys.
 */
async function leftAfterDeletes(db: StorageAdapter, table: (name: string) => string, digit: string) {
  const now = 1_761_000_000_000;
  const id = (tag: string, last: string = digit) => `${tag}_${digit.repeat(31)}${last}`;
  const ticket = id('tkt');
  const kept = id('msg', 'a');
  const removed = id('msg', 'b');
  const group = id('err');
  const count = async (name: string, column: string, value: string) =>
    Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${table(name)} WHERE ${column} = ?`, [value]))?.n ?? -1);

  await db.run(
    `INSERT INTO ${table('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [ticket, 'acct-deleted', `anon-${ticket}`, 'A subject', 'bug', 'normal', 'open', 'person', 0, now, now],
  );
  for (const message of [kept, removed]) {
    await db.run(`INSERT INTO ${table('messages')} (id, ticket_id, sender, body, created_at) VALUES (?, ?, ?, ?, ?)`, [message, ticket, 'person', 'A body', now]);
  }
  const pictures: ReadonlyArray<readonly [string, string | null]> = [['a', kept], ['b', removed], ['c', null]];
  for (const [last, message] of pictures) {
    await db.run(
      `INSERT INTO ${table('attachments')} (id, ticket_id, message_id, uploaded_by, media_type, bytes, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('pic', last), ticket, message, 'acct-deleted', 'image/webp', Buffer.alloc(8), 1, 1, now],
    );
  }
  await db.run(
    `INSERT INTO ${table('error_groups')} (id, fingerprint, origin, process, kind, state, first_seen, last_seen, count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [group, `fingerprint-${group}`, 'server', 'web', 'TypeError', 'open', now, now, 1],
  );
  await db.run(`INSERT INTO ${table('error_events')} (id, group_id, at, process) VALUES (?, ?, ?, ?)`, [id('occ'), group, now, 'web']);
  await db.run(`INSERT INTO ${table('error_days')} (group_id, day, count) VALUES (?, ?, ?)`, [group, now, 1]);

  await db.run(`DELETE FROM ${table('messages')} WHERE id = ?`, [removed]);
  const afterMessage = { pictures: await count('attachments', 'ticket_id', ticket), ofTheMessage: await count('attachments', 'message_id', removed) };
  await db.run(`DELETE FROM ${table('tickets')} WHERE id = ?`, [ticket]);
  await db.run(`DELETE FROM ${table('error_groups')} WHERE id = ?`, [group]);
  return {
    afterMessage,
    messages: await count('messages', 'ticket_id', ticket),
    pictures: await count('attachments', 'ticket_id', ticket),
    occurrences: await count('error_events', 'group_id', group),
    days: await count('error_days', 'group_id', group),
  };
}

describe('the shipped SQL', () => {
  it('is the text of the two .sql files beside it', () => {
    const read = (dialect: string, name: string) => readFileSync(new URL(`../src/store/sql/${dialect}/${name}`, import.meta.url), 'utf8');
    expect(MIGRATION_FILES.map((file) => file.name)).toEqual(MIGRATIONS);
    for (const file of MIGRATION_FILES) {
      expect(file.postgres).toBe(read('postgres', file.name));
      expect(file.sqlite).toBe(read('sqlite', file.name));
    }
  });

  it('writes the prefix into every table and index name and nothing else', () => {
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const migrations = operationsMigrations(dialect, 'acme_ops');
      expect(migrations.map((migration) => migration.name)).toEqual(MIGRATIONS);
      for (const migration of migrations) {
        expect(migration.sql).not.toContain('{{prefix}}');
        expect(migration.sql).not.toMatch(/\bops_/);
      }
      expect(migrations[0]?.sql.match(/CREATE TABLE IF NOT EXISTS acme_ops_/g)).toHaveLength(14);
      // The second adds the two indexes the outbox scans read, and no table.
      expect(migrations[1]?.sql).not.toContain('CREATE TABLE');
      expect(migrations[1]?.sql.match(/CREATE INDEX IF NOT EXISTS acme_ops_messages_\w+ ON acme_ops_messages \(created_at\) WHERE /g)).toHaveLength(2);
    }
    expect(operationsMigrations('postgres', 'a')[0]?.sql).not.toBe(operationsMigrations('postgres', 'b')[0]?.sql);
    expect(operationsMigrations('postgres', 'a')[1]?.sql).not.toBe(operationsMigrations('postgres', 'b')[1]?.sql);
  });
});

describe('migrateOperations refuses a prefix outside the rule before any statement', () => {
  const stub = () => {
    let statements = 0;
    const touch = async () => {
      statements += 1;
      throw new Error('a statement ran');
    };
    const db = { kind: 'sqljs', capabilities: new Set(), run: touch, get: touch, all: touch, exec: touch, transaction: touch, open: touch, close: touch } as unknown as StorageAdapter;
    return { db, count: () => statements };
  };

  it('on SQLite, refuses sqlite and a prefix beginning sqlite_, the names SQLite keeps for itself, with a RangeError before any statement, and takes them on PostgreSQL', async () => {
    for (const prefix of ['sqlite', 'sqlite_ops']) {
      const { db, count } = stub();
      await expect(migrateOperations(db, { prefix })).rejects.toBeInstanceOf(RangeError);
      expect(count()).toBe(0);
      expect(() => operationsMigrations('sqlite', prefix)).toThrow(RangeError);
      expect(operationsMigrations('postgres', prefix)[0]?.sql).toContain(`CREATE TABLE IF NOT EXISTS ${prefix}_tickets`);
    }
    expect(operationsMigrations('sqlite', 'sqlites')[0]?.sql).toContain('CREATE TABLE IF NOT EXISTS sqlites_tickets');
  });

  it('throws a RangeError and runs nothing', async () => {
    for (const prefix of ['Ops', '1ops', 'ops-x', 'ops x', 'a'.repeat(34), 'a'.repeat(41), '']) {
      const { db, count } = stub();
      await expect(migrateOperations(db, { prefix })).rejects.toBeInstanceOf(RangeError);
      expect(count()).toBe(0);
      expect(() => operationsMigrations('postgres', prefix)).toThrow(RangeError);
    }
    // A trailing underscore and the full 33 characters are inside the rule: a letter, then at most 32 letters, digits or underscores,
    // so PostgreSQL's 63-byte names hold the longest index name, `<prefix>_tickets_state_priority_person`, whole.
    expect(requirePrefix('ops_')).toBe('ops_');
    expect(requirePrefix(`a${'b'.repeat(32)}`)).toBe(`a${'b'.repeat(32)}`);
    const longest = `a${'b'.repeat(32)}`;
    for (const dialect of ['postgres', 'sqlite'] as const) {
      const names = operationsMigrations(dialect, longest).flatMap((migration) => [...migration.sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map((match) => match[1] ?? ''));
      expect(names.length).toBeGreaterThan(0);
      expect(Math.max(...names.map((name) => name.length))).toBeLessThanOrEqual(63);
    }
    expect(dialectOf({ kind: 'postgres' })).toBe('postgres');
    expect(dialectOf({ kind: 'supabase-postgres' })).toBe('postgres');
    expect(dialectOf({ kind: 'sqljs' })).toBe('sqlite');
    expect(dialectOf({ kind: 'better-sqlite3' })).toBe('sqlite');
  });
});

describeBackends('migrateOperations', (backend) => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const table = (name: string) => `${prefix}_${name}`;

  beforeAll(async () => {
    db = await backend.open();
  });

  afterAll(async () => {
    await dropOperationsTables(db, prefix);
    await db.close();
  });

  it('builds the fifteen tables under a prefix and applies nothing the second time', async () => {
    const first = await migrateOperations(db, { prefix });
    expect(first.applied).toEqual(MIGRATIONS);
    expect(first.skipped).toEqual([]);
    const tables = await catalog(db, backend).tables(prefix);
    expect(tables).toEqual([...operationsTables(prefix)].sort());
    expect(tables).toHaveLength(15);

    const second = await migrateOperations(db, { prefix });
    expect(second.applied).toEqual([]);
    expect(second.skipped).toEqual(MIGRATIONS);
    expect(second.changed).toEqual([]);
  });

  it('a list one file short starts (unknown ignore)', async () => {
    await db.run(`INSERT INTO ${table('schema_migrations')} (name, checksum) VALUES (?, ?)`, ['0099_later.sql', 'f'.repeat(64)]);
    const report = await migrateOperations(db, { prefix });
    expect(report.unknown).toEqual(['0099_later.sql']);
    expect(report.applied).toEqual([]);
    expect(report.skipped).toEqual(MIGRATIONS);
    await db.run(`DELETE FROM ${table('schema_migrations')} WHERE name = ?`, ['0099_later.sql']);
  });

  it('every column, primary key, index, unique key and cascading key of the tables exists', async () => {
    const read = catalog(db, backend);
    for (const [name, columns] of Object.entries(COLUMNS)) {
      expect({ table: name, columns: await read.columns(table(name)) }).toEqual({ table: name, columns: [...columns].sort() });
    }
    for (const [name, columns] of Object.entries(PRIMARY)) {
      expect({ table: name, primary: await read.primary(table(name)) }).toEqual({ table: name, primary: columns });
    }
    for (const index of INDEXES) {
      const found = (await read.indexes(table(index.table))).find((entry) => entry.name === `${prefix}_${index.table}_${index.tail}`);
      expect({ ...index, found }).toEqual({ ...index, found: { name: `${prefix}_${index.table}_${index.tail}`, unique: index.unique, columns: [...index.columns] } });
    }
    for (const cascade of CASCADES) {
      const found = await read.cascades(table(cascade.table));
      expect({ ...cascade, found: found.filter((entry) => entry.column === cascade.column) }).toEqual({
        ...cascade,
        found: [{ column: cascade.column, parent: table(cascade.parent) }],
      });
    }
  });

  it('the two outbox indexes hold the owed mail rows and the messages whose bell is unmarked alone, so the minute tick finds the few it owes through an index instead of reading every message', async () => {
    const definition = async (name: string): Promise<string> => {
      const row =
        backend.name === 'postgres'
          ? await db.get<{ sql: string }>('SELECT indexdef AS sql FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?', [name])
          : await db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [name]);
      return row?.sql ?? '';
    };
    expect(await definition(`${prefix}_messages_mail_owed`)).toMatch(/WHERE \(*mail_state = 'owed'/);
    expect(await definition(`${prefix}_messages_unnotified`)).toMatch(/WHERE \(*notified_at IS NULL/);
  });

  it('holds ops_attachments.bytes under a check of 1,048,576 bytes', async () => {
    const now = 1_761_000_000_000;
    await db.run(
      `INSERT INTO ${table('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['tkt_' + '1'.repeat(32), 'acct-1', 'anon-1', 'A subject', 'bug', 'normal', 'open', 'person', 0, now, now],
    );
    const insert = (id: string, bytes: Buffer) =>
      db.run(
        `INSERT INTO ${table('attachments')} (id, ticket_id, message_id, uploaded_by, media_type, bytes, width, height, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
        [id, 'tkt_' + '1'.repeat(32), 'acct-1', 'image/webp', bytes, 10, 10, now],
      );
    await insert('pic_' + 'a'.repeat(32), Buffer.alloc(1_048_576));
    await expect(insert('pic_' + 'b'.repeat(32), Buffer.alloc(1_048_577))).rejects.toThrow();
    const rows = await db.all<{ id: string }>(`SELECT id FROM ${table('attachments')}`);
    expect(rows.map((row) => row.id)).toEqual(['pic_' + 'a'.repeat(32)]);

    await db.run(`DELETE FROM ${table('tickets')} WHERE id = ?`, ['tkt_' + '1'.repeat(32)]);
    expect(await db.all(`SELECT id FROM ${table('attachments')}`)).toEqual([]);
  });

  it('keeps an upload with no request and no message until it is attached, and records the words\' version beside the consent', async () => {
    const now = 1_761_000_000_000;
    const ticket = 'tkt_' + '7'.repeat(32);
    const other = 'tkt_' + '6'.repeat(31) + '7';
    const upload = 'pic_' + '7'.repeat(32);
    const open = (id: string, anonymous: string) =>
      db.run(
        `INSERT INTO ${table('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, consent_at, consent_version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'acct-7', anonymous, 'A subject', 'bug', 'normal', 'open', 'person', 0, now, 'support-form-2', now, now],
      );
    // An upload comes before the request it opens: no request and no message yet.
    await db.run(
      `INSERT INTO ${table('attachments')} (id, ticket_id, message_id, uploaded_by, media_type, bytes, width, height, created_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
      [upload, 'acct-7', 'image/webp', Buffer.alloc(8), 1, 1, now],
    );
    await open(ticket, 'anon-7');
    await open(other, 'anon-6');
    const consent = await db.get<{ consent_at: number | string; consent_version: string }>(
      `SELECT consent_at, consent_version FROM ${table('tickets')} WHERE id = ?`,
      [ticket],
    );
    expect({ at: Number(consent?.consent_at), version: consent?.consent_version }).toEqual({ at: now, version: 'support-form-2' });

    // Another request's deletion leaves the unattached upload; once attached, it goes with its own request.
    await db.run(`DELETE FROM ${table('tickets')} WHERE id = ?`, [other]);
    expect((await db.all<{ id: string }>(`SELECT id FROM ${table('attachments')} WHERE id = ?`, [upload])).map((row) => row.id)).toEqual([upload]);
    await db.run(`UPDATE ${table('attachments')} SET ticket_id = ? WHERE id = ?`, [ticket, upload]);
    await db.run(`DELETE FROM ${table('tickets')} WHERE id = ?`, [ticket]);
    expect(await db.all(`SELECT id FROM ${table('attachments')} WHERE id = ?`, [upload])).toEqual([]);
  });

  it('a deleted request takes its messages and pictures, a deleted message its pictures and a deleted group its occurrences and days', async () => {
    expect(await leftAfterDeletes(db, table, '9')).toEqual(NOTHING_LEFT);
  });

  it('refuses a value outside an enumeration and a flag outside 0 and 1', async () => {
    const now = 1_761_000_000_000;
    const ticket = (id: string, priority: string, flag: number) =>
      db.run(
        `INSERT INTO ${table('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, 'acct-2', `anon-${id}`, 'A subject', 'bug', priority, 'open', 'person', flag, now, now],
      );
    await expect(ticket('tkt_' + '2'.repeat(32), 'high', 0)).rejects.toThrow();
    await expect(ticket('tkt_' + '3'.repeat(32), 'normal', 2)).rejects.toThrow();
    await ticket('tkt_' + '4'.repeat(32), 'urgent', 1);
    await expect(ticket('tkt_' + '5'.repeat(32), 'urgent', 1)).resolves.toBeTruthy();
    // The anonymous id is unique.
    await expect(
      db.run(
        `INSERT INTO ${table('tickets')} (id, account_id, anonymous_id, subject, category, priority, state, source, share_identity, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['tkt_' + '6'.repeat(32), 'acct-2', 'anon-tkt_' + '4'.repeat(32), 'A subject', 'bug', 'normal', 'open', 'person', 0, now, now],
      ),
    ).rejects.toThrow();
    await db.run(`DELETE FROM ${table('tickets')} WHERE account_id = ?`, ['acct-2']);
  });
});

describe('migrateOperations on SQLite with foreign keys enforced', () => {
  let db: StorageAdapter;
  const prefix = freshPrefix();
  const table = (name: string) => `${prefix}_${name}`;

  beforeAll(async () => {
    db = createSqlJsAdapter();
    await db.open({ foreignKeys: true });
    await migrateOperations(db, { prefix });
  });

  afterAll(async () => {
    await db.close();
  });

  it('a deleted request, message and group take their rows with the keys enforced too', async () => {
    expect(await db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')).toEqual({ foreign_keys: 1 });
    expect(await leftAfterDeletes(db, table, '8')).toEqual(NOTHING_LEFT);
  });
});
