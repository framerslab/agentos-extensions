/**
 * The suppression record and the recipient capability on real databases through `@framers/sql-storage-adapter`: SQLite
 * through sql.js, in memory, always, and PostgreSQL when `AGENTOS_TEST_POSTGRES_URL` names a server, as CI's build job
 * does. Each run makes its tables under prefixes of its own and drops them at the end.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresAdapter, createSqlJsAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import {
  DEFAULT_SUPPRESSION_SCOPE,
  SqlRecipientCapability,
  SqlSuppressionStore,
  emailPreferencesDdl,
  recipientCapabilityDdl,
  suppressionStoreDdl,
} from '../src/index';

const postgresUrl = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !postgresUrl) throw new Error('email_preferences_database_required');

/**
 * One database as two hosts reach it: on PostgreSQL each through a pool of its own; sql.js keeps its database in the
 * memory of one handle, so there both are that handle.
 */
interface Handles {
  db: StorageAdapter;
  peer: StorageAdapter;
  close(): Promise<void>;
}

const backends: Array<{ name: string; open(): Promise<Handles> }> = [
  {
    name: 'SQLite through sql.js',
    async open() {
      const db = createSqlJsAdapter();
      await db.open();
      return { db, peer: db, close: () => db.close() };
    },
  },
];
if (postgresUrl) {
  backends.push({
    name: 'PostgreSQL',
    async open() {
      const db = createPostgresAdapter({ connectionString: postgresUrl, max: 4 });
      const peer = createPostgresAdapter({ connectionString: postgresUrl, max: 4 });
      await db.open();
      await peer.open();
      return {
        db,
        peer,
        close: async () => {
          await db.close();
          await peer.close();
        },
      };
    },
  });
}

/** A prefix no other run uses: `ep_` and twelve hexadecimal characters. */
function freshPrefix(): string {
  return `ep_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** How a host names an address to the store: the SHA-256 of the address lower-cased, in hex. */
function hashOf(address: string): string {
  return createHash('sha256').update(address.toLowerCase()).digest('hex');
}

/** The host's key, and another host's. */
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);

describe.each(backends)('the preference stores on $name', ({ open }) => {
  let handles: Handles;
  /** Tables made by the two DDL functions one by one. */
  const first = freshPrefix();
  /** Tables made by the DDL of both: a second host on the same database. */
  const second = freshPrefix();

  beforeAll(async () => {
    handles = await open();
    await handles.db.exec(suppressionStoreDdl(first));
    await handles.db.exec(recipientCapabilityDdl(first));
    await handles.db.exec(emailPreferencesDdl(second));
  });

  afterAll(async () => {
    if (!handles) return;
    for (const prefix of [first, second]) {
      await handles.db.exec(`DROP TABLE IF EXISTS ${prefix}_suppressions`);
      await handles.db.exec(`DROP TABLE IF EXISTS ${prefix}_capabilities`);
    }
    await handles.close();
  });

  describe('the suppression record', () => {
    it('keeps one row for an address suppressed twice, as the first suppression wrote it', async () => {
      const store = new SqlSuppressionStore(handles.db, first);
      const hash = hashOf('Bounced@Example.com');
      expect(await store.suppress('mail', hash, 'bounce', '2026-10-15')).toBe(true);
      expect(await store.suppress('mail', hash, 'complaint', '2026-10-16')).toBe(false);
      expect(
        await handles.db.all(
          `SELECT scope, address_hash, reason, suppressed_on FROM ${first}_suppressions WHERE address_hash = ?`,
          [hash],
        ),
      ).toEqual([{ scope: 'mail', address_hash: hash, reason: 'bounce', suppressed_on: '2026-10-15' }]);
    });

    it('answers for the scope asked about, and keeps a row for each scope an address is suppressed in', async () => {
      const store = new SqlSuppressionStore(handles.db, first);
      const hash = hashOf('scoped@example.com');
      expect(await store.isSuppressed(DEFAULT_SUPPRESSION_SCOPE, hash)).toBe(false);
      expect(await store.suppress(DEFAULT_SUPPRESSION_SCOPE, hash, 'complaint', '2026-10-15')).toBe(true);
      expect(await store.isSuppressed(DEFAULT_SUPPRESSION_SCOPE, hash)).toBe(true);
      expect(await store.isSuppressed('announcements', hash)).toBe(false);
      expect(await store.isSuppressed(DEFAULT_SUPPRESSION_SCOPE, hashOf('someone-else@example.com'))).toBe(false);
      expect(await store.suppress('announcements', hash, 'manual', '2026-10-17')).toBe(true);
      expect(await store.isSuppressed('announcements', hash)).toBe(true);
      expect(
        await handles.db.all(`SELECT scope FROM ${first}_suppressions WHERE address_hash = ? ORDER BY scope`, [hash]),
      ).toEqual([{ scope: 'announcements' }, { scope: DEFAULT_SUPPRESSION_SCOPE }]);
    });

    it('keeps the record of the provider refusing an address on its own list', async () => {
      const store = new SqlSuppressionStore(handles.db, first);
      const hash = hashOf('listed@example.com');
      expect(await store.suppress('mail', hash, 'suppressed', '2026-10-15')).toBe(true);
      expect(await store.isSuppressed('mail', hash)).toBe(true);
    });

    it('records one row when two hosts suppress the same address at once', async () => {
      const hash = hashOf('raced@example.com');
      const written = await Promise.all([
        new SqlSuppressionStore(handles.db, first).suppress('mail', hash, 'bounce', '2026-10-15'),
        new SqlSuppressionStore(handles.peer, first).suppress('mail', hash, 'complaint', '2026-10-15'),
      ]);
      expect(written.filter((wrote) => wrote)).toHaveLength(1);
      expect(await handles.db.all(`SELECT reason FROM ${first}_suppressions WHERE address_hash = ?`, [hash])).toHaveLength(1);
    });

    it('keeps two hosts apart by their prefixes on one database', async () => {
      const ours = new SqlSuppressionStore(handles.db, first);
      const theirs = new SqlSuppressionStore(handles.db, second);
      const hash = hashOf('two-hosts@example.com');
      expect(await ours.suppress('mail', hash, 'bounce', '2026-10-15')).toBe(true);
      expect(await theirs.isSuppressed('mail', hash)).toBe(false);
      expect(await handles.db.get(`SELECT address_hash FROM ${second}_suppressions WHERE address_hash = ?`, [hash])).toBeNull();
      expect(await theirs.suppress('mail', hash, 'manual', '2026-10-16')).toBe(true);
      expect(await theirs.isSuppressed('mail', hash)).toBe(true);
    });

    it('holds the hash and never the address, and refuses an address given in place of its hash', async () => {
      const store = new SqlSuppressionStore(handles.db, first);
      await store.suppress('mail', hashOf('held@example.com'), 'bounce', '2026-10-15');
      await expect(store.suppress('mail', 'reader@example.com', 'bounce', '2026-10-15')).rejects.toThrow(TypeError);
      await expect(store.isSuppressed('mail', 'held@example.com')).rejects.toThrow(TypeError);
      const rows = await handles.db.all(`SELECT * FROM ${first}_suppressions`);
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toMatch(/@|example\.com/);
    });

    it('runs its DDL again without an error and keeps the rows', async () => {
      const store = new SqlSuppressionStore(handles.db, second);
      const hash = hashOf('kept@example.com');
      await store.suppress('mail', hash, 'complaint', '2026-10-15');
      await handles.db.exec(emailPreferencesDdl(second));
      await handles.db.exec(suppressionStoreDdl(second));
      expect(await store.isSuppressed('mail', hash)).toBe(true);
    });
  });

  describe('the recipient capability', () => {
    it('finds the recipient and the scope a token was issued for', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-1', 'minutes', 'message-1', KEY);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await capability.find(token)).toEqual({ recipient: 'account-1', scope: 'minutes' });
    });

    it('draws one token from one nonce under one key, so a retried message carries the token it first carried', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-2', 'minutes', 'message-2', KEY);
      expect(token).toBe(createHmac('sha256', KEY).update('message-2').digest('base64url'));
      expect(await capability.issue('account-2', 'minutes', 'message-2', KEY)).toBe(token);
      expect(await handles.db.all(`SELECT scope FROM ${first}_capabilities WHERE recipient = ?`, ['account-2'])).toHaveLength(1);
      expect(await capability.issue('account-2', 'minutes', 'message-3', KEY)).not.toBe(token);
      expect(await capability.issue('account-2', 'minutes', 'message-2', OTHER_KEY)).not.toBe(token);
    });

    it('finds nothing for a tampered, cut, lengthened, malformed or unknown token', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-3', 'sessions', 'message-4', KEY);
      const tampered = `${token.charAt(0) === 'A' ? 'B' : 'A'}${token.slice(1)}`;
      const unknown = createHmac('sha256', KEY).update('never-issued').digest('base64url');
      for (const candidate of [tampered, token.slice(0, 42), `${token}A`, `${token.slice(0, 42)}=`, `+${token.slice(1)}`, '', unknown]) {
        expect(await capability.find(candidate)).toBeNull();
      }
      expect(await capability.find(undefined as unknown as string)).toBeNull();
      expect(await capability.find(token)).toEqual({ recipient: 'account-3', scope: 'sessions' });
    });

    it("ends every token of a recipient on revoke, and no other recipient's", async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const minutes = await capability.issue('account-4', 'minutes', 'message-5', KEY);
      const sessions = await capability.issue('account-4', 'sessions', 'message-6', KEY);
      const kept = await capability.issue('account-5', 'minutes', 'message-7', KEY);
      expect(await capability.revoke('account-4')).toBe(2);
      expect(await capability.find(minutes)).toBeNull();
      expect(await capability.find(sessions)).toBeNull();
      expect(await capability.find(kept)).toEqual({ recipient: 'account-5', scope: 'minutes' });
      expect(await capability.revoke('account-4')).toBe(0);
      const later = await capability.issue('account-4', 'minutes', 'message-8', KEY);
      expect(await capability.find(later)).toEqual({ recipient: 'account-4', scope: 'minutes' });
    });

    it('never issues a revoked nonce again, so an old link cannot come to name another recipient or scope', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-11', 'minutes', 'message-14', KEY);
      expect(await capability.revoke('account-11')).toBe(1);
      await expect(capability.issue('account-12', 'minutes', 'message-14', KEY)).rejects.toThrow();
      await expect(capability.issue('account-11', 'sessions', 'message-14', KEY)).rejects.toThrow();
      await expect(capability.issue('account-11', 'minutes', 'message-14', KEY)).rejects.toThrow();
      expect(await capability.find(token)).toBeNull();
      expect(await handles.db.all(`SELECT recipient FROM ${first}_capabilities WHERE recipient = ?`, ['account-12'])).toEqual([]);
      const fresh = await capability.issue('account-11', 'minutes', 'message-15', KEY);
      expect(await capability.find(fresh)).toEqual({ recipient: 'account-11', scope: 'minutes' });
    });

    it('keeps the revoke of a token that another host is issuing at the same moment', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const peer = new SqlRecipientCapability(handles.peer, first);
      const token = await capability.issue('account-13', 'minutes', 'message-16', KEY);
      const [revoked, reissued] = await Promise.allSettled([
        peer.revoke('account-13'),
        capability.issue('account-13', 'minutes', 'message-16', KEY),
      ]);
      expect(revoked).toEqual({ status: 'fulfilled', value: 1 });
      expect(reissued.status === 'rejected' || (reissued.status === 'fulfilled' && reissued.value === token)).toBe(true);
      expect(await capability.find(token)).toBeNull();
    });

    it('ends the tokens on revoke when the clock answers no number, and keeps their rows', async () => {
      const capability = new SqlRecipientCapability(handles.db, first, { now: () => Number.NaN });
      const token = await capability.issue('account-14', 'minutes', 'message-17', KEY);
      expect(await capability.revoke('account-14')).toBe(1);
      expect(await capability.find(token)).toBeNull();
      expect(await capability.revoke('account-14')).toBe(0);
      const rows = await handles.db.all<{ revoked_at: unknown }>(
        `SELECT revoked_at FROM ${first}_capabilities WHERE recipient = ?`,
        ['account-14'],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    });

    it("refuses a name a text column cannot hold as given, so a revoke never ends another recipient's tokens", async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      // UTF-8 has no lone surrogates: node-postgres writes U+FFFD in their place, so on PostgreSQL this revoke ended it.
      const kept = await capability.issue('account-15�', 'minutes', 'message-18', KEY);
      await expect(capability.revoke('account-15\uD800')).rejects.toThrow(TypeError);
      expect(await capability.find(kept)).toEqual({ recipient: 'account-15�', scope: 'minutes' });
      for (const [recipient, scope, nonce] of [
        ['account-16\uD800', 'minutes', 'message-19'],
        ['account-16', 'minutes\u0000', 'message-19'],
        ['account-16', 'minutes', 'message-19\uDC00'],
      ]) {
        await expect(capability.issue(recipient, scope, nonce, KEY)).rejects.toThrow(TypeError);
      }
      expect(await handles.db.all(`SELECT recipient FROM ${first}_capabilities WHERE recipient = ?`, ['account-16'])).toEqual([]);
    });

    it('keeps a name with characters past U+FFFF as it was given', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-17-\u{1F600}', 'minutes-\u{20000}', 'message-20-\u{1F600}', KEY);
      expect(await capability.find(token)).toEqual({ recipient: 'account-17-\u{1F600}', scope: 'minutes-\u{20000}' });
      expect(await capability.issue('account-17-\u{1F600}', 'minutes-\u{20000}', 'message-20-\u{1F600}', KEY)).toBe(token);
      expect(await capability.revoke('account-17-\u{1F600}')).toBe(1);
      expect(await capability.find(token)).toBeNull();
    });

    it('keeps the SHA-256 of each token beside its recipient and scope, and never the token', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-6', 'imports', 'message-9', KEY);
      const rows = await handles.db.all<Record<string, unknown>>(
        `SELECT token_hash, recipient, scope, expires_at FROM ${first}_capabilities WHERE recipient = ?`,
        ['account-6'],
      );
      expect(rows).toEqual([
        { token_hash: createHash('sha256').update(token).digest('hex'), recipient: 'account-6', scope: 'imports', expires_at: null },
      ]);
      expect(JSON.stringify(await handles.db.all(`SELECT * FROM ${first}_capabilities`))).not.toContain(token);
    });

    it('refuses a nonce issued for one recipient and scope when another recipient or scope asks for it', async () => {
      const capability = new SqlRecipientCapability(handles.db, first);
      const token = await capability.issue('account-7', 'minutes', 'message-10', KEY);
      await expect(capability.issue('account-8', 'minutes', 'message-10', KEY)).rejects.toThrow();
      await expect(capability.issue('account-7', 'sessions', 'message-10', KEY)).rejects.toThrow();
      expect(await capability.find(token)).toEqual({ recipient: 'account-7', scope: 'minutes' });
      expect(await handles.db.all(`SELECT recipient FROM ${first}_capabilities WHERE recipient = ?`, ['account-8'])).toEqual([]);
    });

    it("keeps two hosts apart by their prefixes, and finds a token through another host's pool", async () => {
      const token = await new SqlRecipientCapability(handles.db, first).issue('account-9', 'minutes', 'message-11', KEY);
      expect(await new SqlRecipientCapability(handles.db, second).find(token)).toBeNull();
      expect(await new SqlRecipientCapability(handles.peer, first).find(token)).toEqual({ recipient: 'account-9', scope: 'minutes' });
    });

    it('finds nothing once an expiry the caller set has passed, and never expires a token issued without one', async () => {
      let now = 1_000_000;
      const capability = new SqlRecipientCapability(handles.db, first, { now: () => now });
      const brief = await capability.issue('account-10', 'minutes', 'message-12', KEY, { expiresAt: 1_060_000 });
      const lasting = await capability.issue('account-10', 'minutes', 'message-13', KEY);
      expect(await capability.find(brief)).toEqual({ recipient: 'account-10', scope: 'minutes' });
      expect(await capability.issue('account-10', 'minutes', 'message-12', KEY, { expiresAt: 1_060_000 })).toBe(brief);
      await expect(capability.issue('account-10', 'minutes', 'message-12', KEY, { expiresAt: 2_000_000 })).rejects.toThrow();
      now = 1_060_000;
      expect(await capability.find(brief)).toBeNull();
      now = Number.MAX_SAFE_INTEGER;
      expect(await capability.find(lasting)).toEqual({ recipient: 'account-10', scope: 'minutes' });
    });
  });
});
