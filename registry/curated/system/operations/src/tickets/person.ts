/**
 * @fileoverview The person's side (D8, D9, D11, D12, D14, D18, D19): `open` writes the request,
 * its anonymous id and its first message in one transaction, the quota and cooldown read from one
 * COUNT inside it and the hourly message rate beside it, the pictures attached, the links cut;
 * `list` and `get` read the person's own requests, `get` and `read` marking the thread read up to
 * its newest message; `write` adds a message under the hourly rate, reopening a resolved request
 * with its system message and refusing a closed one; `share` turns the identity switch; `resolve`
 * marks the person's own request resolved. Inside each write's transaction the account's lock runs
 * one person's checks one at a time, and the request's row is read again and, on PostgreSQL,
 * locked, so the message's time comes from the newest pointers (D12, D13). A request that is not
 * the person's answers `not_found`, never `forbidden` (D4). A request's first picture asks for the
 * tick D41 names: a write that attaches pictures to a request holding no consent yet, without
 * `consent`, answers `consent_needed`; the first consent given is recorded on the request and never
 * replaced, and later pictures on it ask for nothing (D18, D42). After a commit the bell rings for
 * staff (D15) and, for a new request, the team alert goes without the id or the words (D16), behind
 * the answer: `open` never waits on the alert's mail, and `stop()` waits for one still in flight
 * within its 3 seconds.
 */
import type { OpsMessage, OpsOpenInput, OpsPerson, OpsRefusal, OpsTicket, OpsTicketWrite } from '../contract.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import { isPerson } from './actors.js';
import { insertTicket } from './anonymous.js';
import type { TicketsCore } from './core.js';
import { cursorOfKey, keyOf } from './cursor.js';
import { checkMessageRate, checkOpenInput, checkOpenQuota, checkWriteInput, consentOf, pictureIdsOf, picturesOnTicket } from './limits.js';
import { storableText } from './links.js';
import { insertMessage, loadMessage, messageAt, messageView, picturesByMessage, readThread } from './messages.js';
import { ringBell } from './outbox.js';
import { attachPictures } from './pictures.js';
import { RefusedInside, isRefusal, notFound, refusal, refusable, refuseInside } from './refusals.js';
import { latestMessageAt, loadOwnTicket, loadTicket, lockTicket, numberOf, personTicket, timeOf, type TicketRow } from './states.js';
import { writeSystemMessage } from './system.js';

/** Requests a page of the person's list holds. */
export const PERSON_PAGE = 25;

/** The person's functions over `core`. */
export function createPerson(core: TicketsCore) {
  const { db, tables, limits, host } = core;

  /** The fresh row of `id` as the person's view. */
  async function view(id: string): Promise<OpsTicket | OpsRefusal> {
    const fresh = await loadTicket(db, tables.tickets, id);
    return fresh === null ? notFound() : personTicket(fresh);
  }

  /**
   * The time a read marks: the newest of the request's pointers (a message's time is bumped past
   * the newest before it, so a thread staff opened dates its first reply after its system message)
   * and of the messages the read answered, a reply that landed between the row and the thread
   * included, and never the clock, so a reply the person has just read is never mailed and a reply
   * that landed after the thread was read, during the pictures' read, stays unread and is mailed
   * (D14). The clock only for a request with no message, which the package never writes.
   */
  const readAt = (row: TicketRow, messages: readonly OpsMessage[] = []): number => {
    const newest = Math.max(latestMessageAt(row) ?? 0, ...messages.map((message) => message.createdAt));
    return newest > 0 ? newest : core.now();
  };

  return {
    async open(actor: OpsPerson, input: OpsOpenInput): Promise<OpsTicket | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      const refused = checkOpenInput(input, limits, host);
      if (refused !== null) return refused;
      const pictureIds = pictureIdsOf(input) ?? [];
      const consent = consentOf(input) ?? null;
      if (pictureIds.length > 0 && consent === null) return refusal('consent_needed', 428);
      // Cleaned before their links are cut: a control character inside a path never hides the path from the cut (D19, D26).
      const subject = storableText(input.subject, host.tokenPaths);
      const body = storableText(input.body, host.tokenPaths);
      const now = core.now();
      const answer = await refusable(() =>
        db.transaction(async (trx) => {
          // The account's lock, then its liveness: a deletion in flight commits first, and an account gone or deleting takes no request after it (D20).
          if (!(await core.lockLiveAccount(trx, actor.accountId))) refuseInside('not_found', 404);
          // A request removed in the last day counts as a kept one does, by the process's memory of it (D46): open, remove, open is refused as open, open is.
          const quota = await checkOpenQuota(trx, tables.tickets, actor.accountId, now, limits, core.removed.openings(actor.accountId, now));
          if (quota !== null) throw new RefusedInside(quota);
          // The request's first message counts toward the hour's thirty, as every message of the person's does (D12).
          const rate = await checkMessageRate(trx, tables.messages, actor.accountId, now, limits, core.removed.messages(actor.accountId, now));
          if (rate !== null) throw new RefusedInside(rate);
          const id = newId('tkt');
          await insertTicket(trx, tables.tickets, core.postgres, core.random, {
            id,
            accountId: actor.accountId,
            subject,
            category: input.category,
            source: 'person',
            claimedBy: null,
            shareIdentity: false,
            planAtOpen: clean(actor.plan),
            consentAt: consent === null ? null : now,
            consentVersion: consent === null ? null : clean(consent.version),
            createdAt: now,
          });
          const messageId = await insertMessage(trx, tables, {
            ticketId: id,
            sender: 'person',
            senderAccountId: actor.accountId,
            body,
            mailState: null,
            notifiedAt: null,
            at: now,
          });
          if (pictureIds.length > 0) await attachPictures(trx, tables, pictureIds, id, messageId, actor.accountId);
          await core.notifyWrite(trx, id);
          return { id, messageId };
        }),
      );
      if (isRefusal(answer)) return answer;
      core.streams.wake(answer.id);
      const fresh = await loadTicket(db, tables.tickets, answer.id);
      if (fresh === null) return notFound();
      const message = await loadMessage(db, tables, answer.messageId);
      if (message !== null) await ringBell(core, message, fresh, now);
      // The alert names the category and the request's id for the admin link, never the words or the anonymous id (D16). It goes behind the
      // answer: the request is written and the bell has rung, so a host mail that is slow or never settles holds no answer, which a timeout
      // would turn into an error and a retry into ticket_cooldown for a request that exists. A failed send keeps its own ops_mail line.
      if (core.alerts !== null) void core.alerts.send('requests', { category: fresh.category, request: fresh.id }).catch(() => undefined);
      return personTicket(fresh);
    },

    async list(actor: OpsPerson, cursor?: string): Promise<{ readonly tickets: readonly OpsTicket[]; readonly cursor: string | null }> {
      if (!isPerson(actor)) return { tickets: [], cursor: null };
      // Newest first, each page from the last request the page before it showed (its time and id), so a request opened between two pages repeats nothing and hides nothing older (D10).
      const key = keyOf(cursor);
      const rows =
        key === null
          ? await db.all<TicketRow>(`SELECT * FROM ${tables.tickets} WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ${PERSON_PAGE + 1}`, [actor.accountId])
          : await db.all<TicketRow>(
              `SELECT * FROM ${tables.tickets} WHERE account_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ${PERSON_PAGE + 1}`,
              [actor.accountId, key.at, key.at, key.id],
            );
      const page = rows.slice(0, PERSON_PAGE);
      const last = page.at(-1);
      return {
        tickets: page.map(personTicket),
        cursor: rows.length > PERSON_PAGE && last !== undefined ? cursorOfKey(numberOf(last.created_at), last.id) : null,
      };
    },

    async get(actor: OpsPerson, id: string): Promise<{ readonly ticket: OpsTicket; readonly messages: readonly OpsMessage[] } | null> {
      if (!isPerson(actor)) return null;
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return null;
      // The thread first, then the marker, which covers every message answered: a reply that landed between the two reads is read, never mailed (D14).
      const messages = await readThread(db, tables, row.id);
      const at = readAt(row, messages);
      // Never backwards: an older read that finishes after a newer one leaves the newer marker, so a reply the person read is not mailed (D14).
      await db.run(`UPDATE ${tables.tickets} SET person_read_at = ? WHERE id = ? AND (person_read_at IS NULL OR person_read_at < ?)`, [at, row.id, at]);
      return { ticket: personTicket({ ...row, person_read_at: at }), messages };
    },

    async read(actor: OpsPerson, id: string, messageId?: string): Promise<void | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      if (messageId !== undefined && typeof messageId !== 'string') return refusal('refused', 400);
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      let at: number;
      if (messageId === undefined) {
        at = readAt(row);
      } else {
        // Bounded to the message the page delivered: a reply that landed after it and has not reached the page stays unread and is mailed (D14).
        const message = await loadMessage(db, tables, messageId);
        if (message === null || message.ticket_id !== row.id) return notFound();
        at = numberOf(message.created_at);
      }
      await db.run(`UPDATE ${tables.tickets} SET person_read_at = ? WHERE id = ? AND (person_read_at IS NULL OR person_read_at < ?)`, [at, row.id, at]);
      return undefined;
    },

    async write(actor: OpsPerson, id: string, input: OpsTicketWrite): Promise<OpsMessage | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      const refused = checkWriteInput(input, limits);
      if (refused !== null) return refused;
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      if (row.state === 'closed') return refusal('ticket_closed', 409);
      const pictureIds = pictureIdsOf(input) ?? [];
      const consent = consentOf(input) ?? null;
      // The tick is asked for once a request, at its first picture: a request already holding consent asks for nothing (D18, D42).
      if (pictureIds.length > 0 && consent === null && timeOf(row.consent_at) === null) return refusal('consent_needed', 428);
      const body = storableText(input.body, host.tokenPaths);
      const now = core.now();
      const answer = await refusable(() =>
        db.transaction(async (trx) => {
          await core.lockAccount(trx, actor.accountId);
          const rate = await checkMessageRate(trx, tables.messages, actor.accountId, now, limits, core.removed.messages(actor.accountId, now));
          if (rate !== null) throw new RefusedInside(rate);
          // The row read again and locked inside the transaction: the message's time comes from the newest pointers, and a state another write set meanwhile is seen (D13).
          const locked = await lockTicket(trx, tables.tickets, row.id, core.postgres);
          if (locked === null || locked.account_id !== actor.accountId) refuseInside('not_found', 404);
          if (locked.state === 'closed') refuseInside('ticket_closed', 409);
          if (pictureIds.length > 0 && (await picturesOnTicket(trx, tables.attachments, locked.id)) + pictureIds.length > limits.picturesPerTicket) {
            refuseInside('too_many_pictures', 409);
          }
          let at = messageAt(locked, now);
          if (locked.state === 'resolved') {
            await trx.run(`UPDATE ${tables.tickets} SET state = 'open', resolved_at = NULL, updated_at = ? WHERE id = ?`, [now, locked.id]);
            const reopened = await writeSystemMessage(trx, tables, locked, 'reopened', {}, now);
            at = reopened.at + 1;
          }
          if (consent !== null && timeOf(locked.consent_at) === null) {
            await trx.run(`UPDATE ${tables.tickets} SET consent_at = ?, consent_version = ? WHERE id = ?`, [now, clean(consent.version), locked.id]);
          }
          const messageId = await insertMessage(trx, tables, {
            ticketId: locked.id,
            sender: 'person',
            senderAccountId: actor.accountId,
            body,
            mailState: null,
            notifiedAt: null,
            at,
          });
          if (pictureIds.length > 0) await attachPictures(trx, tables, pictureIds, locked.id, messageId, actor.accountId);
          await core.notifyWrite(trx, locked.id);
          return messageId;
        }),
      );
      if (isRefusal(answer)) return answer;
      core.streams.wake(row.id);
      const message = await loadMessage(db, tables, answer);
      const fresh = await loadTicket(db, tables.tickets, row.id);
      if (message === null || fresh === null) return notFound();
      await ringBell(core, message, fresh, now);
      return messageView(message, (await picturesByMessage(db, tables, row.id)).get(message.id) ?? []);
    },

    async share(actor: OpsPerson, id: string, on: boolean): Promise<OpsTicket | OpsRefusal> {
      if (!isPerson(actor) || typeof on !== 'boolean') return refusal('refused', 400);
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      await db.run(`UPDATE ${tables.tickets} SET share_identity = ?, updated_at = ? WHERE id = ?`, [on ? 1 : 0, core.now(), row.id]);
      return view(row.id);
    },

    async resolve(actor: OpsPerson, id: string): Promise<OpsTicket | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      if (row.state === 'closed') return refusal('ticket_closed', 409);
      if (row.state === 'resolved') return personTicket(row);
      const now = core.now();
      const answer = await refusable(() =>
        db.transaction(async (trx) => {
          const locked = await lockTicket(trx, tables.tickets, row.id, core.postgres);
          if (locked === null) refuseInside('not_found', 404);
          if (locked.state === 'closed') refuseInside('ticket_closed', 409);
          if (locked.state === 'resolved') return;
          await trx.run(`UPDATE ${tables.tickets} SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, locked.id]);
          await writeSystemMessage(trx, tables, locked, 'resolved_by_person', {}, now);
          await core.notifyWrite(trx, locked.id);
        }),
      );
      if (isRefusal(answer)) return answer;
      core.streams.wake(row.id);
      return view(row.id);
    },
  };
}
