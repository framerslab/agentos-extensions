/**
 * @fileoverview Recipient capabilities: opaque tokens that each name one recipient and one scope, such as the link in a
 * message that lets its reader stop one kind of mail without signing in. A token is base64url of HMAC-SHA256 over the
 * caller's nonce under the caller's key, so a message retried with the same nonce carries the same token, and only the
 * token's SHA-256 is stored, beside the recipient and the scope. A token works until its recipient's tokens are
 * revoked, or until the expiry its issuer set. A revoked token's row stays, marked revoked, so its nonce is never issued
 * again: a revoked link never works again, and never comes to name another recipient or scope.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailPreferencesDb } from './database.js';
import { changesOf, requireName, requirePrefix } from './database.js';

/** What a token names: the recipient it was issued for and the scope it acts on. */
export interface RecipientGrant {
  /** The recipient, such as an account id. */
  readonly recipient: string;
  /** The scope, such as one kind of mail. */
  readonly scope: string;
}

/** The options of one `issue`. */
export interface RecipientCapabilityIssueOptions {
  /** When the token stops working, in epoch milliseconds. A token issued without it works until it is revoked. */
  readonly expiresAt?: number;
}

/** The options of a `SqlRecipientCapability`. */
export interface SqlRecipientCapabilityOptions {
  /** The clock `find` reads an expiry against and `revoke` records, in epoch milliseconds: `Date.now` unless given. */
  readonly now?: () => number;
}

/**
 * Opaque tokens that each name a recipient and a scope, kept as their SHA-256 alone. A token carries neither: only
 * `find` maps it to them, and the store holds nothing a token can be recovered from.
 */
export interface RecipientCapability {
  /**
   * Issues the token for a nonce, such as a message's id: base64url of HMAC-SHA256 over the nonce under the key, 43
   * characters. Issuing again with the same nonce and key, for the same recipient, scope and expiry, answers the same
   * token and writes nothing; for another recipient, scope or expiry it throws, and the first token keeps its recipient
   * and scope. A nonce whose token was revoked throws for every recipient, scope and expiry, so a message that needs a
   * working token after `revoke` takes a new nonce.
   *
   * @param recipient The recipient: 1 to 512 UTF-16 code units, with no U+0000 and no lone surrogate.
   * @param scope The scope, under the same rule.
   * @param nonce The nonce, under the same rule: one message, one nonce, never another message's.
   * @param key The key, 32 random bytes or more, kept secret by the caller. Two hosts that share a key draw the same
   * token from the same nonce, whatever their prefixes, so each host takes a key of its own or nonces no other host
   * uses.
   * @param options The token's expiry, if it has one.
   * @returns The token.
   */
  issue(
    recipient: string,
    scope: string,
    nonce: string,
    key: Uint8Array,
    options?: RecipientCapabilityIssueOptions,
  ): Promise<string>;

  /**
   * The recipient and the scope the token was issued for, or `null` for a token that is malformed, unknown, revoked or
   * past its expiry. The token is found by its SHA-256 and compared in constant time; a malformed token reaches no
   * database.
   *
   * @param token The token as the link carried it.
   */
  find(token: string): Promise<RecipientGrant | null>;

  /**
   * Ends every token issued for the recipient, in every scope. Each token's row stays, marked revoked, so its nonce is
   * never issued again; a token issued afterwards from a new nonce works.
   *
   * @param recipient The recipient: 1 to 512 UTF-16 code units, with no U+0000 and no lone surrogate.
   * @returns How many tokens it ended: a token ended by an earlier revoke is not counted again, and 0 whatever it ended
   * when the database's `run` answers no count of `changes`.
   */
  revoke(recipient: string): Promise<number>;
}

/** A token: 43 base64url characters, 32 bytes without padding. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** The shortest key `issue` takes, HMAC-SHA256's output length; RFC 2104 section 3 discourages shorter keys. */
const KEY_BYTES = 32;

/**
 * The token for a nonce under a key: base64url of HMAC-SHA256, 43 characters.
 *
 * @param nonce The nonce, as UTF-8.
 * @param key The key's bytes.
 */
export function capabilityToken(nonce: string, key: Uint8Array): string {
  return createHmac('sha256', key).update(nonce, 'utf8').digest('base64url');
}

/**
 * What the store keeps of a token: its SHA-256 in lower-case hexadecimal.
 *
 * @param token The token, as UTF-8.
 */
export function capabilityTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Returns the key when it holds 32 bytes or more, and otherwise throws a `TypeError` that never holds the key. */
function requireKey(key: unknown): Uint8Array {
  if (key instanceof Uint8Array && key.byteLength >= KEY_BYTES) return key;
  throw new TypeError(`The key was refused: give it as ${KEY_BYTES} bytes or more, such as a Buffer`);
}

/** The expiry `issue`'s options set, or `null` for none; anything but a whole number of milliseconds is refused. */
function requireExpiry(options: unknown): number | null {
  if (options === undefined) return null;
  if (typeof options !== 'object' || options === null) {
    throw new TypeError('The options were refused: give them as an object or leave them out');
  }
  const expiresAt: unknown = (options as { expiresAt?: unknown }).expiresAt;
  if (expiresAt === undefined) return null;
  if (typeof expiresAt === 'number' && Number.isSafeInteger(expiresAt)) return expiresAt;
  throw new TypeError('The expiry was refused: give it as a whole number of epoch milliseconds or leave it out');
}

/** A stored expiry as a number, or `null` for none: PostgreSQL answers a BIGINT as text. */
function expiryOf(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * The time a revoke records: the clock's reading in whole epoch milliseconds, or 0 when it answers no such number. A
 * revoke must mark its rows whatever the clock says: SQLite stores a NaN as NULL, which would leave the tokens working.
 */
function revokedAtOf(reading: unknown): number {
  const at = typeof reading === 'number' ? Math.trunc(reading) : Number.NaN;
  return Number.isSafeInteger(at) ? at : 0;
}

/** Whether two strings are equal, compared in time that does not depend on where they differ. */
function equalInConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A row of the table `recipientCapabilityDdl` makes. */
interface CapabilityRow {
  token_hash: string;
  recipient: string;
  scope: string;
  expires_at: string | number | null;
  revoked_at: string | number | null;
}

/** Whether a stored row was revoked: any value in `revoked_at`, which PostgreSQL answers as text. */
function isRevoked(row: { readonly revoked_at?: unknown }): boolean {
  return row.revoked_at !== null && row.revoked_at !== undefined;
}

/**
 * The recipient capabilities' table, `<prefix>_capabilities`, and the index `revoke` reads, for a host's migration: one
 * row a token, its SHA-256 the key, with the recipient, the scope, an optional expiry and the time the token was
 * revoked, if it was. Both statements are `IF NOT EXISTS`, so a migration can run them again, and they run on SQLite
 * and on PostgreSQL, from one process at a time: PostgreSQL does not promise that two processes making one new table at
 * once both succeed. A row refuses its nonce for as long as it stays: a host that deletes rows, by its own foreign key
 * with `ON DELETE CASCADE` or by hand, never issues their nonces again, and a host that cannot promise that calls
 * `revoke` with each deletion and keeps the rows.
 *
 * @param prefix A lower-case letter followed by at most 39 lower-case letters, digits or underscores, other than
 * `sqlite` and a prefix beginning `sqlite_`.
 * @throws RangeError when the prefix does not fit.
 */
export function recipientCapabilityDdl(prefix: string): string {
  const table = `${requirePrefix(prefix)}_capabilities`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  token_hash TEXT PRIMARY KEY,',
    '  recipient TEXT NOT NULL,',
    '  scope TEXT NOT NULL,',
    '  expires_at BIGINT,',
    '  revoked_at BIGINT',
    ');',
    `CREATE INDEX IF NOT EXISTS ${table}_recipient ON ${table} (recipient);`,
  ].join('\n');
}

/**
 * Recipient capabilities on a host's SQL database, in the table `recipientCapabilityDdl` makes under the same prefix.
 * Each argument is checked before any statement, and an error from the database reaches the caller as it was thrown.
 */
export class SqlRecipientCapability implements RecipientCapability {
  private readonly table: string;
  private readonly now: () => number;

  /**
   * @param db The database: `@framers/sql-storage-adapter`'s adapter, or any handle of `EmailPreferencesDb`'s shape.
   * @param prefix The prefix the table was made under.
   * @param options The clock that expiries are read against and revokes record.
   * @throws RangeError when the prefix does not fit.
   */
  constructor(
    private readonly db: EmailPreferencesDb,
    prefix: string,
    options: SqlRecipientCapabilityOptions = {},
  ) {
    this.table = `${requirePrefix(prefix)}_capabilities`;
    this.now = options.now ?? Date.now;
  }

  async issue(
    recipient: string,
    scope: string,
    nonce: string,
    key: Uint8Array,
    options?: RecipientCapabilityIssueOptions,
  ): Promise<string> {
    requireName('recipient', recipient);
    requireName('scope', scope);
    requireName('nonce', nonce);
    const expiresAt = requireExpiry(options);
    const token = capabilityToken(nonce, requireKey(key));
    const tokenHash = capabilityTokenHash(token);
    const inserted = await this.db.run(
      `INSERT INTO ${this.table} (token_hash, recipient, scope, expires_at) VALUES (?, ?, ?, ?) ` +
        'ON CONFLICT (token_hash) DO NOTHING',
      [tokenHash, recipient, scope, expiresAt],
    );
    if (changesOf(inserted) === 1) return token;
    // The nonce was issued before, or a handle that reports no count of `changes` wrote it: the stored row decides.
    const row = await this.db.get<CapabilityRow>(
      `SELECT recipient, scope, expires_at, revoked_at FROM ${this.table} WHERE token_hash = ?`,
      [tokenHash],
    );
    if (row === null || row === undefined) {
      throw new Error('The token was not stored: its row was deleted while it was issued');
    }
    if (isRevoked(row)) {
      throw new Error('The token was refused: its nonce was revoked under this key; give the message a new nonce');
    }
    if (row.recipient === recipient && row.scope === scope && expiryOf(row.expires_at) === expiresAt) return token;
    throw new Error('The token was refused: its nonce was issued under this key for another recipient, scope or expiry');
  }

  async find(token: string): Promise<RecipientGrant | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const tokenHash = capabilityTokenHash(token);
    const row = await this.db.get<CapabilityRow>(
      `SELECT token_hash, recipient, scope, expires_at, revoked_at FROM ${this.table} WHERE token_hash = ?`,
      [tokenHash],
    );
    if (row === null || row === undefined || typeof row.token_hash !== 'string') return null;
    if (!equalInConstantTime(row.token_hash, tokenHash)) return null;
    if (isRevoked(row)) return null;
    const expiresAt = expiryOf(row.expires_at);
    // Written so that a clock that answers NaN ends the token rather than keeping it.
    if (expiresAt !== null && !(this.now() < expiresAt)) return null;
    return { recipient: row.recipient, scope: row.scope };
  }

  async revoke(recipient: string): Promise<number> {
    const name = requireName('recipient', recipient);
    // The rows stay, so `issue` can refuse their nonces; only the live ones are marked and counted.
    const result = await this.db.run(
      `UPDATE ${this.table} SET revoked_at = ? WHERE recipient = ? AND revoked_at IS NULL`,
      [revokedAtOf(this.now()), name],
    );
    return changesOf(result);
  }
}
