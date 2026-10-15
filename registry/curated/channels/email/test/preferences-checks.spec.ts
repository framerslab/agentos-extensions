/**
 * The preference stores' pure parts: the token's derivation, the DDL's prefix, and the checks that refuse a value
 * before any statement reaches the database. The database here fails the case if a statement reaches it.
 */
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { capabilityToken, capabilityTokenHash } from '../src/preferences/RecipientCapability';
import {
  SUPPRESSION_REASONS,
  SqlRecipientCapability,
  SqlSuppressionStore,
  emailPreferencesDdl,
  recipientCapabilityDdl,
  suppressionStoreDdl,
} from '../src/index';

/** A database no statement may reach: each call throws an `Error`, never the `TypeError` a check throws. */
const untouched = {
  run: async (): Promise<{ changes?: number }> => {
    throw new Error('a statement reached the database');
  },
  get: async <T>(): Promise<T | null> => {
    throw new Error('a statement reached the database');
  },
};

const HASH = createHash('sha256').update('reader@example.com').digest('hex');
const KEY = Buffer.alloc(32, 1);

describe('the capability token', () => {
  it('is base64url of HMAC-SHA256 over the nonce under the key: 43 characters, the same for the same nonce and key', () => {
    const token = capabilityToken('message-1', KEY);
    expect(token).toBe(createHmac('sha256', KEY).update('message-1', 'utf8').digest('base64url'));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(capabilityToken('message-1', Buffer.from(KEY))).toBe(token);
    expect(capabilityToken('message-2', KEY)).not.toBe(token);
    expect(capabilityToken('message-1', Buffer.alloc(32, 2))).not.toBe(token);
  });

  it('is kept as its SHA-256 in lower-case hex', () => {
    const token = capabilityToken('message-1', KEY);
    expect(capabilityTokenHash(token)).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(capabilityTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('the suppression record refuses before any statement', () => {
  const store = new SqlSuppressionStore(untouched, 'mail');

  it('anything but the SHA-256 of an address as 64 lower-case hexadecimal characters', async () => {
    for (const wrong of ['reader@example.com', HASH.toUpperCase(), HASH.slice(1), `${HASH}0`, ` ${HASH}`, '', 42, null]) {
      await expect(store.isSuppressed('mail', wrong as string)).rejects.toThrow(TypeError);
      await expect(store.suppress('mail', wrong as string, 'bounce', '2026-10-15')).rejects.toThrow(TypeError);
    }
  });

  it('a reason other than bounce, complaint, suppressed and manual', async () => {
    expect([...SUPPRESSION_REASONS]).toEqual(['bounce', 'complaint', 'suppressed', 'manual']);
    for (const reason of ['unsubscribe', 'Bounce', '', undefined]) {
      await expect(store.suppress('mail', HASH, reason as 'bounce', '2026-10-15')).rejects.toThrow(TypeError);
    }
  });

  it('a day that is not a calendar date written YYYY-MM-DD', async () => {
    for (const day of ['2026-02-30', '2026-13-01', '2026-00-10', '15-10-2026', '2026-10-15T00:00:00Z', '0099-01-01', '', 20261015]) {
      await expect(store.suppress('mail', HASH, 'bounce', day as string)).rejects.toThrow(TypeError);
    }
  });

  it('an empty scope, one past 512 characters, and one that is not a string', async () => {
    for (const scope of ['', 'x'.repeat(513), 7, undefined]) {
      await expect(store.isSuppressed(scope as string, HASH)).rejects.toThrow(TypeError);
      await expect(store.suppress(scope as string, HASH, 'bounce', '2026-10-15')).rejects.toThrow(TypeError);
    }
  });

  it('and names none of the value it refused', async () => {
    const refusal: unknown = await store.suppress('mail', 'reader@example.com', 'bounce', '2026-10-15').catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as TypeError).message).not.toMatch(/reader|example/);
  });
});

describe('the recipient capability refuses before any statement', () => {
  const capability = new SqlRecipientCapability(untouched, 'mail');

  it('a key shorter than 32 bytes, or given as text', async () => {
    for (const key of [Buffer.alloc(31, 1), new Uint8Array(0), 'a'.repeat(64), undefined]) {
      await expect(capability.issue('account-1', 'minutes', 'message-1', key as Buffer)).rejects.toThrow(TypeError);
    }
  });

  it('an empty recipient, scope or nonce, one past 512 characters, and an expiry that is not a whole number', async () => {
    const long = 'x'.repeat(513);
    for (const [recipient, scope, nonce] of [['', 'minutes', 'm'], ['a', '', 'm'], ['a', 'minutes', ''], [long, 'minutes', 'm'], ['a', long, 'm'], ['a', 'minutes', long]]) {
      await expect(capability.issue(recipient, scope, nonce, KEY)).rejects.toThrow(TypeError);
    }
    for (const expiresAt of [1.5, Number.NaN, '1060000']) {
      await expect(capability.issue('a', 'minutes', 'm', KEY, { expiresAt: expiresAt as number })).rejects.toThrow(TypeError);
    }
    await expect(capability.revoke('')).rejects.toThrow(TypeError);
  });

  it('answers nothing for a malformed token, with no statement', async () => {
    for (const token of ['', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, `${'A'.repeat(42)}/`, undefined, 42]) {
      expect(await capability.find(token as string)).toBeNull();
    }
  });
});

describe('the DDL', () => {
  it('names each table under the prefix, with the index revoke reads', () => {
    expect(suppressionStoreDdl('acme')).toContain('CREATE TABLE IF NOT EXISTS acme_suppressions (');
    expect(suppressionStoreDdl('acme')).toContain('PRIMARY KEY (scope, address_hash)');
    expect(recipientCapabilityDdl('acme')).toContain('CREATE TABLE IF NOT EXISTS acme_capabilities (');
    expect(recipientCapabilityDdl('acme')).toContain('token_hash TEXT PRIMARY KEY');
    expect(recipientCapabilityDdl('acme')).toContain('revoked_at BIGINT');
    expect(recipientCapabilityDdl('acme')).toContain('CREATE INDEX IF NOT EXISTS acme_capabilities_recipient ON acme_capabilities (recipient);');
    expect(emailPreferencesDdl('acme')).toContain(suppressionStoreDdl('acme'));
    expect(emailPreferencesDdl('acme')).toContain(recipientCapabilityDdl('acme'));
    expect(suppressionStoreDdl('a'.repeat(40))).toContain(`${'a'.repeat(40)}_suppressions`);
  });

  it('refuses a prefix that is not a lower-case letter and at most 39 lower-case letters, digits or underscores', () => {
    for (const prefix of ['', '9mail', 'Mail', 'has-dash', 'mail;', 'a'.repeat(41), 7]) {
      expect(() => suppressionStoreDdl(prefix as string)).toThrow(RangeError);
      expect(() => recipientCapabilityDdl(prefix as string)).toThrow(RangeError);
      expect(() => emailPreferencesDdl(prefix as string)).toThrow(RangeError);
      expect(() => new SqlSuppressionStore(untouched, prefix as string)).toThrow(RangeError);
      expect(() => new SqlRecipientCapability(untouched, prefix as string)).toThrow(RangeError);
    }
  });
});
