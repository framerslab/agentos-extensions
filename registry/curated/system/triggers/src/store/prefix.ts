/**
 * @fileoverview The table prefix: `trig` by default, a lower-case letter then at most 32 lower-case
 * letters, digits or underscores, the rule the operations package's `requirePrefix` applies. With
 * `_schema_migrations` (18 characters) the longest name stays inside PostgreSQL's 63 bytes. Every
 * table is `<prefix>_<name>`, and the prefix is written into the SQL as it is, so nothing else
 * passes. On SQLite, `sqlite` and a prefix beginning `sqlite_` are refused too, since they make
 * names SQLite keeps for itself.
 */

/** The table prefix when the host gives none. */
export const DEFAULT_PREFIX = 'trig';

/** A lower-case letter, then at most 32 lower-case letters, digits or underscores: with `_schema_migrations` (18) the longest name stays inside PostgreSQL's 63 bytes. */
const PREFIX = /^[a-z][a-z0-9_]{0,32}$/;

/** Returns the prefix when it follows the rule, and otherwise throws a `RangeError`. */
export function requirePrefix(prefix: unknown): string {
  if (typeof prefix === 'string' && PREFIX.test(prefix)) return prefix;
  throw new RangeError('The table prefix was refused: give a lower-case letter followed by at most 32 lower-case letters, digits or underscores');
}

/** Returns the prefix when its tables may stand on `dialect`; on SQLite, `sqlite` and a prefix beginning `sqlite_` throw a `RangeError`. */
export function requireDialectPrefix(prefix: string, dialect: 'postgres' | 'sqlite'): string {
  if (dialect === 'sqlite' && (prefix === 'sqlite' || prefix.startsWith('sqlite_'))) {
    throw new RangeError('The table prefix was refused: on SQLite, sqlite and a prefix beginning sqlite_ make names SQLite keeps for itself');
  }
  return prefix;
}

/** The names of the package's tables, without the prefix, the ledger last. */
export const TABLE_NAMES = ['jobs', 'runs', 'missed', 'schema_migrations'] as const;

/** One of the package's tables, by its name after the prefix. */
export type TriggersTableName = (typeof TABLE_NAMES)[number];

/** `<prefix>_<name>`. */
export function tableName(prefix: string, name: TriggersTableName): string {
  return `${prefix}_${name}`;
}

/** The four table names under `prefix`, the ledger among them. */
export function triggersTables(prefix: string): readonly string[] {
  const checked = requirePrefix(prefix);
  return TABLE_NAMES.map((name) => tableName(checked, name));
}
