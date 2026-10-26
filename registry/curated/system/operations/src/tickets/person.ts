/**
 * @fileoverview The person's side (D8, D9, D11, D12, D14, D18, D19): `open` writes the request,
 * its anonymous id and its first message in one transaction, the quota and cooldown read from one
 * COUNT inside it, the pictures attached, the links cut; `list` and `get` read the person's own
 * requests, `get` and `read` marking the thread read; `write` adds a message under the hourly
 * rate, reopening a resolved request with its system message and refusing a closed one; `share`
 * turns the identity switch; `resolve` marks the person's own request resolved. A request that is
 * not the person's answers `not_found`, never `forbidden` (D4). A first picture asks for the tick
 * D41 names: a write that attaches pictures without `consent` answers `consent_needed`, and the
 * first consent given is recorded on the request and never replaced (D18, D42). After a commit the
 * bell rings for staff (D15) and, for a new request, the team alert goes without the id or the
 * words (D16).
 */
import type { OpsMessage, OpsOpenInput, OpsPerson, OpsRefusal, OpsTicket, OpsTicketWrite } from '../contract.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import { insertTicket } from './anonymous.js';
import type { TicketsCore } from './core.js';
import { cursorOf, offsetOf } from './cursor.js';
import { checkMessageRate, checkOpenInput, checkOpenQuota, checkWriteInput, consentOf, pictureIdsOf, picturesOnTicket } from './limits.js';
import { cutTokenLinks } from './links.js';
import { insertMessage, loadMessage, messageAt, messageView, picturesByMessage, readThread } from './messages.js';
import { ringBell } from './outbox.js';
import { attachPictures } from './pictures.js';
import { RefusedInside, isRefusal, notFound, refusal, refusable, refuseInside } from './refusals.js';
import { loadOwnTicket, loadTicket, personTicket, timeOf, type TicketRow } from './states.js';
import { writeSystemMessage } from './system.js';

/** Requests a page of the person's list holds. */
export const PERSON_PAGE = 25;

/** Whether `actor` is a person as the contract shapes one: an account id and a plan word, each a short string. */
export const isPerson = (actor: unknown): actor is OpsPerson => {
  if (typeof actor !== 'object' || actor === null) return false;
  const { accountId, plan } = actor as { accountId?: unknown; plan?: unknown };
  return typeof accountId === 'string' && accountId.length > 0 && accountId.length <= 128 && typeof plan === 'string' && plan.length <= 64;
};

/** The person's functions over `core`. */
export function createPerson(core: TicketsCore) {
  const { db, tables, limits, host } = core;

  /** The fresh row of `id` as the person's view. */
  async function view(id: string): Promise<OpsTicket | OpsRefusal> {
    const fresh = await loadTicket(db, tables.tickets, id);
    return fresh === null ? notFound() : personTicket(fresh);
  }

  return {
    async open(actor: OpsPerson, input: OpsOpenInput): Promise<OpsTicket | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      const refused = checkOpenInput(input, limits, host);
      if (refused !== null) return refused;
      const pictureIds = pictureIdsOf(input) ?? [];
      const consent = consentOf(input) ?? null;
      if (pictureIds.length > 0 && consent === null) return refusal('consent_needed', 428);
      const subject = cutTokenLinks(input.subject, host.tokenPaths);
      const body = cutTokenLinks(input.body, host.tokenPaths);
      const now = core.now();
      const answer = await refusable(() =>
        db.transaction(async (trx) => {
          const quota = await checkOpenQuota(trx, tables.tickets, actor.accountId, now, limits);
          if (quota !== null) throw new RefusedInside(quota);
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
      // The alert names the category and the request's id for the admin link, never the words or the anonymous id (D16).
      if (core.alerts !== null) await core.alerts.send('requests', { category: fresh.category, request: fresh.id });
      return personTicket(fresh);
    },

    async list(actor: OpsPerson, cursor?: string): Promise<{ readonly tickets: readonly OpsTicket[]; readonly cursor: string | null }> {
      if (!isPerson(actor)) return { tickets: [], cursor: null };
      const offset = offsetOf(cursor);
      const rows = await db.all<TicketRow>(
        `SELECT * FROM ${tables.tickets} WHERE account_id = ? ORDER BY created_at DESC, id DESC LIMIT ${PERSON_PAGE + 1} OFFSET ${offset}`,
        [actor.accountId],
      );
      return {
        tickets: rows.slice(0, PERSON_PAGE).map(personTicket),
        cursor: rows.length > PERSON_PAGE ? cursorOf(offset + PERSON_PAGE) : null,
      };
    },

    async get(actor: OpsPerson, id: string): Promise<{ readonly ticket: OpsTicket; readonly messages: readonly OpsMessage[] } | null> {
      if (!isPerson(actor)) return null;
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return null;
      const now = core.now();
      await db.run(`UPDATE ${tables.tickets} SET person_read_at = ? WHERE id = ?`, [now, row.id]);
      const messages = await readThread(db, tables, row.id);
      return { ticket: personTicket({ ...row, person_read_at: now }), messages };
    },

    async read(actor: OpsPerson, id: string): Promise<void | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      await db.run(`UPDATE ${tables.tickets} SET person_read_at = ? WHERE id = ?`, [core.now(), row.id]);
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
      if (pictureIds.length > 0 && consent === null) return refusal('consent_needed', 428);
      const body = cutTokenLinks(input.body, host.tokenPaths);
      const now = core.now();
      const answer = await refusable(() =>
        db.transaction(async (trx) => {
          const rate = await checkMessageRate(trx, tables.messages, actor.accountId, now, limits);
          if (rate !== null) throw new RefusedInside(rate);
          if (pictureIds.length > 0 && (await picturesOnTicket(trx, tables.attachments, row.id)) + pictureIds.length > limits.picturesPerTicket) {
            refuseInside('too_many_pictures', 409);
          }
          let at = messageAt(row, now);
          if (row.state === 'resolved') {
            await trx.run(`UPDATE ${tables.tickets} SET state = 'open', resolved_at = NULL, updated_at = ? WHERE id = ?`, [now, row.id]);
            const reopened = await writeSystemMessage(trx, tables, row, 'reopened', {}, now);
            at = reopened.at + 1;
          }
          if (consent !== null && timeOf(row.consent_at) === null) {
            await trx.run(`UPDATE ${tables.tickets} SET consent_at = ?, consent_version = ? WHERE id = ?`, [now, clean(consent.version), row.id]);
          }
          const messageId = await insertMessage(trx, tables, {
            ticketId: row.id,
            sender: 'person',
            senderAccountId: actor.accountId,
            body,
            mailState: null,
            notifiedAt: null,
            at,
          });
          if (pictureIds.length > 0) await attachPictures(trx, tables, pictureIds, row.id, messageId, actor.accountId);
          await core.notifyWrite(trx, row.id);
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
      await db.transaction(async (trx) => {
        await trx.run(`UPDATE ${tables.tickets} SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, row.id]);
        await writeSystemMessage(trx, tables, row, 'resolved_by_person', {}, now);
        await core.notifyWrite(trx, row.id);
      });
      core.streams.wake(row.id);
      return view(row.id);
    },
  };
}
