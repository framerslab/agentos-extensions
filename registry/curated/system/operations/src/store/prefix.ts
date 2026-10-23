/**
 * @fileoverview The table prefix (D3): `ops` by default, a lower-case letter then at most 32
 * lower-case letters, digits or underscores: the characters of the email pack's `requirePrefix`
 * (`registry/curated/channels/email/src/preferences/database.ts`), with a length that keeps the
 * longest name the migrations make, `<prefix>_tickets_state_priority_person`, within
 * PostgreSQL's 63 bytes, which would otherwise cut it short. Every table is `<prefix>_<name>`,
 * and the prefix is written into the SQL as it is, so nothing else passes. On SQLite, `sqlite` and
 * a prefix beginning `sqlite_` are refused too, since they make names SQLite keeps for itself.
 */

export const DEFAULT_PREFIX = 'ops';

const PREFIX = /^[a-z][a-z0-9_]{0,32}$/;

/**
 * Returns the prefix when it is a lower-case letter followed by at most 32 lower-case letters,
 * digits or underscores, and otherwise throws a `RangeError`.
 */
export function requirePrefix(prefix: unknown): string {
  if (typeof prefix === 'string' && PREFIX.test(prefix)) return prefix;
  throw new RangeError(
    'The table prefix was refused: give a lower-case letter followed by at most 32 lower-case letters, digits or underscores',
  );
}

/**
 * Returns the prefix when its tables may stand on `dialect`: on SQLite, `sqlite` and a prefix
 * beginning `sqlite_` make names beginning `sqlite_`, which SQLite keeps for itself, so they throw
 * a `RangeError`; PostgreSQL takes them.
 */
export function requireDialectPrefix(prefix: string, dialect: 'postgres' | 'sqlite'): string {
  if (dialect === 'sqlite' && (prefix === 'sqlite' || prefix.startsWith('sqlite_'))) {
    throw new RangeError('The table prefix was refused: on SQLite, sqlite and a prefix beginning sqlite_ make names SQLite keeps for itself');
  }
  return prefix;
}

/** The names of the package's tables, without the prefix, parents before the tables that reference them. */
export const TABLE_NAMES = [
  'tickets',
  'messages',
  'attachments',
  'error_groups',
  'error_events',
  'error_days',
  'log_lines',
  'events',
  'daily',
  'health',
  'health_samples',
  'beats',
  'outages',
  'alerts',
  'schema_migrations',
] as const;

export type OpsTableName = (typeof TABLE_NAMES)[number];

/** `<prefix>_<name>`. */
export function tableName(prefix: string, name: OpsTableName): string {
  return `${prefix}_${name}`;
}

/** The fifteen table names under `prefix`, the ledger among them, parents first. */
export function operationsTables(prefix: string): readonly string[] {
  const checked = requirePrefix(prefix);
  return TABLE_NAMES.map((name) => tableName(checked, name));
}
