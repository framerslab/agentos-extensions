/**
 * @fileoverview Staff's side (D10, D11, D17): the list with its filters, its four counts and its
 * 7-day line, 25 a page by a cursor, urgent first then the longest waiting on the team; one request
 * with its thread (the anonymous id and the plan, or the name and address once shared or opened);
 * the reply, an owed mail and the person's bell; the claim; the priority; the state with its system
 * messages and the audit kind `support_state_changed`; the identity opening, which audits, writes
 * its system message and tells the person at once by mail and by the bell whatever the request's
 * state; the thread staff open to an account, identified from its start; and the counts. No answer
 * here carries the account id of a request whose identity is neither shared nor opened.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type {
  OpsDerivedState,
  OpsIdentity,
  OpsIdentityState,
  OpsMessage,
  OpsOpenInput,
  OpsRefusal,
  OpsStaff,
  OpsStaffFilter,
  OpsStaffPage,
  OpsStaffTicket,
  OpsTicketCounts,
  OpsTicketPriority,
  OpsTicketState,
  OpsTicketStats,
  OpsTicketWrite,
} from '../contract.js';
import { ownLine } from '../own-lines.js';
import { newId } from '../store/ids.js';
import { isStaff } from './actors.js';
import { insertTicket } from './anonymous.js';
import type { TicketsCore } from './core.js';
import { staffCursorOf, staffKeyOf, type StaffPageKey } from './cursor.js';
import { checkOpenInput, checkWriteInput, pictureIdsOf, picturesOnTicket } from './limits.js';
import { storableText } from './links.js';
import { insertMessage, loadMessage, messageAt, messageView, picturesByMessage, readThread } from './messages.js';
import { ringBell, sendIdentityMail } from './outbox.js';
import { attachPictures } from './pictures.js';
import { isRefusal, notFound, refusal, refusable, refuseInside } from './refusals.js';
import {
  derivedStateSql,
  identityVisible,
  latestMessageAt,
  loadTicket,
  lockTicket,
  numberOf,
  staffTicket,
  timeOf,
  waitingPersonSql,
  waitingTeamSql,
  type StaffIdentity,
  type TicketRow,
} from './states.js';
import { writeSystemMessage } from './system.js';

/** Requests a page of staff's list holds (D10). */
export const STAFF_PAGE = 25;

/** The list's ordering keys in SQL over the alias `t`: urgent and open first, then waiting on the team, then the longest waiting (the person's last message, else the opening), then the id. */
const URGENT_SQL = `CASE WHEN t.priority = 'urgent' AND t.state = 'open' THEN 0 ELSE 1 END`;
const WAITING_SQL = `CASE WHEN ${waitingTeamSql('t.')} THEN 0 ELSE 1 END`;
const SINCE_SQL = 'COALESCE(t.last_person_at, t.created_at)';

/** The ordering keys of `row`, as the SQL computes them, for the cursor of the page that ends with it. */
function orderingKeyOf(row: TicketRow): StaffPageKey {
  const lastPerson = timeOf(row.last_person_at);
  const lastStaff = timeOf(row.last_staff_at);
  const waitingTeam = row.state === 'open' && lastPerson !== null && (lastStaff === null || lastPerson >= lastStaff);
  return {
    urgent: row.priority === 'urgent' && row.state === 'open' ? 0 : 1,
    waiting: waitingTeam ? 0 : 1,
    since: lastPerson ?? numberOf(row.created_at),
    id: row.id,
  };
}
const DAY_MS = 86_400_000;
const WORDS_MAX = 200;
const OPENED_DAYS_MAX = 3_660;

const STATES: readonly OpsTicketState[] = ['open', 'resolved', 'closed'];
const PRIORITIES: readonly OpsTicketPriority[] = ['normal', 'urgent'];
const DERIVED: readonly OpsDerivedState[] = ['waiting_team', 'waiting_person', 'resolved', 'closed'];

/** `text` as a LIKE term: `!` escapes `!`, `%` and `_`, so the term matches itself alone. */
const escapeLike = (text: string): string => text.replace(/[!%_]/g, (character) => `!${character}`);

/** The identity lookups a page of views gathers, for one `ops_identity` line a page. */
export interface IdentityLines {
  failed: number;
}

/**
 * The staff view of `row`: the identity read at view time, only once shared or opened (D11). A
 * lookup that throws shows the request with no identity, so one account the directory cannot
 * answer for fails no page and no write that landed; it is counted on `lines` when the caller
 * gathers a page's, else written as one `ops_identity` line.
 */
export async function staffView(core: TicketsCore, row: TicketRow, lines?: IdentityLines): Promise<OpsStaffTicket> {
  if (!identityVisible(row)) return staffTicket(row, null, 'hidden');
  const opened: OpsIdentityState = timeOf(row.identity_opened_at) !== null ? 'opened' : 'shared';
  let identity: OpsIdentity;
  try {
    identity = await core.host.identity(row.account_id, core.db);
  } catch {
    // The directory gave no answer: the view shows no identity, and the line says so (D47).
    if (lines === undefined) ownLine(core.logger, 'warn', 'ops_identity', { outcome: 'failed', count: 1 });
    else lines.failed += 1;
    return staffTicket(row, null, opened);
  }
  if (identity === null) return staffTicket(row, null, opened);
  if ('deleting' in identity) return staffTicket(row, null, 'deleting');
  const shown: StaffIdentity = { name: identity.name, email: identity.email };
  return staffTicket(row, shown, opened);
}

interface CountsRow {
  readonly waiting_team: number | string | null;
  readonly waiting_person: number | string | null;
  readonly urgent_open: number | string | null;
  readonly resolved_7d: number | string | null;
}

interface StatsRow {
  readonly state: OpsTicketState;
  readonly priority: OpsTicketPriority;
  readonly category: string;
  readonly waiting: number | string;
  readonly n: number | string;
}

/** Staff's functions over `core`. */
export function createStaff(core: TicketsCore) {
  const { db, tables, limits, host } = core;

  async function counts(nowMs: number): Promise<OpsTicketCounts> {
    const row = await db.get<CountsRow>(
      `SELECT
         SUM(CASE WHEN ${waitingTeamSql()} THEN 1 ELSE 0 END) AS waiting_team,
         SUM(CASE WHEN ${waitingPersonSql()} THEN 1 ELSE 0 END) AS waiting_person,
         SUM(CASE WHEN state = 'open' AND priority = 'urgent' THEN 1 ELSE 0 END) AS urgent_open,
         SUM(CASE WHEN resolved_at IS NOT NULL AND resolved_at >= ? THEN 1 ELSE 0 END) AS resolved_7d
       FROM ${tables.tickets}`,
      [nowMs - 7 * DAY_MS],
    );
    return {
      waitingTeam: Number(row?.waiting_team ?? 0),
      waitingPerson: Number(row?.waiting_person ?? 0),
      urgentOpen: Number(row?.urgent_open ?? 0),
      resolved7d: Number(row?.resolved_7d ?? 0),
    };
  }

  /** How many requests were opened on each of the last 7 UTC days, the oldest first, today last. */
  async function openedByDay(nowMs: number): Promise<number[]> {
    const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
    const first = today - 6 * DAY_MS;
    const rows = await db.all<{ created_at: number | string }>(`SELECT created_at FROM ${tables.tickets} WHERE created_at >= ? AND created_at < ?`, [first, today + DAY_MS]);
    const days = [0, 0, 0, 0, 0, 0, 0];
    for (const row of rows) {
      const index = Math.floor((Number(row.created_at) - first) / DAY_MS);
      if (index >= 0 && index < 7) days[index] = (days[index] ?? 0) + 1;
    }
    return days;
  }

  /**
   * A write on `row` by staff at `now`: one message, an owed mail, the pictures, the wake; answers
   * the message. The row is read again and locked inside the transaction, so the message's time
   * comes from the newest pointers and two writes on one request take their times in turn (D13).
   */
  async function staffMessage(actor: OpsStaff, row: TicketRow, input: OpsTicketWrite, now: number, extra?: (trx: StorageAdapter) => Promise<void>): Promise<OpsMessage | OpsRefusal> {
    const pictureIds = pictureIdsOf(input) ?? [];
    // Cleaned before its links are cut: a control character inside a path never hides the path from the cut (D19, D26).
    const body = storableText(input.body, host.tokenPaths);
    const answer = await refusable(() =>
      db.transaction(async (trx) => {
        const locked = await lockTicket(trx, tables.tickets, row.id, core.postgres);
        if (locked === null) refuseInside('not_found', 404);
        if (locked.state === 'closed') refuseInside('ticket_closed', 409);
        if (pictureIds.length > 0 && (await picturesOnTicket(trx, tables.attachments, row.id)) + pictureIds.length > limits.picturesPerTicket) {
          refuseInside('too_many_pictures', 409);
        }
        const at = messageAt(locked, now);
        const messageId = await insertMessage(trx, tables, {
          ticketId: row.id,
          sender: 'staff',
          senderAccountId: actor.accountId,
          body,
          mailState: 'owed',
          notifiedAt: null,
          at,
        });
        if (pictureIds.length > 0) await attachPictures(trx, tables, pictureIds, row.id, messageId, null);
        if (extra !== undefined) await extra(trx);
        await core.notifyWrite(trx, row.id);
        return messageId;
      }),
    );
    if (isRefusal(answer)) return answer;
    core.streams.wake(row.id);
    const message = await loadMessage(db, tables, answer);
    const fresh = await loadTicket(db, tables.tickets, row.id);
    if (message === null || fresh === null) return notFound();
    await ringBell(core, message, fresh, core.now());
    return messageView(message, (await picturesByMessage(db, tables, row.id)).get(message.id) ?? []);
  }

  return {
    async staffList(actor: OpsStaff, filter: OpsStaffFilter = {}): Promise<OpsStaffPage> {
      if (!isStaff(actor)) throw new TypeError('staffList: the actor must be a staff member');
      const given = typeof filter === 'object' && filter !== null ? filter : {};
      const now = core.now();
      const where: string[] = [];
      const parameters: unknown[] = [];
      if (given.state !== undefined) {
        if (given.state !== 'open' && !DERIVED.includes(given.state)) throw new TypeError('staffList: state must be a derived state or open');
        where.push(derivedStateSql(given.state, 't.'));
      }
      if (given.category !== undefined) {
        if (typeof given.category !== 'string' || !host.categories.includes(given.category)) throw new TypeError('staffList: category must be one of the host categories');
        where.push('t.category = ?');
        parameters.push(given.category);
      }
      if (given.claim !== undefined) {
        if (given.claim === 'mine') {
          where.push('t.claimed_by = ?');
          parameters.push(actor.accountId);
        } else if (given.claim === 'nobody') where.push('t.claimed_by IS NULL');
        else if (given.claim === 'anyone') where.push('t.claimed_by IS NOT NULL');
        else throw new TypeError('staffList: claim must be mine, nobody or anyone');
      }
      if (given.priority !== undefined) {
        if (!PRIORITIES.includes(given.priority)) throw new TypeError('staffList: priority must be normal or urgent');
        where.push('t.priority = ?');
        parameters.push(given.priority);
      }
      if (given.openedDays !== undefined) {
        if (!Number.isSafeInteger(given.openedDays) || given.openedDays < 1 || given.openedDays > OPENED_DAYS_MAX) throw new TypeError('staffList: openedDays must be 1 to 3,660');
        where.push('t.created_at > ?');
        parameters.push(now - given.openedDays * DAY_MS);
      }
      if (given.words !== undefined) {
        if (typeof given.words !== 'string' || given.words.length > WORDS_MAX) throw new TypeError('staffList: words must be a string of at most 200 characters');
        const term = given.words.trim().toLowerCase();
        if (term.length > 0) {
          const pattern = `%${escapeLike(term)}%`;
          where.push(
            `(LOWER(t.subject) LIKE ? ESCAPE '!' OR EXISTS (SELECT 1 FROM ${tables.messages} m WHERE m.ticket_id = t.id AND m.body IS NOT NULL AND LOWER(m.body) LIKE ? ESCAPE '!'))`,
          );
          parameters.push(pattern, pattern);
        }
      }
      // The page after the last request shown: the rows after its ordering keys (urgent first, then waiting on the team, then the longest waiting, then the id), so a request opened between two pages, which sorts before those waiting on the person, repeats nothing and hides nothing (D10).
      const key = staffKeyOf(given.cursor);
      if (key !== null) {
        where.push(
          `(${URGENT_SQL} > ? OR (${URGENT_SQL} = ? AND (${WAITING_SQL} > ? OR (${WAITING_SQL} = ? AND (${SINCE_SQL} > ? OR (${SINCE_SQL} = ? AND t.id > ?))))))`,
        );
        parameters.push(key.urgent, key.urgent, key.waiting, key.waiting, key.since, key.since, key.id);
      }
      const rows = await db.all<TicketRow>(
        `SELECT t.* FROM ${tables.tickets} t${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${URGENT_SQL} ASC, ${WAITING_SQL} ASC, ${SINCE_SQL} ASC, t.id ASC
         LIMIT ${STAFF_PAGE + 1}`,
        parameters,
      );
      const page = rows.slice(0, STAFF_PAGE);
      const tickets: OpsStaffTicket[] = [];
      const lines: IdentityLines = { failed: 0 };
      for (const row of page) tickets.push(await staffView(core, row, lines));
      if (lines.failed > 0) ownLine(core.logger, 'warn', 'ops_identity', { outcome: 'failed', count: lines.failed });
      const last = page.at(-1);
      return {
        tickets,
        cursor: rows.length > STAFF_PAGE && last !== undefined ? staffCursorOf(orderingKeyOf(last)) : null,
        counts: await counts(now),
        openedByDay: await openedByDay(now),
      };
    },

    async staffGet(actor: OpsStaff, id: string): Promise<{ readonly ticket: OpsStaffTicket; readonly messages: readonly OpsMessage[] } | null> {
      if (!isStaff(actor)) return null;
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return null;
      // The thread first, then the marker: the newest of the request's pointers and of the messages answered (one that landed between the two reads too), never the clock, so a reply landing after the thread was read stays unread.
      const messages = await readThread(db, tables, row.id);
      const newest = Math.max(latestMessageAt(row) ?? 0, ...messages.map((message) => message.createdAt));
      const at = newest > 0 ? newest : core.now();
      // Never backwards: an older read that finishes after a newer one leaves the newer marker.
      await db.run(`UPDATE ${tables.tickets} SET staff_read_at = ? WHERE id = ? AND (staff_read_at IS NULL OR staff_read_at < ?)`, [at, row.id, at]);
      return { ticket: await staffView(core, { ...row, staff_read_at: at }), messages };
    },

    async reply(actor: OpsStaff, id: string, input: OpsTicketWrite): Promise<OpsMessage | OpsRefusal> {
      if (!isStaff(actor)) return refusal('refused', 400);
      const refused = checkWriteInput(input, limits);
      if (refused !== null) return refused;
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return notFound();
      if (row.state === 'closed') return refusal('ticket_closed', 409);
      return staffMessage(actor, row, input, core.now());
    },

    async claim(actor: OpsStaff, id: string, on: boolean): Promise<OpsStaffTicket | OpsRefusal> {
      if (!isStaff(actor) || typeof on !== 'boolean') return refusal('refused', 400);
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return notFound();
      const now = core.now();
      await db.transaction(async (trx) => {
        await trx.run(`UPDATE ${tables.tickets} SET claimed_by = ?, updated_at = ? WHERE id = ?`, [on ? actor.accountId : null, now, row.id]);
        await core.notifyWrite(trx, row.id);
      });
      core.streams.wake(row.id);
      const fresh = await loadTicket(db, tables.tickets, row.id);
      return fresh === null ? notFound() : staffView(core, fresh);
    },

    async setPriority(actor: OpsStaff, id: string, priority: OpsTicketPriority): Promise<OpsStaffTicket | OpsRefusal> {
      if (!isStaff(actor) || !PRIORITIES.includes(priority)) return refusal('refused', 400);
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return notFound();
      const now = core.now();
      await db.transaction(async (trx) => {
        await trx.run(`UPDATE ${tables.tickets} SET priority = ?, updated_at = ? WHERE id = ?`, [priority, now, row.id]);
        await core.notifyWrite(trx, row.id);
      });
      core.streams.wake(row.id);
      const fresh = await loadTicket(db, tables.tickets, row.id);
      return fresh === null ? notFound() : staffView(core, fresh);
    },

    async setState(actor: OpsStaff, id: string, state: OpsTicketState): Promise<OpsStaffTicket | OpsRefusal> {
      if (!isStaff(actor) || !STATES.includes(state)) return refusal('refused', 400);
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return notFound();
      if (row.state !== state) {
        const now = core.now();
        const key = state === 'resolved' ? 'resolved_by_staff' : state === 'closed' ? 'closed' : 'reopened';
        const changed = await db.transaction(async (trx) => {
          // The row read again and locked inside the transaction: the system message's time comes from the newest pointers, and a state another call set meanwhile is seen.
          const locked = await lockTicket(trx, tables.tickets, row.id, core.postgres);
          if (locked === null || locked.state === state) return false;
          if (state === 'resolved') {
            await trx.run(`UPDATE ${tables.tickets} SET state = 'resolved', resolved_at = ?, updated_at = ? WHERE id = ?`, [now, now, locked.id]);
          } else if (state === 'closed') {
            await trx.run(`UPDATE ${tables.tickets} SET state = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`, [now, now, locked.id]);
          } else {
            await trx.run(`UPDATE ${tables.tickets} SET state = 'open', resolved_at = NULL, closed_at = NULL, updated_at = ? WHERE id = ?`, [now, locked.id]);
          }
          await writeSystemMessage(trx, tables, locked, key, {}, now);
          await host.audit(trx, { kind: 'support_state_changed', staffAccountId: actor.accountId, subject: locked.id, detail: { from: locked.state, to: state } });
          await core.notifyWrite(trx, locked.id);
          return true;
        });
        if (changed) core.streams.wake(row.id);
      }
      const fresh = await loadTicket(db, tables.tickets, row.id);
      return fresh === null ? notFound() : staffView(core, fresh);
    },

    async openIdentity(actor: OpsStaff, id: string): Promise<OpsStaffTicket | OpsRefusal> {
      if (!isStaff(actor)) return refusal('refused', 400);
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return notFound();
      if (timeOf(row.identity_opened_at) !== null) return staffView(core, row);
      const now = core.now();
      const written = await db.transaction(async (trx) => {
        // The row read again and locked inside the transaction: an opening another call made meanwhile is seen and not repeated.
        const locked = await lockTicket(trx, tables.tickets, row.id, core.postgres);
        if (locked === null || timeOf(locked.identity_opened_at) !== null) return null;
        await trx.run(`UPDATE ${tables.tickets} SET identity_opened_at = ?, updated_at = ? WHERE id = ?`, [now, now, locked.id]);
        const message = await writeSystemMessage(trx, tables, locked, 'identity_opened', {}, now);
        // The opening's mail is owed until it went (D14): sent at once below when the directory answers a live account, else the tick's.
        await trx.run(`UPDATE ${tables.messages} SET mail_state = 'owed' WHERE id = ?`, [message.id]);
        await host.audit(trx, { kind: 'support_identity_opened', staffAccountId: actor.accountId, subject: locked.id, detail: {} });
        await core.notifyWrite(trx, locked.id);
        return message;
      });
      const fresh = await loadTicket(db, tables.tickets, row.id);
      if (fresh === null) return notFound();
      if (written === null) return staffView(core, fresh);
      core.streams.wake(row.id);
      // The identity notice goes at once, whatever the request's state, with no throttle (D11, D14): the row stays owed for the tick when the directory gives no answer or the send fails, and is skipped for an account gone or deleting.
      await sendIdentityMail(core, fresh, written.id);
      const message = await loadMessage(db, tables, written.id);
      if (message !== null) await ringBell(core, message, fresh, now);
      return staffView(core, fresh);
    },

    async writeTo(actor: OpsStaff, accountId: string, input: OpsOpenInput): Promise<OpsStaffTicket | OpsRefusal> {
      if (!isStaff(actor) || typeof accountId !== 'string' || accountId.length === 0 || accountId.length > 128) return refusal('refused', 400);
      const refused = checkOpenInput(input, limits, host);
      if (refused !== null) return refused;
      const pictureIds = pictureIdsOf(input) ?? [];
      const now = core.now();
      const subject = storableText(input.subject, host.tokenPaths);
      const body = storableText(input.body, host.tokenPaths);
      const answer = await refusable(() =>
        db.transaction(async (trx) => {
          // The account's lock first, as open and systemMessage take it, then its liveness: a deletion in flight commits before this thread lands, and an account gone or deleting takes no thread after it (D20).
          if (!(await core.lockLiveAccount(trx, accountId))) refuseInside('not_found', 404);
          const id = newId('tkt');
          await insertTicket(trx, tables.tickets, core.postgres, core.random, {
            id,
            accountId,
            subject,
            category: input.category,
            source: 'staff',
            claimedBy: actor.accountId,
            shareIdentity: true,
            planAtOpen: null,
            consentAt: null,
            consentVersion: null,
            createdAt: now,
          });
          const opened = await loadTicket(trx, tables.tickets, id);
          if (opened === null) throw new Error('writeTo: the request written was not read back');
          const system = await writeSystemMessage(trx, tables, opened, 'opened_by_staff', {}, now);
          const messageId = await insertMessage(trx, tables, {
            ticketId: id,
            sender: 'staff',
            senderAccountId: actor.accountId,
            body,
            mailState: 'owed',
            notifiedAt: null,
            at: system.at + 1,
          });
          if (pictureIds.length > 0) await attachPictures(trx, tables, pictureIds, id, messageId, null);
          await host.audit(trx, { kind: 'support_thread_opened', staffAccountId: actor.accountId, subject: id, detail: { category: input.category } });
          await core.notifyWrite(trx, id);
          return { id, messageId };
        }),
      );
      if (isRefusal(answer)) return answer;
      const fresh = await loadTicket(db, tables.tickets, answer.id);
      const message = await loadMessage(db, tables, answer.messageId);
      if (fresh === null) return notFound();
      if (message !== null) await ringBell(core, message, fresh, now);
      return staffView(core, fresh);
    },

    async stats(actor: OpsStaff): Promise<OpsTicketStats> {
      if (!isStaff(actor)) throw new TypeError('stats: the actor must be a staff member');
      const now = core.now();
      const waiting = `CASE WHEN ${waitingTeamSql()} THEN 1 ELSE 0 END`;
      const rows = await db.all<StatsRow>(
        `SELECT state, priority, category, ${waiting} AS waiting, COUNT(*) AS n FROM ${tables.tickets} GROUP BY state, priority, category, ${waiting}`,
      );
      const resolved = await db.get<{ n: number | string | null }>(`SELECT COUNT(*) AS n FROM ${tables.tickets} WHERE resolved_at IS NOT NULL AND resolved_at >= ?`, [
        Math.floor(now / DAY_MS) * DAY_MS,
      ]);
      const byState: Record<OpsDerivedState, number> = { waiting_team: 0, waiting_person: 0, resolved: 0, closed: 0 };
      const byPriority: Record<OpsTicketPriority, number> = { normal: 0, urgent: 0 };
      const byCategory: Record<string, number> = {};
      let open = 0;
      let urgent = 0;
      for (const row of rows) {
        const n = Number(row.n);
        const derived: OpsDerivedState = row.state === 'open' ? (Number(row.waiting) === 1 ? 'waiting_team' : 'waiting_person') : row.state;
        byState[derived] += n;
        if (row.priority === 'urgent' || row.priority === 'normal') byPriority[row.priority] += n;
        byCategory[row.category] = (byCategory[row.category] ?? 0) + n;
        if (row.state === 'open') {
          open += n;
          if (row.priority === 'urgent') urgent += n;
        }
      }
      return { open, waiting: byState.waiting_team, urgent, resolvedToday: Number(resolved?.n ?? 0), byState, byPriority, byCategory };
    },
  };
}
