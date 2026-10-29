/**
 * @fileoverview The anonymous id (D11): `P-` and six characters of Crockford's base 32 (the ten
 * digits and 22 letters, without I, L, O and U) from the platform's cryptographic random source,
 * drawn for one request alone and never for an account, so two requests of one person share
 * nothing staff can see. The request's insert draws again on a unique violation, up to five
 * times, after which the call fails with nothing written; a colliding id is never kept. Each byte
 * drawn gives one character (256 is eight alphabets of 32, so every character is equally likely).
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { clean } from '../store/clean.js';

/** Crockford's base 32 alphabet, in order: https://www.crockford.com/base32.html. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** The characters after `P-`. 32 to the sixth is 1,073,741,824 ids. */
export const ANONYMOUS_LENGTH = 6;

/** How many times a request's insert draws an id before the call fails (D11). */
export const ANONYMOUS_DRAWS = 5;

/** A source of random bytes: fills `draw` and answers it. The default is the platform's. */
export type RandomSource = (draw: Uint8Array) => Uint8Array;

/** The platform's cryptographic random source (`globalThis.crypto`, which Node 22 and every browser give). */
export const cryptoRandom: RandomSource = (draw) => {
  globalThis.crypto.getRandomValues(draw);
  return draw;
};

/** The id the first six bytes of `bytes` spell: each byte's low five bits index the alphabet. */
export function anonymousIdFrom(bytes: Uint8Array): string {
  let id = 'P-';
  for (let index = 0; index < ANONYMOUS_LENGTH; index += 1) id += CROCKFORD.charAt((bytes[index] ?? 0) & 31);
  return id;
}

/** A fresh id from `random`. */
export function drawAnonymousId(random: RandomSource = cryptoRandom): string {
  return anonymousIdFrom(random(new Uint8Array(ANONYMOUS_LENGTH)));
}

/** A request to insert (D8): its columns at opening; the anonymous id is drawn here. */
export interface NewTicket {
  readonly id: string;
  readonly accountId: string;
  readonly subject: string;
  readonly category: string;
  readonly source: 'person' | 'staff' | 'system';
  readonly claimedBy: string | null;
  readonly shareIdentity: boolean;
  readonly planAtOpen: string | null;
  readonly consentAt: number | null;
  readonly consentVersion: string | null;
  readonly createdAt: number;
}

/** The savepoint a draw's insert runs under on PostgreSQL, where a refused statement aborts the transaction. */
const DRAW_SAVEPOINT = 'ops_anonymous_draw';

/**
 * Inserts `ticket` through `writer`, the transaction of its write, with a fresh anonymous id; on a
 * unique violation of the id it draws again, up to `ANONYMOUS_DRAWS` times, then throws, and the
 * transaction around it rolls back with nothing written (D11). On PostgreSQL each attempt runs
 * under a savepoint, since a refused statement aborts the transaction there; SQLite needs none.
 * Answers the id the request took.
 */
export async function insertTicket(writer: StorageAdapter, table: string, postgres: boolean, random: RandomSource, ticket: NewTicket): Promise<string> {
  for (let draw = 0; draw < ANONYMOUS_DRAWS; draw += 1) {
    const anonymousId = drawAnonymousId(random);
    if (postgres) await writer.exec(`SAVEPOINT ${DRAW_SAVEPOINT}`);
    try {
      await writer.run(
        `INSERT INTO ${table} (id, account_id, anonymous_id, subject, category, priority, state, source, claimed_by, share_identity, identity_opened_at,
           consent_at, consent_version, plan_at_open, person_read_at, staff_read_at, last_person_at, last_staff_at, last_system_at, last_mail_at,
           resolved_at, closed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'normal', 'open', ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        [
          ticket.id,
          ticket.accountId,
          anonymousId,
          clean(ticket.subject),
          ticket.category,
          ticket.source,
          ticket.claimedBy,
          ticket.shareIdentity ? 1 : 0,
          ticket.consentAt,
          ticket.consentVersion,
          ticket.planAtOpen,
          ticket.createdAt,
          ticket.createdAt,
        ],
      );
      if (postgres) await writer.exec(`RELEASE SAVEPOINT ${DRAW_SAVEPOINT}`);
      return anonymousId;
    } catch (error) {
      if (!(await isUnique(error))) throw error;
      if (postgres) {
        await writer.exec(`ROLLBACK TO SAVEPOINT ${DRAW_SAVEPOINT}`);
        await writer.exec(`RELEASE SAVEPOINT ${DRAW_SAVEPOINT}`);
      }
    }
  }
  throw new Error(`the anonymous id collided ${ANONYMOUS_DRAWS} times in a row, so the request was not written`);
}

let uniqueCheck: Promise<(error: unknown) => boolean> | null = null;

/**
 * Whether `error` is a unique violation, through the adapter's own `isUniqueViolation`, which
 * reads PostgreSQL's 23505 and every SQLite engine's wording alike. The adapter is an optional
 * peer loaded at the first call, never at this module's import, so an entry that needs no
 * database still imports (D49).
 */
export function isUnique(error: unknown): Promise<boolean> {
  if (uniqueCheck === null) {
    uniqueCheck = import('@framers/sql-storage-adapter').then((adapter) => adapter.isUniqueViolation);
  }
  return uniqueCheck.then((check) => check(error));
}
