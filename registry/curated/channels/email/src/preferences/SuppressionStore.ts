/**
 * @fileoverview The suppression record: the addresses a host must not mail, by scope, each named by the SHA-256 of the
 * address that the host computes, so the record never holds an address. A host's senders read it before a send, and
 * the handler of its provider's events writes it when a message bounces, draws a complaint or meets the provider's own
 * suppression list. A second record of an address writes nothing, so a provider's repeated event is harmless.
 */
import type { EmailPreferencesDb } from './database.js';
import { requireName, requirePrefix } from './database.js';

/** The reasons an address is suppressed, in the order the README lists them. */
export const SUPPRESSION_REASONS = ['bounce', 'complaint', 'suppressed', 'manual'] as const;

/**
 * Why an address is suppressed: `bounce` (a message to it bounced), `complaint` (its reader reported a message as
 * spam), `suppressed` (the provider refused a message because the address was already on its own list) or `manual`
 * (an operator, or the person, asked).
 */
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** The scope of a host that keeps one list: every reader and writer of the record passes it. */
export const DEFAULT_SUPPRESSION_SCOPE = 'mail';

/**
 * The addresses a host must not mail, by scope. A scope is one list, such as all of a host's mail or one sending
 * domain's, and most hosts keep one, `DEFAULT_SUPPRESSION_SCOPE`. An address is named by its hash, the SHA-256 of the
 * address as 64 lower-case hexadecimal characters, which the host computes the same way wherever it reads or writes the
 * record, such as over the address lower-cased. Anything else is refused with a `TypeError`, so an address passed by
 * mistake is never stored and never answered as not suppressed.
 */
export interface SuppressionStore {
  /**
   * Whether the address is suppressed in the scope.
   *
   * @param scope The list: 1 to 512 characters, with no U+0000 and no lone surrogate.
   * @param addressHash The SHA-256 of the address as 64 lower-case hexadecimal characters.
   */
  isSuppressed(scope: string, addressHash: string): Promise<boolean>;

  /**
   * Records the address as suppressed in the scope, with the reason and the day, and no end. A second record of the
   * address in the scope writes nothing and leaves the first as it was, whatever its reason or day.
   *
   * @param scope The list: 1 to 512 characters, with no U+0000 and no lone surrogate.
   * @param addressHash The SHA-256 of the address as 64 lower-case hexadecimal characters.
   * @param reason Why the address is suppressed.
   * @param day The calendar day of the event, `YYYY-MM-DD`.
   * @returns `true` when this call recorded the address, `false` when the scope held it already.
   */
  suppress(scope: string, addressHash: string, reason: SuppressionReason, day: string): Promise<boolean>;
}

/** The SHA-256 of an address in lower-case hexadecimal. */
const ADDRESS_HASH = /^[0-9a-f]{64}$/;

/** A calendar day, `YYYY-MM-DD`. */
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Returns the hash when it is 64 lower-case hexadecimal characters, and otherwise throws a `TypeError` that never holds
 * the value.
 */
function requireAddressHash(value: unknown): string {
  if (typeof value === 'string' && ADDRESS_HASH.test(value)) return value;
  throw new TypeError('The address hash was refused: give the SHA-256 of the address as 64 lower-case hexadecimal characters');
}

/** Returns the reason when it is one of `SUPPRESSION_REASONS`, and otherwise throws a `TypeError`. */
function requireReason(value: unknown): SuppressionReason {
  if (typeof value === 'string' && (SUPPRESSION_REASONS as readonly string[]).includes(value)) {
    return value as SuppressionReason;
  }
  throw new TypeError('The reason was refused: give bounce, complaint, suppressed or manual');
}

/** Returns the day when it is a calendar date written `YYYY-MM-DD`, and otherwise throws a `TypeError`. */
function requireDay(value: unknown): string {
  if (typeof value === 'string') {
    const parts = DAY.exec(value);
    // A date that does not exist, such as the 30th of February, comes back from Date.UTC as another day.
    if (
      parts !== null &&
      new Date(Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))).toISOString().slice(0, 10) === value
    ) {
      return value;
    }
  }
  throw new TypeError('The day was refused: give a calendar date as YYYY-MM-DD');
}

/**
 * The suppression record's table, `<prefix>_suppressions`, for a host's migration: one row an address and scope, with
 * the reason and the day, `CREATE TABLE IF NOT EXISTS` so it can run at each start. It runs on SQLite and on
 * PostgreSQL.
 *
 * @param prefix A lower-case letter followed by at most 39 lower-case letters, digits or underscores.
 * @throws RangeError when the prefix does not fit.
 */
export function suppressionStoreDdl(prefix: string): string {
  const table = `${requirePrefix(prefix)}_suppressions`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  scope TEXT NOT NULL,',
    '  address_hash TEXT NOT NULL,',
    '  reason TEXT NOT NULL,',
    '  suppressed_on TEXT NOT NULL,',
    '  PRIMARY KEY (scope, address_hash)',
    ');',
  ].join('\n');
}

/**
 * The suppression record on a host's SQL database, in the table `suppressionStoreDdl` makes under the same prefix. A
 * record is one `INSERT ... ON CONFLICT DO NOTHING`, so two hosts recording one address at once leave one row. Each
 * argument is checked before any statement, and an error from the database reaches the caller as it was thrown: no
 * failure is answered as `false`.
 */
export class SqlSuppressionStore implements SuppressionStore {
  private readonly table: string;

  /**
   * @param db The database: `@framers/sql-storage-adapter`'s adapter, or any handle of `EmailPreferencesDb`'s shape.
   * @param prefix The prefix the table was made under.
   * @throws RangeError when the prefix does not fit.
   */
  constructor(
    private readonly db: EmailPreferencesDb,
    prefix: string,
  ) {
    this.table = `${requirePrefix(prefix)}_suppressions`;
  }

  async isSuppressed(scope: string, addressHash: string): Promise<boolean> {
    const params = [requireName('scope', scope), requireAddressHash(addressHash)];
    const row = await this.db.get<{ hit: unknown }>(
      `SELECT 1 AS hit FROM ${this.table} WHERE scope = ? AND address_hash = ?`,
      params,
    );
    return row !== null && row !== undefined;
  }

  async suppress(scope: string, addressHash: string, reason: SuppressionReason, day: string): Promise<boolean> {
    const params = [requireName('scope', scope), requireAddressHash(addressHash), requireReason(reason), requireDay(day)];
    const result = await this.db.run(
      `INSERT INTO ${this.table} (scope, address_hash, reason, suppressed_on) VALUES (?, ?, ?, ?) ` +
        'ON CONFLICT (scope, address_hash) DO NOTHING',
      params,
    );
    return result.changes === 1;
  }
}
