/**
 * @fileoverview Recipient capabilities: opaque tokens that each name one recipient and one scope, such as the link in a
 * message that lets its reader stop one kind of mail without signing in. A token is base64url of HMAC-SHA256 over the
 * caller's nonce under the caller's key, so a message retried with the same nonce carries the same token, and only the
 * token's SHA-256 is stored, beside the recipient and the scope. A token works until its recipient's tokens are
 * revoked, or until the expiry its issuer set.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EmailPreferencesDb } from './database.js';
import { requireName, requirePrefix } from './database.js';

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
  /** The clock `find` reads an expiry against, in epoch milliseconds: `Date.now` unless given. */
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
   * and scope. A token issued after `revoke` works, the same nonce's included.
   *
   * @param recipient The recipient, 1 to 512 characters.
   * @param scope The scope, 1 to 512 characters.
   * @param nonce The nonce, 1 to 512 characters: one message, one nonce.
   * @param key The key, 32 bytes or more, kept secret by the caller.
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
   * Ends every token issued for the recipient, in every scope.
   *
   * @param recipient The recipient, 1 to 512 characters.
   * @returns How many tokens it ended.
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
}

/**
 * The recipient capabilities' table, `<prefix>_capabilities`, and the index `revoke` reads, for a host's migration: one
 * row a token, its SHA-256 the key, with the recipient, the scope and an optional expiry. Both statements are
 * `IF NOT EXISTS`, so they can run at each start, and they run on SQLite and on PostgreSQL. A host that deletes its
 * recipients can add its own foreign key with `ON DELETE CASCADE` in its migration, or call `revoke` with each deletion.
 *
 * @param prefix A lower-case letter followed by at most 39 lower-case letters, digits or underscores.
 * @throws RangeError when the prefix does not fit.
 */
export function recipientCapabilityDdl(prefix: string): string {
  const table = `${requirePrefix(prefix)}_capabilities`;
  return [
    `CREATE TABLE IF NOT EXISTS ${table} (`,
    '  token_hash TEXT PRIMARY KEY,',
    '  recipient TEXT NOT NULL,',
    '  scope TEXT NOT NULL,',
    '  expires_at BIGINT',
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
   * @param options The clock that expiries are read against.
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
    // A revoke that lands between the insert and the read deletes the row the insert met; the second pass writes it.
    for (let pass = 0; pass < 2; pass += 1) {
      const inserted = await this.db.run(
        `INSERT INTO ${this.table} (token_hash, recipient, scope, expires_at) VALUES (?, ?, ?, ?) ` +
          'ON CONFLICT (token_hash) DO NOTHING',
        [tokenHash, recipient, scope, expiresAt],
      );
      if (inserted.changes === 1) return token;
      const row = await this.db.get<CapabilityRow>(
        `SELECT recipient, scope, expires_at FROM ${this.table} WHERE token_hash = ?`,
        [tokenHash],
      );
      if (row === null || row === undefined) continue;
      if (row.recipient === recipient && row.scope === scope && expiryOf(row.expires_at) === expiresAt) return token;
      throw new Error('The token was refused: its nonce was issued under this key for another recipient, scope or expiry');
    }
    throw new Error('The token was not stored: its recipient was revoked while it was issued, twice');
  }

  async find(token: string): Promise<RecipientGrant | null> {
    if (typeof token !== 'string' || !TOKEN.test(token)) return null;
    const tokenHash = capabilityTokenHash(token);
    const row = await this.db.get<CapabilityRow>(
      `SELECT token_hash, recipient, scope, expires_at FROM ${this.table} WHERE token_hash = ?`,
      [tokenHash],
    );
    if (row === null || row === undefined || typeof row.token_hash !== 'string') return null;
    if (!equalInConstantTime(row.token_hash, tokenHash)) return null;
    const expiresAt = expiryOf(row.expires_at);
    // Written so that a clock that answers NaN ends the token rather than keeping it.
    if (expiresAt !== null && !(this.now() < expiresAt)) return null;
    return { recipient: row.recipient, scope: row.scope };
  }

  async revoke(recipient: string): Promise<number> {
    const result = await this.db.run(`DELETE FROM ${this.table} WHERE recipient = ?`, [requireName('recipient', recipient)]);
    return result.changes ?? 0;
  }
}
