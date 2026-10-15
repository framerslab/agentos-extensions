/**
 * @fileoverview What the preference stores need of a database, and the checks of the table prefix and the names they
 * take. Nothing here imports a database driver: the host passes its own handle.
 */

/**
 * What `SqlSuppressionStore` and `SqlRecipientCapability` need of a database: a statement that answers the number of
 * rows it changed, and a query that answers its first row, both with `?` placeholders and positional parameters.
 * `@framers/sql-storage-adapter`'s `StorageAdapter` has this shape on SQLite and on PostgreSQL, and so does the handle
 * its `transaction` gives a callback, so a store made on that handle writes inside the transaction.
 */
export interface EmailPreferencesDb {
  /** Runs one statement; `changes` is the number of rows it inserted, updated or deleted. */
  run(sql: string, params?: unknown[]): Promise<{ changes?: number }>;
  /** Runs one query and answers its first row, or `null` (or `undefined`) when it has none. */
  get<T>(sql: string, params?: unknown[]): Promise<T | null | undefined>;
}

/** A table prefix: a lower-case letter, then at most 39 lower-case letters, digits or underscores. */
const PREFIX = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * Returns the prefix when it is a lower-case letter followed by at most 39 lower-case letters, digits or underscores,
 * and otherwise throws a `RangeError`. The prefix is written into the SQL as it is, so nothing else passes.
 *
 * @param prefix The table prefix the caller gave.
 */
export function requirePrefix(prefix: unknown): string {
  if (typeof prefix === 'string' && PREFIX.test(prefix)) return prefix;
  throw new RangeError(
    'The table prefix was refused: give a lower-case letter followed by at most 39 lower-case letters, digits or underscores',
  );
}

/**
 * What a text column cannot hold as given: U+0000, which PostgreSQL's text refuses, and a lone surrogate, which UTF-8
 * cannot encode, so a driver writes something else in its place (node-postgres writes U+FFFD): the row would name
 * another value, and two values would meet in one. With the `u` flag a surrogate pair is one code point and does not
 * match.
 */
const UNSTORABLE = /\u0000|[\uD800-\uDFFF]/u;

/**
 * Returns `value` when it is a string of 1 to 512 characters that a text column holds as it is, with no U+0000 and no
 * lone surrogate, and otherwise throws a `TypeError` that names `field` and never the value.
 *
 * @param field The argument's name, such as `scope`.
 * @param value The value the caller gave.
 */
export function requireName(field: string, value: unknown): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && !UNSTORABLE.test(value)) return value;
  throw new TypeError(
    `The ${field} was refused: give it as a string of 1 to 512 characters with no U+0000 and no lone surrogate`,
  );
}
