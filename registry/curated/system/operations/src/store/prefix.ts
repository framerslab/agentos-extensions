/**
 * @fileoverview The table prefix (D3): `ops` by default, a lower-case letter then at most 39
 * lower-case letters, digits or underscores, the rule the email pack's `requirePrefix` holds
 * (`registry/curated/channels/email/src/preferences/database.ts`). Every table is
 * `<prefix>_<name>`, and the prefix is written into the SQL as it is, so nothing else passes.
 */

export const DEFAULT_PREFIX = 'ops';

const PREFIX = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Returns the prefix when it is a lower-case letter followed by at most 39 lower-case letters,
 * digits or underscores, and otherwise throws a `RangeError`. On SQLite, `sqlite` and a prefix
 * beginning `sqlite_` make names SQLite keeps for itself, so a host there takes another prefix.
 */
export function requirePrefix(prefix: unknown): string {
  if (typeof prefix === 'string' && PREFIX.test(prefix)) return prefix;
  throw new RangeError(
    'The table prefix was refused: give a lower-case letter followed by at most 39 lower-case letters, digits or underscores',
  );
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
