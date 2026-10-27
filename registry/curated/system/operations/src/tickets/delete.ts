/**
 * @fileoverview The deletions (D46, D20). A person deletes a request of theirs and staff delete
 * one from the admin's page: the request, its messages, its pictures and so its mail and bell rows
 * go in one transaction, its streams end, and one `ops_request_deleted` line is written with no id
 * (the audit kind `support_request_deleted` for a staff deletion). `deleteAccount(trx, accountId)`
 * deletes every request of the account the same way inside the host's own transaction, under the
 * account's lock (so an open in flight commits first and its request goes with the rest), the
 * account's unattached uploads with them, and sets `sender_account_id` and `claimed_by` null where
 * they name the account, for a product whose database has no foreign keys to do it. `hangup`
 * marks the account's owed mail and bell rows skipped and ends its streams, for a product's
 * deletion step before the purge. Deleted means gone: no tombstone; what the limits still count of
 * a removed request, its opening and the person's messages of the last hour, is remembered in the
 * process alone once the rows are gone (D12, `removed.ts`), and the account's deletion forgets it.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsPerson, OpsRefusal, OpsStaff } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { isPerson, isStaff } from './actors.js';
import type { TicketsCore, TicketTables } from './core.js';
import { hangupOutboxes } from './outbox.js';
import { notFound, refusal } from './refusals.js';
import { loadOwnTicket, loadTicket, numberOf, type TicketRow } from './states.js';

const HOUR_MS = 3_600_000;

/** Deletes the rows of `ticketId` through `writer`: its pictures, its messages, then the request. */
export async function deleteTicketRows(writer: StorageAdapter, tables: TicketTables, ticketId: string): Promise<void> {
  await writer.run(`DELETE FROM ${tables.attachments} WHERE ticket_id = ?`, [ticketId]);
  await writer.run(`DELETE FROM ${tables.messages} WHERE ticket_id = ?`, [ticketId]);
  await writer.run(`DELETE FROM ${tables.tickets} WHERE id = ?`, [ticketId]);
}

/** The times of the person's own messages on the request `row`, written in the last hour, read through `reader` before the rows go (D12). */
async function personMessageTimes(reader: StorageAdapter, tables: TicketTables, row: TicketRow, nowMs: number): Promise<number[]> {
  const rows = await reader.all<{ created_at: number | string }>(
    `SELECT created_at FROM ${tables.messages} WHERE ticket_id = ? AND sender = 'person' AND sender_account_id = ? AND created_at > ?`,
    [row.id, row.account_id, nowMs - HOUR_MS],
  );
  return rows.map((message) => numberOf(message.created_at));
}

/** Remembers what the limits still count of the removed request `row`: its opening, when the person opened it, and the person's `messages` (D12, D46). */
function rememberRemoved(core: TicketsCore, row: TicketRow, messages: readonly number[], nowMs: number): void {
  core.removed.remember(row.account_id, { openings: row.source === 'person' ? [numberOf(row.created_at)] : [], messages }, nowMs);
}

/** The deletions over `core`. */
export function createDeletions(core: TicketsCore) {
  const { db, tables, host, logger } = core;

  return {
    async remove(actor: OpsPerson, id: string): Promise<void | OpsRefusal> {
      if (!isPerson(actor)) return refusal('refused', 400);
      const row = await loadOwnTicket(db, tables.tickets, id, actor.accountId);
      if (row === null) return notFound();
      const now = core.now();
      let messages: number[] = [];
      await db.transaction(async (trx) => {
        messages = await personMessageTimes(trx, tables, row, now);
        await deleteTicketRows(trx, tables, row.id);
        await core.notifyWrite(trx, row.id);
      });
      // Remembered once the rows are gone, so a request whose deletion failed is counted by its rows alone.
      rememberRemoved(core, row, messages, now);
      core.streams.endTicket(row.id);
      ownLine(logger, 'info', 'ops_request_deleted', { by: 'person' });
      return undefined;
    },

    async staffRemove(actor: OpsStaff, id: string): Promise<void | OpsRefusal> {
      if (!isStaff(actor)) return refusal('refused', 400);
      const row = await loadTicket(db, tables.tickets, id);
      if (row === null) return notFound();
      const now = core.now();
      let messages: number[] = [];
      await db.transaction(async (trx) => {
        messages = await personMessageTimes(trx, tables, row, now);
        await deleteTicketRows(trx, tables, row.id);
        await host.audit(trx, { kind: 'support_request_deleted', staffAccountId: actor.accountId, subject: row.id, detail: {} });
        await core.notifyWrite(trx, row.id);
      });
      rememberRemoved(core, row, messages, now);
      core.streams.endTicket(row.id);
      ownLine(logger, 'info', 'ops_request_deleted', { by: 'staff' });
      return undefined;
    },

    async deleteAccount(trx: StorageAdapter, accountId: string): Promise<void> {
      if (typeof accountId !== 'string' || accountId.length === 0) throw new TypeError('deleteAccount: accountId must be a non-empty string');
      // The account's lock first (D12's, on PostgreSQL): an open in flight for the account commits before the deletion reads, so its request is deleted with the rest and none survives.
      await core.lockAccount(trx, accountId);
      const own = `SELECT id FROM ${tables.tickets} WHERE account_id = ?`;
      await trx.run(`DELETE FROM ${tables.attachments} WHERE ticket_id IN (${own})`, [accountId]);
      await trx.run(`DELETE FROM ${tables.messages} WHERE ticket_id IN (${own})`, [accountId]);
      const removed = await trx.run(`DELETE FROM ${tables.tickets} WHERE account_id = ?`, [accountId]);
      await trx.run(`DELETE FROM ${tables.attachments} WHERE uploaded_by = ?`, [accountId]);
      await trx.run(`UPDATE ${tables.messages} SET sender_account_id = NULL WHERE sender_account_id = ?`, [accountId]);
      await trx.run(`UPDATE ${tables.tickets} SET claimed_by = NULL WHERE claimed_by = ?`, [accountId]);
      core.streams.endAccount(accountId);
      // The account is gone: nothing remembered of its removed requests stays (D12, D20).
      core.removed.forget(accountId);
      const count = Number(removed.changes);
      ownLine(logger, 'info', 'ops_request_deleted', { by: 'account', count: Number.isSafeInteger(count) && count >= 0 ? count : 0 });
    },

    async hangup(accountId: string): Promise<void> {
      if (typeof accountId !== 'string' || accountId.length === 0) throw new TypeError('hangup: accountId must be a non-empty string');
      await hangupOutboxes(core, accountId);
      core.streams.endAccount(accountId);
      core.removed.forget(accountId);
    },
  };
}
