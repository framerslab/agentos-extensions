/**
 * @fileoverview System messages (D6, D17): a key with word and integer parameters, never text. The
 * package's own keys (`opened_by_staff`, `resolved_by_person`, `resolved_by_staff`,
 * `resolved_by_silence`, `closed`, `reopened`, `identity_opened`) are written beside the state
 * changes that cause them; a product records an event of its own with `systemMessage(accountId,
 * category, key, params, sourceType, sourceId)`, which finds the account's request in the category
 * that is not closed or opens one (source `system`, its subject the key, since a stored subject is
 * a key the product renders through its words), idempotent by the unique source pair. Each renders
 * from the product's `OpsWords`. No system message is mailed or rung, except the identity opening,
 * whose bell the opening rings.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsMessage, OpsSystemMessageKey } from '../contract.js';
import { newId } from '../store/ids.js';
import { insertTicket, isUnique } from './anonymous.js';
import type { TicketsCore, TicketTables } from './core.js';
import { insertMessage, loadMessage, messageAt, messageView } from './messages.js';
import { loadTicket, type TicketRow } from './states.js';

/** The keys the package itself writes. */
export const SYSTEM_KEYS: readonly OpsSystemMessageKey[] = [
  'opened_by_staff',
  'resolved_by_person',
  'resolved_by_staff',
  'resolved_by_silence',
  'closed',
  'reopened',
  'identity_opened',
];

/** A key a product may write: a letter, then at most 63 letters, digits or underscores. */
const KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** A plain object of words and integers, as a system message's parameters must be. */
export function requireParams(params: unknown): Readonly<Record<string, string | number>> {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) throw new TypeError('systemMessage: params must be an object of words and integers');
  const checked: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (!KEY.test(key)) throw new TypeError('systemMessage: a params key must be a word');
    if (typeof value === 'number' && Number.isSafeInteger(value)) checked[key] = value;
    else if (typeof value === 'string' && value.length <= 256) checked[key] = value;
    else throw new TypeError(`systemMessage: params.${key} must be a word or an integer`);
  }
  return checked;
}

/**
 * Writes the system message `key` on `ticket` through `writer`, inside the write's transaction, at
 * a time after the request's newest message; only the identity opening owes a bell (D15). Answers
 * the message's id and time.
 */
export async function writeSystemMessage(
  writer: StorageAdapter,
  tables: TicketTables,
  ticket: TicketRow,
  key: string,
  params: Readonly<Record<string, string | number>>,
  nowMs: number,
  source: { readonly type: string; readonly id: string } | null = null,
): Promise<{ readonly id: string; readonly at: number }> {
  const at = messageAt(ticket, nowMs);
  const id = await insertMessage(writer, tables, {
    ticketId: ticket.id,
    sender: 'system',
    senderAccountId: null,
    body: null,
    systemKey: key,
    systemParams: params,
    sourceEventType: source?.type ?? null,
    sourceEventId: source?.id ?? null,
    mailState: null,
    notifiedAt: key === 'identity_opened' ? null : at,
    at,
  });
  return { id, at };
}

const text = (name: string, value: unknown, max: number): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new TypeError(`systemMessage: ${name} must be a string of 1 to ${max} characters`);
  return value;
};

/** `Tickets.systemMessage` over `core` (D17). */
export function createSystemMessages(core: TicketsCore) {
  const { db, tables, host } = core;
  return {
    async systemMessage(
      accountId: string,
      category: string,
      key: string,
      params: Readonly<Record<string, string | number>>,
      sourceType: string,
      sourceId: string,
    ): Promise<OpsMessage | null> {
      text('accountId', accountId, 128);
      if (typeof category !== 'string' || !host.categories.includes(category)) throw new TypeError('systemMessage: category must be one of the host categories');
      if (typeof key !== 'string' || !KEY.test(key)) throw new TypeError('systemMessage: key must be a word');
      const checked = requireParams(params);
      text('sourceType', sourceType, 128);
      text('sourceId', sourceId, 128);

      const recorded = await db.get<{ id: string }>(`SELECT id FROM ${tables.messages} WHERE source_event_type = ? AND source_event_id = ?`, [sourceType, sourceId]);
      if (recorded !== null) return null;

      let written: { id: string; ticketId: string };
      try {
        written = await db.transaction(async (trx) => {
          let ticket = await trx.get<TicketRow>(
            `SELECT * FROM ${tables.tickets} WHERE account_id = ? AND category = ? AND state <> 'closed' ORDER BY created_at DESC LIMIT 1`,
            [accountId, category],
          );
          if (ticket === null) {
            const id = newId('tkt');
            const now = core.now();
            await insertTicket(trx, tables.tickets, core.postgres, core.random, {
              id,
              accountId,
              subject: key,
              category,
              source: 'system',
              claimedBy: null,
              shareIdentity: false,
              planAtOpen: null,
              consentAt: null,
              consentVersion: null,
              createdAt: now,
            });
            ticket = await loadTicket(trx, tables.tickets, id);
            if (ticket === null) throw new Error('systemMessage: the request written was not read back');
          }
          const message = await writeSystemMessage(trx, tables, ticket, key, checked, core.now(), { type: sourceType, id: sourceId });
          await core.notifyWrite(trx, ticket.id);
          return { id: message.id, ticketId: ticket.id };
        });
      } catch (error) {
        // Two processes recorded the same event at once: the second finds the pair taken and answers null.
        if (await isUnique(error)) return null;
        throw error;
      }
      core.streams.wake(written.ticketId);
      const row = await loadMessage(db, tables, written.id);
      return row === null ? null : messageView(row, []);
    },
  };
}
