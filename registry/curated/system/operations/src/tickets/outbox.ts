/**
 * @fileoverview The mail and bell outboxes (D14, D15). A staff message is written `mail_state:
 * 'owed'`; `sendDue(now)`, which the minute tick runs, sends through `mail()` each owed message
 * unread five minutes after it was written (`person_read_at` before it) whose request has had no
 * mail in the gap, marks it `sent` with the request's `last_mail_at`, marks `skipped` one read or
 * inside the gap, tries a failed send once more at the next tick and then marks `failed` with one
 * `ops_mail` line, marks `skipped` at once on `suppressed` with one line and no retry, and marks
 * every owed row of an account gone or `deleting` `skipped`. The person's own and system messages
 * are never mailed, except the identity opening: its row is owed until its mail went, sent at once
 * by `openIdentity` when the directory answers a live account, and otherwise the tick's, with no
 * five-minute wait and no gap.
 *
 * An `identity()` call that throws leaves the row `owed` for the next tick, counted as deferred with
 * one `ops_mail` line a run: no answer says whether the account is gone or deleting, so the mail is
 * neither sent nor given up. A run reads the owed rows oldest first, a page at a time, until it has
 * settled a batch of them or they run out, so the rows deferred this way are passed over inside the
 * run and the mail behind them goes; at most ten pages a run, so a flood of such rows costs a
 * bounded run.
 *
 * The bell: after a write's commit, `notify` is called with a dedupe key made from the message's id,
 * and `notified_at` marked; `notifyDue(now)` calls again for a message unmarked for over a minute,
 * three attempts in all. Every recipient is read through `identity()`: one the directory does not
 * know or marks deleting is dropped, and the name and address it answers are discarded. A message
 * whose notice has no recipient left, or a host without `notify`, is marked done at once. A hook
 * that throws, the recipients' or the bell's, is one counted attempt, so a lookup that keeps failing
 * stops at the third and never starves the rows behind it.
 *
 * Each row is claimed before a hook is called for it, so two drains at once deliver each notice
 * once. In a process, the row's id is held in the module's own set while it is sent or rung, which
 * the identity opening's at-once send and a run of the tick share. Across processes, on PostgreSQL,
 * the claim is a transaction that first asks `pg_try_advisory_xact_lock` for the row's key (the
 * channel's and the message id's hashes, the account lock's form) and reads the row's state again
 * inside it, so a row another process holds or has settled since the page was read is passed over
 * and counted nowhere; the hooks run inside the claim and the row is marked through its handle, so
 * the claim ends with the transaction, a dying process included, and `identity` is given that handle
 * to read through (a `mail` or `notify` hook that reads the product's database through the pool
 * needs a pool of two or more). A bell's claim counts its attempt first, so a hook that throws
 * leaves one attempt counted when the claim commits. On SQLite, one process by deployment, the set
 * alone keeps the drains apart. The module also runs one `sendDue` and one `notifyDue` at a time a
 * process (a call while one runs joins it).
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
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
/** The most pages of owed rows one mail run reads past the rows it defers. */
export const MAIL_RUN_PAGES_MAX = 10;

/** A claim's answer when another drain holds the row or has settled it: the caller passes the row over and counts it nowhere. */
type Taken = 'taken';

/**
 * Runs `work` with the row `messageId` claimed (the file comment): `taken` when this process holds
 * it or, on PostgreSQL, another process does. `work` is given the handle to read the row's state
 * again and to mark it through: the claim's transaction on PostgreSQL, the adapter on SQLite.
 * Throws what `work` or the database throws, the claim's transaction rolled back with it.
 */
async function claimed<T>(core: TicketsCore, messageId: string, work: (writer: StorageAdapter) => Promise<T | Taken>): Promise<T | Taken> {
  if (core.claims.has(messageId)) return 'taken';
  core.claims.add(messageId);
  try {
    if (!core.postgres) return await work(core.db);
    return await core.db.transaction(async (trx): Promise<T | Taken> => {
      const row = await trx.get<{ taken: unknown }>('SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?)) AS taken', [core.channel, messageId]);
      if (row?.taken !== true && row?.taken !== 't') return 'taken';
      return work(trx);
    });
  } finally {
    core.claims.delete(messageId);
  }
}

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

/** Whether an identity answer names an account that can be told something: not gone (null) and not deleting. */
export const isLive = (identity: OpsIdentity): identity is { readonly name: string | null; readonly email: string } =>
  identity !== null && typeof identity === 'object' && (identity as { deleting?: unknown }).deleting !== true;

/** Whether `accountId` is gone or being deleted, as the identity hook says through `reader`; the name and address it answers are discarded. */
export async function unreachable(core: TicketsCore, accountId: string, reader: StorageAdapter): Promise<boolean> {
  return !isLive(await core.host.identity(accountId, reader));
}

/** `accountIds` without the gone and the deleting ones and without repeats, the directory asked through `reader`. */
export async function liveRecipients(core: TicketsCore, accountIds: readonly string[], reader: StorageAdapter): Promise<string[]> {
  const live: string[] = [];
  for (const accountId of new Set(accountIds)) {
    if (typeof accountId !== 'string' || accountId.length === 0) continue;
    if (!(await unreachable(core, accountId, reader))) live.push(accountId);
  }
  return live;
}

/**
 * Rings the bell for `message` on `ticket` once: claims the row with its attempt counted, then marks
 * it done when nothing is owed or the notice went, and leaves the attempt counted when a hook threw
 * (D15), so the row is tried again at the next tick and given up at the third. Never throws: a row
 * another drain holds or has marked is passed over, and a statement the database refuses leaves the
 * row for the next tick (on PostgreSQL the claim rolls back with it).
 */
export async function ringBell(core: TicketsCore, message: BellMessage, ticket: TicketRow, nowMs: number): Promise<void> {
  const { tables } = core;
  try {
    await claimed<'rung' | 'missed'>(core, message.id, async (writer) => {
      // The claim: one attempt counted now, on a row still unmarked with attempts left; a row another drain marked or holds is passed over.
      const claim = await writer.run(`UPDATE ${tables.messages} SET notify_attempts = notify_attempts + 1 WHERE id = ? AND notified_at IS NULL AND notify_attempts < ?`, [message.id, NOTIFY_ATTEMPTS]);
      if (Number(claim.changes) !== 1) return 'taken';
      try {
        const notify = core.host.notify;
        const target = await bellTargetOf(core, message, ticket);
        if (target !== null && notify !== undefined) {
          const accountIds = await liveRecipients(core, target.accountIds, writer);
          if (accountIds.length > 0) await notify({ kind: target.kind, accountIds, ticketId: ticket.id, dedupeKey: `${target.kind}:${message.id}` });
        }
      } catch {
        // The recipients' lookup or the bell refused: the attempt stays counted, and the row is tried again at the next tick (D15).
        return 'missed';
      }
      await writer.run(`UPDATE ${tables.messages} SET notified_at = ? WHERE id = ?`, [nowMs, message.id]);
      return 'rung';
    });
  } catch {
    // The database refused a statement: the row is left as it was for the next tick.
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
     ORDER BY m.created_at ASC LIMIT ${core.batch}`,
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
  readonly message_sender: MessageRow['sender'];
  readonly id: string;
  readonly account_id: string;
  readonly category: string;
  readonly created_at: number | string;
  readonly person_read_at: number | string | null;
  readonly last_mail_at: number | string | null;
}

/** One owed mail as `mailOne` sends it. */
interface OwedMail {
  readonly messageId: string;
  readonly kind: 'supportReply' | 'supportIdentityOpened';
  readonly ticketId: string;
  readonly accountId: string;
  readonly category: string;
  readonly openedAt: number;
}

/** What became of one owed mail: sent, skipped for good, failed for good, or left owed for the next tick. */
export type MailOutcome = 'sent' | 'skipped' | 'failed' | 'deferred';

/** One step of `mailOne`: the outcomes, with the two ways a row is left owed told apart (`retry` after a failed send, the attempt counted, and `unanswered` when the directory gave no answer, the row as it was), and `taken` for a row another drain holds or has settled. */
type MailStep = 'sent' | 'skipped' | 'failed' | 'retry' | 'unanswered' | Taken;

/** The outcome a step comes to; a taken row is the other drain's, left to it as a deferred row is left to the tick. */
const outcomeOf = (step: MailStep): MailOutcome => (step === 'retry' || step === 'unanswered' || step === 'taken' ? 'deferred' : step);

/** The `ops_mail` lines a run gathers, one a kind. */
interface MailLines {
  suppressed: number;
  failed: number;
  deferred: number;
}

/** The owed row's state as the claim finds it, or null when the row is gone. */
interface OwedState {
  readonly mail_state: string | null;
  readonly mail_attempts: number | string;
}

/** The state of the owed row `messageId` through `writer`: null when another drain settled it or it is gone. */
async function owedState(core: TicketsCore, writer: StorageAdapter, messageId: string): Promise<OwedState | null> {
  const current = await writer.get<OwedState>(`SELECT mail_state, mail_attempts FROM ${core.tables.messages} WHERE id = ?`, [messageId]);
  return current !== null && current.mail_state === 'owed' ? current : null;
}

/** Marks the claimed row `messageId` with `state` through `writer`, the attempt counted. */
const markMail = (core: TicketsCore, writer: StorageAdapter, messageId: string, state: 'sent' | 'skipped' | 'failed' | 'owed') =>
  writer.run(`UPDATE ${core.tables.messages} SET mail_state = ?, mail_attempts = mail_attempts + 1 WHERE id = ?`, [state, messageId]);

/** Marks the owed row `messageId` `skipped` under a claim, with no hook called: `taken` when another drain holds or settled it. */
async function skipOwed(core: TicketsCore, messageId: string): Promise<'skipped' | Taken> {
  return claimed<'skipped'>(core, messageId, async (writer) => {
    if ((await owedState(core, writer, messageId)) === null) return 'taken';
    await markMail(core, writer, messageId, 'skipped');
    return 'skipped';
  });
}

/**
 * Sends one owed mail (D14) under a claim on its row: `taken` when another drain holds or settled
 * the row, the row left owed and uncounted when `identity()` throws (deferred), marked `skipped` for
 * an account gone or deleting or an address the sender suppressed, `sent` when the mail went, left
 * owed with the attempt counted after a first failed send, and marked `failed` after the second.
 * The reply's `last_mail_at` is the caller's.
 */
async function mailOne(core: TicketsCore, owed: OwedMail, lines: MailLines): Promise<MailStep> {
  return claimed<Exclude<MailStep, Taken>>(core, owed.messageId, async (writer) => {
    // The row as it is now: one another drain settled since the page was read is passed over, and the attempts are read fresh.
    const current = await owedState(core, writer, owed.messageId);
    if (current === null) return 'taken';
    const attempts = numberOf(current.mail_attempts);
    let identity: OpsIdentity;
    try {
      identity = await core.host.identity(owed.accountId, writer);
    } catch {
      // The host's directory gave no answer: the row stays owed for the next tick, since nothing says whether the account is gone or deleting (D14).
      lines.deferred += 1;
      return 'unanswered';
    }
    if (!isLive(identity)) {
      await markMail(core, writer, owed.messageId, 'skipped');
      return 'skipped';
    }
    const idempotencyKey = owed.kind === 'supportIdentityOpened' ? `identity:${owed.messageId}` : owed.messageId;
    const mail: OpsMail = { kind: owed.kind, accountId: owed.accountId, ticketId: owed.ticketId, category: owed.category, openedAt: owed.openedAt, idempotencyKey };
    let answer: 'sent' | 'failed' | 'suppressed';
    try {
      answer = await core.context.options.mail(mail);
    } catch {
      answer = 'failed';
    }
    if (answer === 'sent') {
      await markMail(core, writer, owed.messageId, 'sent');
      return 'sent';
    }
    if (answer === 'suppressed') {
      await markMail(core, writer, owed.messageId, 'skipped');
      lines.suppressed += 1;
      return 'skipped';
    }
    if (attempts + 1 >= MAIL_ATTEMPTS) {
      await markMail(core, writer, owed.messageId, 'failed');
      lines.failed += 1;
      return 'failed';
    }
    await markMail(core, writer, owed.messageId, 'owed');
    return 'retry';
  });
}

/** Writes the run's `ops_mail` lines, one a kind with its count. */
function writeMailLines(core: TicketsCore, lines: MailLines): void {
  if (lines.suppressed > 0) ownLine(core.logger, 'warn', 'ops_mail', { outcome: 'suppressed', count: lines.suppressed });
  if (lines.failed > 0) ownLine(core.logger, 'warn', 'ops_mail', { outcome: 'failed', count: lines.failed });
  if (lines.deferred > 0) ownLine(core.logger, 'warn', 'ops_mail', { outcome: 'deferred', count: lines.deferred });
}

/**
 * Sends the identity opening's mail for `messageId` on `ticket` now, with no five-minute wait and
 * no gap (D11, D14), the row written owed by the opening: `sent` when the directory answers a live
 * account and the mail went, `skipped` for an account gone or deleting, and left owed for the tick
 * when the lookup throws or the send fails, or when a run of the tick holds the row already, with
 * the run's lines written at once.
 */
export async function sendIdentityMail(core: TicketsCore, ticket: TicketRow, messageId: string): Promise<MailOutcome> {
  const lines: MailLines = { suppressed: 0, failed: 0, deferred: 0 };
  const step = await mailOne(
    core,
    { messageId, kind: 'supportIdentityOpened', ticketId: ticket.id, accountId: ticket.account_id, category: ticket.category, openedAt: numberOf(ticket.created_at) },
    lines,
  );
  writeMailLines(core, lines);
  return outcomeOf(step);
}

/** D14: sends the mails owed at `nowMs`, as the file comment says. */
export async function sendDue(core: TicketsCore, nowMs: number): Promise<OpsOutboxRun> {
  const { db, tables, limits } = core;
  const run = { sent: 0, skipped: 0, failed: 0, deferred: 0 };
  const lines: MailLines = { suppressed: 0, failed: 0, deferred: 0 };
  /** The last mail of each request in this run, so two owed rows on one request keep the gap between them. */
  const lastMailAt = new Map<string, number | null>();
  const dueBefore = nowMs - limits.mailUnreadMs;
  /** The last row read, which the next page starts after; the rows deferred this run are passed over this way. */
  let after: { readonly at: number; readonly id: string } | null = null;
  let settled = 0;

  for (let page = 0; page < MAIL_RUN_PAGES_MAX && settled < core.batch; page += 1) {
    const rows: DueMailRow[] = await db.all<DueMailRow>(
      `SELECT m.id AS message_id, m.created_at AS message_at, m.sender AS message_sender, t.id, t.account_id, t.category, t.created_at, t.person_read_at, t.last_mail_at
       FROM ${tables.messages} m JOIN ${tables.tickets} t ON t.id = m.ticket_id
       WHERE m.mail_state = 'owed' AND ((m.sender = 'staff' AND m.created_at <= ?) OR (m.sender = 'system' AND m.system_key = 'identity_opened'))${
         after === null ? '' : ' AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))'
       }
       ORDER BY m.created_at ASC, m.id ASC LIMIT ${core.batch}`,
      after === null ? [dueBefore] : [dueBefore, after.at, after.at, after.id],
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      after = { at: numberOf(row.message_at), id: row.message_id };
      const identityOpening = row.message_sender === 'system';
      let step: MailStep;
      if (!identityOpening && dueIsSettled(row, nowMs, lastMailAt, limits.mailGapMs)) {
        // Read, or inside the gap: skipped with no hook called, under a claim all the same.
        step = await skipOwed(core, row.message_id);
      } else {
        step = await mailOne(
          core,
          {
            messageId: row.message_id,
            kind: identityOpening ? 'supportIdentityOpened' : 'supportReply',
            ticketId: row.id,
            accountId: row.account_id,
            category: row.category,
            openedAt: numberOf(row.created_at),
          },
          lines,
        );
        if (step === 'sent' && !identityOpening) {
          await db.run(`UPDATE ${tables.tickets} SET last_mail_at = ? WHERE id = ?`, [nowMs, row.id]);
          lastMailAt.set(row.id, nowMs);
        }
      }
      // A row another drain holds is its, counted nowhere; a row whose lookup threw is left as it was and not counted as settled, so the run reads on past it to the mail behind.
      if (step !== 'taken') run[outcomeOf(step)] += 1;
      if (step !== 'unanswered') settled += 1;
      if (settled >= core.batch) break;
    }
    if (rows.length < core.batch) break;
  }
  writeMailLines(core, lines);
  return run;
}

/** Whether the staff reply `row` owes no mail at `nowMs`: read by the person at or after it was written, or inside the request's mail gap (D14). */
function dueIsSettled(row: DueMailRow, nowMs: number, lastMailAt: Map<string, number | null>, mailGapMs: number): boolean {
  const messageAt = numberOf(row.message_at);
  const read = timeOf(row.person_read_at);
  const lastMail = lastMailAt.has(row.id) ? (lastMailAt.get(row.id) ?? null) : timeOf(row.last_mail_at);
  return (read !== null && read >= messageAt) || (lastMail !== null && nowMs - lastMail < mailGapMs);
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
