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
  /**
   * Runs one statement; `changes` is the number of rows it inserted, updated or deleted. A handle whose answer holds no
   * such count, because it leaves `changes` out or gives something other than a whole number of 0 or more, still
   * records, issues and revokes, but then `suppress` answers `false` and `revoke` answers 0 whatever they wrote.
   */
  run(sql: string, params?: unknown[]): Promise<{ changes?: number }>;
  /** Runs one query and answers its first row, or `null` (or `undefined`) when it has none. */
  get<T>(sql: string, params?: unknown[]): Promise<T | null | undefined>;
}

/**
 * The rows a statement wrote, as its handle's `run` answered them: `changes` when it is a whole number of 0 or more, and
 * otherwise 0. An answer that is no count never passes for one, such as text, NaN, -1 or the object the storage
 * adapter's Capacitor handle answered before 0.6.14 (`{ changes: { changes, lastId } }`).
 *
 * @param result What the handle's `run` answered.
 */
export function changesOf(result: { readonly changes?: unknown } | null | undefined): number {
  const changes = result?.changes;
  return typeof changes === 'number' && Number.isSafeInteger(changes) && changes >= 0 ? changes : 0;
}

/** A table prefix: a lower-case letter, then at most 39 lower-case letters, digits or underscores. */
const PREFIX = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A prefix whose tables would begin `sqlite_`: SQLite keeps those names for its own tables and refuses to create one
 * (https://www.sqlite.org/lang_createtable.html).
 */
const SQLITE_OWN = /^sqlite(?:_|$)/;

/**
 * Returns the prefix when it is a lower-case letter followed by at most 39 lower-case letters, digits or underscores,
 * other than `sqlite` and a prefix beginning `sqlite_`, and otherwise throws a `RangeError`. The prefix is written into
 * the SQL as it is, so nothing else passes, and every prefix that passes makes tables on SQLite and on PostgreSQL.
 *
 * @param prefix The table prefix the caller gave.
 */
export function requirePrefix(prefix: unknown): string {
  if (typeof prefix === 'string' && PREFIX.test(prefix) && !SQLITE_OWN.test(prefix)) return prefix;
  throw new RangeError(
    'The table prefix was refused: give a lower-case letter followed by at most 39 lower-case letters, digits or ' +
      'underscores, other than sqlite and a prefix beginning sqlite_, whose tables SQLite keeps for itself',
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
 * Returns `value` when it is a string of 1 to 512 UTF-16 code units (its `length`, in which a character past U+FFFF
 * counts two) that a text column holds as it is, with no U+0000 and no lone surrogate, and otherwise throws a
 * `TypeError` that names `field` and never the value.
 *
 * @param field The argument's name, such as `scope`.
 * @param value The value the caller gave.
 */
export function requireName(field: string, value: unknown): string {
  if (typeof value === 'string' && value.length > 0 && value.length <= 512 && !UNSTORABLE.test(value)) return value;
  throw new TypeError(
    `The ${field} was refused: give it as a string of 1 to 512 UTF-16 code units with no U+0000 and no lone surrogate`,
  );
}
