/**
 * @fileoverview A request's messages (D8): their rows, the write of one message with the request's
 * pointers, and the thread as people read it, pictures grouped under their message. A message's
 * time is strictly later than the request's newest message, `max(now, newest + 1)`, so the thread
 * has one order on every engine, a stream's cursor reads exactly what came after an event, and
 * two messages one write makes (a system message and the message beside it) keep their order.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsMessage } from '../contract.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import type { TicketTables } from './core.js';
import { latestMessageAt, numberOf, timeOf, type TicketRow } from './states.js';

/** A row of `<prefix>_messages`; JSON columns come back parsed from PostgreSQL's jsonb and as text from SQLite. */
export interface MessageRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly sender: 'person' | 'staff' | 'system';
  readonly sender_account_id: string | null;
  readonly body: string | null;
  readonly system_key: string | null;
  readonly system_params: string | Record<string, unknown> | null;
  readonly source_event_type: string | null;
  readonly source_event_id: string | null;
  readonly mail_state: 'owed' | 'sent' | 'skipped' | 'failed' | null;
  readonly mail_attempts: number | string;
  readonly notified_at: number | string | null;
  readonly notify_attempts: number | string;
  readonly created_at: number | string;
}

/** A picture's row without its bytes, as the thread lists it. */
export interface PictureRow {
  readonly id: string;
  readonly message_id: string | null;
  readonly width: number | string;
  readonly height: number | string;
}

/** A message to write: its sender, its words or its system key, and what the outboxes owe for it. */
export interface NewMessage {
  readonly ticketId: string;
  readonly sender: 'person' | 'staff' | 'system';
  readonly senderAccountId: string | null;
  readonly body: string | null;
  readonly systemKey?: string | null;
  readonly systemParams?: Readonly<Record<string, string | number>> | null;
  readonly sourceEventType?: string | null;
  readonly sourceEventId?: string | null;
  /** `owed` for a staff message the mail outbox sends (D14); null for the rest. */
  readonly mailState: 'owed' | null;
  /** The time the bell was marked done at the write, or null while a notice is owed (D15). */
  readonly notifiedAt: number | null;
  readonly at: number;
}

/** The time a new message on `row` takes at `nowMs`: strictly after the request's newest message. */
export function messageAt(row: TicketRow, nowMs: number): number {
  const latest = latestMessageAt(row);
  return latest === null ? nowMs : Math.max(nowMs, latest + 1);
}

/** The parsed parameters of a system message, or null. */
export function paramsOf(value: MessageRow['system_params']): Readonly<Record<string, string | number>> | null {
  if (value === null || value === undefined) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const params: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof entry === 'string' || typeof entry === 'number') params[key] = entry;
  }
  return params;
}

/** The message as the thread shows it, with its pictures. */
export function messageView(row: MessageRow, pictures: readonly PictureRow[]): OpsMessage {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    sender: row.sender,
    body: row.body,
    systemKey: row.system_key,
    systemParams: row.sender === 'system' ? paramsOf(row.system_params) : null,
    pictures: pictures.map((picture) => ({ id: picture.id, width: numberOf(picture.width), height: numberOf(picture.height) })),
    createdAt: numberOf(row.created_at),
  };
}

/** The column of `<prefix>_tickets` a sender's message moves. */
const LAST_AT: Readonly<Record<NewMessage['sender'], string>> = { person: 'last_person_at', staff: 'last_staff_at', system: 'last_system_at' };

/**
 * Writes `message` through `writer` and moves the request's pointer for its sender and
 * `updated_at`; answers the new row's id. The body is cleaned of control characters here; the
 * caller cut its links (D19, D26).
 */
export async function insertMessage(writer: StorageAdapter, tables: TicketTables, message: NewMessage): Promise<string> {
  const id = newId('msg');
  await writer.run(
    `INSERT INTO ${tables.messages} (id, ticket_id, sender, sender_account_id, body, system_key, system_params, source_event_type, source_event_id, mail_state, mail_attempts, notified_at, notify_attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?)`,
    [
      id,
      message.ticketId,
      message.sender,
      message.senderAccountId,
      message.body === null ? null : clean(message.body),
      message.systemKey ?? null,
      message.systemParams === undefined || message.systemParams === null ? null : JSON.stringify(message.systemParams),
      message.sourceEventType ?? null,
      message.sourceEventId ?? null,
      message.mailState,
      message.notifiedAt,
      message.at,
    ],
  );
  await writer.run(`UPDATE ${tables.tickets} SET ${LAST_AT[message.sender]} = ?, updated_at = ? WHERE id = ?`, [message.at, message.at, message.ticketId]);
  return id;
}

/** The row of message `id`, or null. */
export async function loadMessage(db: StorageAdapter, tables: TicketTables, id: string): Promise<MessageRow | null> {
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  return db.get<MessageRow>(`SELECT * FROM ${tables.messages} WHERE id = ?`, [id]);
}

/** The pictures attached to the messages of `ticketId`, by message id. */
export async function picturesByMessage(db: StorageAdapter, tables: TicketTables, ticketId: string): Promise<Map<string, PictureRow[]>> {
  const rows = await db.all<PictureRow>(
    `SELECT id, message_id, width, height FROM ${tables.attachments} WHERE ticket_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC, id ASC`,
    [ticketId],
  );
  const grouped = new Map<string, PictureRow[]>();
  for (const row of rows) {
    if (row.message_id === null) continue;
    const list = grouped.get(row.message_id);
    if (list === undefined) grouped.set(row.message_id, [row]);
    else list.push(row);
  }
  return grouped;
}

/**
 * The thread of `ticketId` as people read it, oldest first: every message after `afterMs` when
 * given (a stream's cursor), else all of them, each with its pictures.
 */
export async function readThread(db: StorageAdapter, tables: TicketTables, ticketId: string, afterMs?: number): Promise<OpsMessage[]> {
  const rows =
    afterMs === undefined
      ? await db.all<MessageRow>(`SELECT * FROM ${tables.messages} WHERE ticket_id = ? ORDER BY created_at ASC, id ASC`, [ticketId])
      : await db.all<MessageRow>(`SELECT * FROM ${tables.messages} WHERE ticket_id = ? AND created_at > ? ORDER BY created_at ASC, id ASC`, [ticketId, afterMs]);
  if (rows.length === 0) return [];
  const pictures = await picturesByMessage(db, tables, ticketId);
  return rows.map((row) => messageView(row, pictures.get(row.id) ?? []));
}

/** The id of the newest message on `ticketId`, or null when it has none: the id a fresh stream's first `state` event carries, so a reconnect resumes from it (D13). */
export async function newestMessageId(db: StorageAdapter, tables: TicketTables, ticketId: string): Promise<string | null> {
  const row = await db.get<{ id: string }>(`SELECT id FROM ${tables.messages} WHERE ticket_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [ticketId]);
  return row?.id ?? null;
}

/** The time of message `id` on `ticketId`, for a stream's cursor; null when the message is not on that request. */
export async function messageTime(db: StorageAdapter, tables: TicketTables, ticketId: string, id: string): Promise<number | null> {
  const row = await loadMessage(db, tables, id);
  return row === null || row.ticket_id !== ticketId ? null : timeOf(row.created_at);
}
