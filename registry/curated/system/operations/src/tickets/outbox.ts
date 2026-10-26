/**
 * @fileoverview The mail and bell outboxes (D14, D15). A staff message is written `mail_state:
 * 'owed'`; `sendDue(now)`, which the minute tick runs, sends through `mail()` each owed message
 * unread five minutes after it was written (`person_read_at` before it) whose request has had no
 * mail in the gap, marks it `sent` with the request's `last_mail_at`, marks `skipped` one read or
 * inside the gap, tries a failed send once more at the next tick and then marks `failed` with one
 * `ops_mail` line, marks `skipped` at once on `suppressed` with one line and no retry, and marks
 * every owed row of a deleting account `skipped`. The person's own and system messages are never
 * mailed, except the identity opening, which `openIdentity` sends at once itself.
 *
 * An `identity()` call that throws leaves the row `owed` for the next tick, counted as deferred with
 * one `ops_mail` line a run: no answer says whether the account is gone or deleting, so the mail is
 * neither sent nor given up.
 *
 * The bell: after a write's commit, `notify` is called with a dedupe key made from the message's id,
 * and `notified_at` marked; `notifyDue(now)` calls again for a message unmarked for over a minute,
 * three attempts in all. Every recipient is read through `identity()` for the deleting flag alone
 * and dropped when it is set; the name and address it answers are discarded. A message whose notice
 * has no recipient left, or a host without `notify`, is marked done at once. A hook that throws, the
 * recipients' or the bell's, is one counted attempt, so a lookup that keeps failing stops at the
 * third and never starves the rows behind it.
 */
import type { OpsIdentity, OpsMail, OpsNotice, OpsOutboxRun } from '../contract.js';
import { ownLine } from '../own-lines.js';
import type { TicketsCore } from './core.js';
import type { MessageRow } from './messages.js';
import { numberOf, timeOf, type TicketRow } from './states.js';

/** How many times the bell is tried in all (D15). */
export const NOTIFY_ATTEMPTS = 3;
/** A failed mail is tried once more at the next tick, then marked failed (D14). */
export const MAIL_ATTEMPTS = 2;
/** The bell is tried again for a message unmarked this long (D15). */
export const NOTIFY_RETRY_AFTER_MS = 60_000;
/** The most rows one run of an outbox takes. */
const RUN_BATCH = 200;

/** What a message's bell carries: the notice's kind and who gets it, before the deleting filter. */
export interface BellTarget {
  readonly kind: OpsNotice['kind'];
  readonly accountIds: readonly string[];
}

/** The message as the bell needs it: its id, sender and system key. */
export type BellMessage = Pick<MessageRow, 'id' | 'sender' | 'system_key'>;

/** The notice `message` on `ticket` owes (D15), or null when it owes none. */
export async function bellTargetOf(core: TicketsCore, message: BellMessage, ticket: TicketRow): Promise<BellTarget | null> {
  switch (message.sender) {
    case 'person':
      return { kind: 'supportWaiting', accountIds: ticket.claimed_by !== null ? [ticket.claimed_by] : await core.host.staffRecipients() };
    case 'staff':
      return { kind: 'supportReplied', accountIds: [ticket.account_id] };
    case 'system':
      return message.system_key === 'identity_opened' ? { kind: 'supportIdentityOpened', accountIds: [ticket.account_id] } : null;
    default:
      return null;
  }
}

/** Whether `accountId` is being deleted, as the identity hook says; the name and address it answers are discarded. */
export async function isDeleting(core: TicketsCore, accountId: string): Promise<boolean> {
  const identity = await core.host.identity(accountId);
  return identity !== null && typeof identity === 'object' && (identity as { deleting?: unknown }).deleting === true;
}

/** `accountIds` without the deleting ones and without repeats. */
export async function liveRecipients(core: TicketsCore, accountIds: readonly string[]): Promise<string[]> {
  const live: string[] = [];
  for (const accountId of new Set(accountIds)) {
    if (typeof accountId !== 'string' || accountId.length === 0) continue;
    if (!(await isDeleting(core, accountId))) live.push(accountId);
  }
  return live;
}

/**
 * Rings the bell for `message` on `ticket` once: marks the row done when nothing is owed, counts
 * the attempt otherwise, marked as landed when the notice went. Never throws: a hook that throws,
 * the recipients' or the bell's, is a counted attempt (D15), and a mark the database refuses is left
 * for the next tick.
 */
export async function ringBell(core: TicketsCore, message: BellMessage, ticket: TicketRow, nowMs: number): Promise<void> {
  const { db, tables } = core;
  let outcome: 'done' | 'landed' | 'missed';
  try {
    const notify = core.host.notify;
    const target = await bellTargetOf(core, message, ticket);
    if (target === null || notify === undefined) {
      outcome = 'done';
    } else {
      const accountIds = await liveRecipients(core, target.accountIds);
      if (accountIds.length === 0) {
        outcome = 'done';
      } else {
        await notify({ kind: target.kind, accountIds, ticketId: ticket.id, dedupeKey: `${target.kind}:${message.id}` });
        outcome = 'landed';
      }
    }
  } catch {
    // The recipients' lookup or the bell refused: a counted attempt, tried again at the next tick (D15).
    outcome = 'missed';
  }
  try {
    if (outcome === 'done') {
      await db.run(`UPDATE ${tables.messages} SET notified_at = ? WHERE id = ?`, [nowMs, message.id]);
    } else {
      await db.run(
        `UPDATE ${tables.messages} SET notify_attempts = notify_attempts + 1${outcome === 'landed' ? ', notified_at = ?' : ''} WHERE id = ?`,
        outcome === 'landed' ? [nowMs, message.id] : [message.id],
      );
    }
  } catch {
    // The database refused the mark: the next tick finds the row as it was and tries again.
  }
}

/** A row of the bell outbox: the message's columns the bell needs beside its request's row. */
interface DueBellRow extends TicketRow {
  readonly message_id: string;
  readonly message_sender: MessageRow['sender'];
  readonly message_system_key: string | null;
}

/** D15: calls the bell again for every message unmarked for over a minute, up to three attempts in all; answers how many rows it tried. */
export async function notifyDue(core: TicketsCore, nowMs: number): Promise<number> {
  const { db, tables } = core;
  const rows = await db.all<DueBellRow>(
    `SELECT m.id AS message_id, m.sender AS message_sender, m.system_key AS message_system_key, t.*
     FROM ${tables.messages} m JOIN ${tables.tickets} t ON t.id = m.ticket_id
     WHERE m.notified_at IS NULL AND m.notify_attempts < ? AND m.created_at <= ?
       AND (m.sender IN ('person', 'staff') OR (m.sender = 'system' AND m.system_key = 'identity_opened'))
     ORDER BY m.created_at ASC LIMIT ${RUN_BATCH}`,
    [NOTIFY_ATTEMPTS, nowMs - NOTIFY_RETRY_AFTER_MS],
  );
  for (const row of rows) {
    await ringBell(core, { id: row.message_id, sender: row.message_sender, system_key: row.message_system_key }, row, nowMs);
  }
  return rows.length;
}

/** A row of the mail outbox: the owed message's columns beside its request's. */
interface DueMailRow {
  readonly message_id: string;
  readonly message_at: number | string;
  readonly mail_attempts: number | string;
  readonly id: string;
  readonly account_id: string;
  readonly category: string;
  readonly created_at: number | string;
  readonly person_read_at: number | string | null;
  readonly last_mail_at: number | string | null;
}

/** D14: sends the mails owed at `nowMs`, as the file comment says. */
export async function sendDue(core: TicketsCore, nowMs: number): Promise<OpsOutboxRun> {
  const { db, tables, limits } = core;
  const run = { sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const lines = { suppressed: 0, failed: 0, deferred: 0 };
  const rows = await db.all<DueMailRow>(
    `SELECT m.id AS message_id, m.created_at AS message_at, m.mail_attempts, t.id, t.account_id, t.category, t.created_at, t.person_read_at, t.last_mail_at
     FROM ${tables.messages} m JOIN ${tables.tickets} t ON t.id = m.ticket_id
     WHERE m.mail_state = 'owed' AND m.sender = 'staff' AND m.created_at <= ?
     ORDER BY m.created_at ASC LIMIT ${RUN_BATCH}`,
    [nowMs - limits.mailUnreadMs],
  );
  /** The last mail of each request in this run, so two owed rows on one request keep the gap between them. */
  const lastMailAt = new Map<string, number | null>();
  const mark = (messageId: string, state: 'sent' | 'skipped' | 'failed' | 'owed') =>
    db.run(`UPDATE ${tables.messages} SET mail_state = ?, mail_attempts = mail_attempts + 1 WHERE id = ?`, [state, messageId]);

  for (const row of rows) {
    const messageAt = numberOf(row.message_at);
    const read = timeOf(row.person_read_at);
    if (read !== null && read >= messageAt) {
      await mark(row.message_id, 'skipped');
      run.skipped += 1;
      continue;
    }
    const lastMail = lastMailAt.has(row.id) ? (lastMailAt.get(row.id) ?? null) : timeOf(row.last_mail_at);
    if (lastMail !== null && nowMs - lastMail < limits.mailGapMs) {
      await mark(row.message_id, 'skipped');
      run.skipped += 1;
      continue;
    }
    let identity: OpsIdentity;
    try {
      identity = await core.host.identity(row.account_id);
    } catch {
      // The host's directory gave no answer: the row stays owed for the next tick, since nothing says whether the account is gone or deleting (D14).
      run.deferred += 1;
      lines.deferred += 1;
      continue;
    }
    if (identity === null || (typeof identity === 'object' && (identity as { deleting?: unknown }).deleting === true)) {
      await mark(row.message_id, 'skipped');
      run.skipped += 1;
      continue;
    }
    const mail: OpsMail = {
      kind: 'supportReply',
      accountId: row.account_id,
      ticketId: row.id,
      category: row.category,
      openedAt: numberOf(row.created_at),
      idempotencyKey: row.message_id,
    };
    let answer: 'sent' | 'failed' | 'suppressed';
    try {
      answer = await core.context.options.mail(mail);
    } catch {
      answer = 'failed';
    }
    if (answer === 'sent') {
      await mark(row.message_id, 'sent');
      await db.run(`UPDATE ${tables.tickets} SET last_mail_at = ? WHERE id = ?`, [nowMs, row.id]);
      lastMailAt.set(row.id, nowMs);
      run.sent += 1;
    } else if (answer === 'suppressed') {
      await mark(row.message_id, 'skipped');
      run.skipped += 1;
      lines.suppressed += 1;
    } else if (numberOf(row.mail_attempts) + 1 >= MAIL_ATTEMPTS) {
      await mark(row.message_id, 'failed');
      run.failed += 1;
      lines.failed += 1;
    } else {
      await mark(row.message_id, 'owed');
      run.deferred += 1;
    }
  }
  if (lines.suppressed > 0) ownLine(core.logger, 'warn', 'ops_mail', { outcome: 'suppressed', count: lines.suppressed });
  if (lines.failed > 0) ownLine(core.logger, 'warn', 'ops_mail', { outcome: 'failed', count: lines.failed });
  if (lines.deferred > 0) ownLine(core.logger, 'warn', 'ops_mail', { outcome: 'deferred', count: lines.deferred });
  return run;
}

/**
 * D20: marks the account's owed mail rows `skipped` and gives up the bell rows owed to it (the
 * staff messages and identity openings on its requests), for a product's deletion step.
 */
export async function hangupOutboxes(core: TicketsCore, accountId: string): Promise<void> {
  const { db, tables } = core;
  await db.run(
    `UPDATE ${tables.messages} SET mail_state = 'skipped' WHERE mail_state = 'owed' AND ticket_id IN (SELECT id FROM ${tables.tickets} WHERE account_id = ?)`,
    [accountId],
  );
  await db.run(
    `UPDATE ${tables.messages} SET notify_attempts = ? WHERE notified_at IS NULL AND notify_attempts < ?
       AND (sender = 'staff' OR (sender = 'system' AND system_key = 'identity_opened'))
       AND ticket_id IN (SELECT id FROM ${tables.tickets} WHERE account_id = ?)`,
    [NOTIFY_ATTEMPTS, NOTIFY_ATTEMPTS, accountId],
  );
}
