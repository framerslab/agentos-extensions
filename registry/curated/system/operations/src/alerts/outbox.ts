/**
 * @fileoverview The Discord outbox (`<prefix>_discord_outbox`, migration 0004): the alerts a product's jobs post to its staff
 * channels through the host's `discord` hook. `post` writes one pending row a fact under a unique `dedupKey`, its lines joined with
 * line feeds into `content`, and refuses a line, key or source that carries a run of 32 hexadecimal characters (the package's own
 * ids and most products'), a UUID or an address, so no person's id or address reaches Discord through it. A channel holds 50 pending
 * rows: the post past them drops the oldest, counted on one `ops_discord` line, and each drain drops what still stands past the bound.
 *
 * `sendDue(now)` takes each due row in turn and claims it for the whole of its try. On PostgreSQL the claim is one transaction a
 * row, `FOR UPDATE SKIP LOCKED`, with the hook called inside it and the row's new state written before it commits, so a second
 * process passes the row over while the hook runs. On SQLite the claim is persisted: a conditional move of the row's `next_at` past
 * the hook's deadline, which one changed row proves this instance won, so a second `createOperations` over the same file skips the
 * row; and past that deadline a module-level set of the rows whose hook is still awaited, per adapter and table, keeps every drain
 * over that adapter off the row for the hook's whole life (SQLite is one process by the adapter's design). The two writes after the
 * hook are fenced by the claim's `next_at`, so a settlement after another instance re-claimed the row changes nothing.
 *
 * The hook is given the claim's deadline as an `AbortSignal` (6 seconds) and is awaited to its settlement: a sender that honours the
 * signal settles at the deadline, and one that ignores it holds the claim until it settles; no race releases the row under a pending
 * sender. `sent` marks the row delivered with Discord's message id; `retry` sets the next try after its wait; `failed` and a throw
 * set it by the backoff (5 seconds doubling to 10 minutes). 24 hours after its first try a row gives up: `failed` with `gave_up`, and
 * its lines go as one `teamAlert` mail through the host's `mail`, keyed by the row's `dedupKey`, tried twice a minute apart as the
 * ticket mail outbox tries, `suppressed` at once. On PostgreSQL the hook and the mail run from a savepoint the claim settles once
 * they return, as the ticket outboxes' hooks do: a statement they fail through the handle is undone back to it and counts as a failed
 * try, so the claim's own writes land and the row never repeats its try unrecorded. A row with no hook to try is marked `failed`
 * with `no_hook`. Settled rows (delivered, failed with their mail settled, dropped) go 30 days after they settled, by the hourly
 * sweep's `discord_outbox` step.
 *
 * One drain at a time a process (a call while one runs joins it); `stop()` waits for a running drain within its 3 seconds, and no
 * row begins once `stop()` has begun. The lines: `delivery_sent` and `delivery_retry` (with `answer`, a word, beside `status`, an
 * integer, where there is one, and `wait_s`), `delivery_failed` (`answer`: `mail_failed` or `suppressed`) and `ops_discord`
 * (`outcome`: `dropped` or `no_hook`, with `count`), each with the row's `channel`; never a line's words or a key.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsContext } from '../context.js';
import { isWord } from '../context.js';
import type { Alerts, OpsAlertRow, OpsDiscordAnswer, OpsDiscordPost } from '../contract.js';
import { ownLine } from '../own-lines.js';
import { clean } from '../store/clean.js';
import { randomHex } from '../store/ids.js';
import { dialectOf } from '../store/migrations.js';

/** The most characters a post's lines hold, joined with line feeds: Discord's limit for a webhook message's content. */
export const ALERT_CONTENT_MAX = 2_000;
/** The most characters a post's `dedupKey` holds. */
export const ALERT_DEDUP_KEY_MAX = 200;
/** How long after a row's first try it gives up into a team mail. */
export const ALERT_GIVE_UP_MS = 24 * 3_600_000;
/** The pending rows a channel holds; the post past them drops the oldest. */
export const ALERT_PENDING_MAX = 50;
/** The tries of a given-up row's team mail, as the ticket mail outbox's `MAIL_ATTEMPTS`. */
export const ALERT_MAIL_ATTEMPTS = 2;
/** The wait before a failed team mail is tried again. */
export const ALERT_MAIL_RETRY_MS = 60_000;
/** The claim's deadline, handed to the hook as a signal: past the webhook sender's own 5 seconds. */
export const ALERT_HOOK_TIMEOUT_MS = 6_000;
/** The most rows `list` answers. */
export const ALERT_LIST_MAX = 50;
/** The most rows one drain tries; a larger backlog goes on in the next. */
export const DRAIN_ROWS_MAX = 200;
/** The team mail's key a given-up row is sent under. */
export const ALERT_MAIL_KEY = 'discord_undelivered';

/** The wait after a failed try: 5 s doubling to 10 minutes. */
export function alertBackoffMs(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 600_000);
}

/** A post's `source` is a scheduler job's name (up to 64 characters, the triggers rule), not the package's 32-character `WORD`. */
const SOURCE = /^[a-z][a-z0-9_]{0,63}$/;

/** The shapes a staff alert never carries: a run of 32 hexadecimal characters (an id's, the package's `tkt_` ids among them), a UUID, an address. */
const PERSON_SHAPES: readonly RegExp[] = [/[0-9a-f]{32}/i, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /\S+@\S+\.\S+/];

/** Whether `text` carries one of the shapes a staff alert never carries. */
export const carriesPersonShape = (text: string): boolean => PERSON_SHAPES.some((shape) => shape.test(text));

interface Row {
  id: string;
  source: string;
  channel: string;
  dedup_key: string;
  content: string;
  state: OpsAlertRow['state'];
  attempts: number | string;
  first_attempt_at: number | string | null;
  next_at: number | string;
  delivered_at: number | string | null;
  delivery_id: string | null;
  last_answer: string | null;
  mail_state: OpsAlertRow['mailState'];
  mail_attempts: number | string;
  settled_at: number | string | null;
  created: number | string;
}

interface Counts {
  sent: number;
  retried: number;
  failed: number;
  dropped: number;
}

const num = (value: number | string | null): number | null => (value === null ? null : Number(value));

const rowView = (row: Row): OpsAlertRow => ({
  id: row.id,
  source: row.source,
  channel: row.channel,
  dedupKey: row.dedup_key,
  state: row.state,
  attempts: Number(row.attempts),
  firstAttemptAt: num(row.first_attempt_at),
  nextAt: Number(row.next_at),
  deliveredAt: num(row.delivered_at),
  deliveryId: row.delivery_id,
  mailState: row.mail_state,
  lastAnswer: row.last_answer,
  createdAt: Number(row.created),
});

/** A status code as an integer, or null for anything else. */
const statusOf = (value: unknown): number | null => (typeof value === 'number' && Number.isSafeInteger(value) ? value : null);

/** The hook's answer read as one of the three; anything else is a failed try with no answer. */
function answerOf(value: unknown): OpsDiscordAnswer {
  const answer = value as { outcome?: unknown; deliveryId?: unknown; afterMs?: unknown; status?: unknown } | null | undefined;
  if (typeof answer !== 'object' || answer === null) return { outcome: 'failed', status: null };
  if (answer.outcome === 'sent' && typeof answer.deliveryId === 'string' && answer.deliveryId.length > 0) {
    return { outcome: 'sent', deliveryId: answer.deliveryId };
  }
  if (answer.outcome === 'retry' && typeof answer.afterMs === 'number' && Number.isFinite(answer.afterMs) && answer.afterMs >= 0) {
    return { outcome: 'retry', afterMs: Math.round(answer.afterMs), status: statusOf(answer.status) };
  }
  if (answer.outcome === 'failed') return { outcome: 'failed', status: statusOf(answer.status) };
  return { outcome: 'failed', status: null };
}

/**
 * On SQLite, the rows whose hook is still awaited, per adapter and table, shared by every `createOperations` of this module over
 * that adapter: SQLite is one process by the adapter's design, so this set excludes a second drain for the hook's whole life, past
 * the persisted claim's expiry (a hook that ignores its signal can outlive the claim, and a second instance over the same `db` would
 * post the row again).
 */
const awaited = new WeakMap<StorageAdapter, Map<string, Set<string>>>();

function inHookOf(db: StorageAdapter, table: string): Set<string> {
  let tables = awaited.get(db);
  if (tables === undefined) {
    tables = new Map();
    awaited.set(db, tables);
  }
  let rows = tables.get(table);
  if (rows === undefined) {
    rows = new Set();
    tables.set(table, rows);
  }
  return rows;
}

/** What `createAlerts` takes besides the context: the claim's deadline, `ALERT_HOOK_TIMEOUT_MS` unless a test shortens it. */
export interface AlertTiming {
  readonly hookTimeoutMs?: number;
}

/** Builds `operations.alerts` over `context` (the file comment). */
export function createAlerts(context: OpsContext, timing: AlertTiming = {}): Alerts {
  const table = context.table('discord_outbox');
  const db = context.db;
  const postgres = dialectOf(db) === 'postgres';
  const inHook = inHookOf(db, table);
  const hookTimeoutMs = timing.hookTimeoutMs ?? ALERT_HOOK_TIMEOUT_MS;
  let running: Promise<Counts> | null = null;
  // stop() waits for a running drain within its deadline, as it waits for a flush: a hook's settlement writes through the host's handle.
  context.flushers.add(() => (running === null ? Promise.resolve() : running.then(() => undefined, () => undefined)));

  /** Marks where a hook or the mail starts inside a PostgreSQL claim (the file comment); nothing on SQLite, where no transaction is held. */
  async function markHook(writer: StorageAdapter): Promise<void> {
    if (postgres) await writer.exec('SAVEPOINT ops_discord_hook');
  }

  /** Undoes what a hook's failed statement did to the claim's transaction, back to `markHook`. */
  async function undoHook(writer: StorageAdapter): Promise<void> {
    if (postgres) await writer.exec('ROLLBACK TO SAVEPOINT ops_discord_hook');
  }

  /**
   * Ends the savepoint once the hook has returned: true when the transaction is live, and false when the release is refused, which a
   * hook that swallowed its own failed statement leaves behind; that is rolled back to, so the claim's writes after it land, and the
   * hook counts as failed. True on SQLite.
   */
  async function settleHook(writer: StorageAdapter): Promise<boolean> {
    if (!postgres) return true;
    try {
      await writer.exec('RELEASE SAVEPOINT ops_discord_hook');
      return true;
    } catch {
      await writer.exec('ROLLBACK TO SAVEPOINT ops_discord_hook').catch(() => undefined);
      return false;
    }
  }

  /**
   * Drops the oldest pending rows of `channel` past `ALERT_PENDING_MAX`, with one `ops_discord` line; answers how many. On
   * PostgreSQL a row a drain holds is skipped, so a post never waits on a hook.
   */
  async function cap(channel: string, nowMs: number): Promise<number> {
    const oldest = `SELECT id FROM ${table} WHERE channel = ? AND state = 'pending' ORDER BY created DESC, id DESC ${
      postgres ? `OFFSET ${ALERT_PENDING_MAX} FOR UPDATE SKIP LOCKED` : `LIMIT -1 OFFSET ${ALERT_PENDING_MAX}`
    }`;
    const changed = await db.run(`UPDATE ${table} SET state = 'dropped', last_answer = 'dropped', settled_at = ? WHERE id IN (${oldest}) AND state = 'pending'`, [
      nowMs,
      channel,
    ]);
    const dropped = Number(changed.changes);
    if (!Number.isSafeInteger(dropped) || dropped <= 0) return 0;
    ownLine(context.logger, 'warn', 'ops_discord', { channel, outcome: 'dropped', count: dropped });
    return dropped;
  }

  /** The bound on every channel past it, at a drain's start: rows another way than `post` wrote, or a post whose own cap failed. */
  async function capAll(nowMs: number): Promise<number> {
    const over = await db.all<{ channel: string }>(`SELECT channel FROM ${table} WHERE state = 'pending' GROUP BY channel HAVING COUNT(*) > ${ALERT_PENDING_MAX}`);
    let dropped = 0;
    for (const { channel } of over) dropped += await cap(channel, nowMs);
    return dropped;
  }

  /** Sends a given-up row's team mail once and records what came of it (the file comment). */
  async function mailOwed(writer: StorageAdapter, row: Row, nowMs: number): Promise<void> {
    let answer: 'sent' | 'failed' | 'suppressed';
    await markHook(writer);
    try {
      answer = await context.options.mail(
        { kind: 'teamAlert', to: context.options.alertsTo, key: ALERT_MAIL_KEY, lines: row.content.split('\n').map((line) => ({ line })), idempotencyKey: row.dedup_key },
        writer,
      );
    } catch {
      // The sender threw, a statement of its own the database refused included: a failed send, undone to the savepoint so the mark lands.
      await undoHook(writer);
      answer = 'failed';
    }
    if (!(await settleHook(writer))) answer = 'failed';
    const attempts = Number(row.mail_attempts) + 1;
    if (answer === 'sent') {
      await writer.run(`UPDATE ${table} SET mail_state = 'sent', mail_attempts = ?, settled_at = ? WHERE id = ?`, [attempts, nowMs, row.id]);
    } else if (answer === 'suppressed' || attempts >= ALERT_MAIL_ATTEMPTS) {
      await writer.run(`UPDATE ${table} SET mail_state = 'failed', mail_attempts = ?, settled_at = ? WHERE id = ?`, [attempts, nowMs, row.id]);
      ownLine(context.logger, 'warn', 'delivery_failed', { channel: row.channel, answer: answer === 'suppressed' ? 'suppressed' : 'mail_failed' });
    } else {
      await writer.run(`UPDATE ${table} SET mail_attempts = ?, next_at = ? WHERE id = ?`, [attempts, nowMs + ALERT_MAIL_RETRY_MS, row.id]);
    }
  }

  /** One claimed row's try through `writer` (the claim's transaction on PostgreSQL, the adapter on SQLite); `row.next_at` is the claim's. */
  async function tryRow(writer: StorageAdapter, row: Row, nowMs: number, counts: Counts): Promise<void> {
    if (row.state === 'failed') {
      await mailOwed(writer, row, nowMs);
      return;
    }
    const claimedAt = Number(row.next_at);
    const first = num(row.first_attempt_at);
    if (first !== null && nowMs - first >= ALERT_GIVE_UP_MS) {
      const gaveUp = await writer.run(`UPDATE ${table} SET state = 'failed', last_answer = 'gave_up', mail_state = 'owed' WHERE id = ? AND next_at = ?`, [row.id, claimedAt]);
      if (Number(gaveUp.changes) !== 1) return;
      counts.failed += 1;
      await mailOwed(writer, { ...row, state: 'failed', mail_state: 'owed' }, nowMs);
      return;
    }
    const hook = context.options.discord;
    if (hook === undefined) {
      ownLine(context.logger, 'warn', 'ops_discord', { channel: row.channel, outcome: 'no_hook', count: 1 });
      await writer.run(`UPDATE ${table} SET state = 'failed', last_answer = 'no_hook', settled_at = ? WHERE id = ? AND next_at = ?`, [nowMs, row.id, claimedAt]);
      counts.failed += 1;
      return;
    }
    // The hook is given the claim's deadline as a signal and is awaited to its settlement: the row stays claimed while the hook can
    // still act (a sender that honours the signal settles at the deadline; one that ignores it holds the claim until it settles).
    await markHook(writer);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(new Error('the claim timed out')), hookTimeoutMs);
    deadline.unref?.();
    let answer: OpsDiscordAnswer;
    try {
      const post: OpsDiscordPost = { source: row.source, channel: row.channel, lines: row.content.split('\n'), dedupKey: row.dedup_key };
      answer = answerOf(await hook.call(context.options, post, writer, controller.signal));
    } catch {
      await undoHook(writer);
      answer = { outcome: 'failed', status: null };
    } finally {
      clearTimeout(deadline);
    }
    if (!(await settleHook(writer))) answer = { outcome: 'failed', status: null };
    const attempts = Number(row.attempts) + 1;
    const firstAt = first ?? nowMs;
    // Both writes are fenced by the claim's `next_at` (on SQLite the value the claim wrote, on PostgreSQL the locked row's own), so a
    // settlement after another instance re-claimed the row changes nothing.
    if (answer.outcome === 'sent') {
      await writer.run(
        `UPDATE ${table} SET state = 'delivered', attempts = ?, first_attempt_at = ?, delivered_at = ?, delivery_id = ?, last_answer = '200', settled_at = ? WHERE id = ? AND next_at = ?`,
        [attempts, firstAt, nowMs, answer.deliveryId, nowMs, row.id, claimedAt],
      );
      ownLine(context.logger, 'info', 'delivery_sent', { channel: row.channel });
      counts.sent += 1;
      return;
    }
    const wait = answer.outcome === 'retry' ? answer.afterMs : alertBackoffMs(attempts);
    const rateLimited = answer.outcome === 'retry' && answer.status === 429;
    const word = answer.outcome === 'retry' ? (rateLimited ? '429' : 'unconfirmed') : answer.status === null ? 'no_answer' : String(answer.status);
    const reason = answer.outcome === 'retry' ? (rateLimited ? 'rate_limited' : 'unconfirmed') : answer.status === null ? 'no_answer' : 'status';
    await writer.run(`UPDATE ${table} SET attempts = ?, first_attempt_at = ?, next_at = ?, last_answer = ? WHERE id = ? AND next_at = ?`, [
      attempts,
      firstAt,
      nowMs + wait,
      word,
      row.id,
      claimedAt,
    ]);
    ownLine(context.logger, 'info', 'delivery_retry', { channel: row.channel, answer: reason, ...(answer.status === null ? {} : { status: answer.status }), wait_s: Math.round(wait / 1_000) });
    counts.retried += 1;
  }

  /** One due row claimed and tried (the file comment); answers false when no row is due that this drain may take. */
  async function oneRow(nowMs: number, counts: Counts): Promise<boolean> {
    const due = `((state = 'pending') OR (state = 'failed' AND mail_state = 'owed')) AND next_at <= ?`;
    if (postgres) {
      return db.transaction(async (trx) => {
        const row = await trx.get<Row>(`SELECT * FROM ${table} WHERE ${due} ORDER BY next_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`, [nowMs]);
        if (!row) return false;
        await tryRow(trx, row, nowMs, counts);
        return true;
      });
    }
    const rows = await db.all<Row>(`SELECT * FROM ${table} WHERE ${due} ORDER BY next_at ASC LIMIT 20`, [nowMs]);
    for (const row of rows) {
      // A row whose hook is still awaited over this adapter is skipped whatever its `next_at` reads (the set's comment).
      if (inHook.has(row.id)) continue;
      const held = nowMs + hookTimeoutMs + 1_000;
      const claimed = await db.run(`UPDATE ${table} SET next_at = ? WHERE id = ? AND next_at = ?`, [held, row.id, Number(row.next_at)]);
      if (Number(claimed.changes) !== 1) continue; // another instance holds it, or it was settled meanwhile
      inHook.add(row.id);
      try {
        await tryRow(db, { ...row, next_at: held }, nowMs, counts);
      } finally {
        inHook.delete(row.id);
      }
      return true;
    }
    return false;
  }

  return {
    async post(post: OpsDiscordPost) {
      if (typeof post !== 'object' || post === null) throw new TypeError('alerts.post: give a post');
      if (typeof post.source !== 'string' || !SOURCE.test(post.source) || !isWord(post.channel)) {
        throw new TypeError('alerts.post: source is a job name and channel is a word');
      }
      const key: unknown = post.dedupKey;
      if (typeof key !== 'string' || key.length === 0 || key.length > ALERT_DEDUP_KEY_MAX || clean(key) !== key) {
        throw new TypeError('alerts.post: dedupKey is 1 to 200 characters with no control character');
      }
      const given: unknown = post.lines;
      if (!Array.isArray(given) || given.some((line) => typeof line !== 'string' || /[\r\n]/.test(line))) {
        throw new TypeError('alerts.post: lines are strings without line breaks');
      }
      const lines = (given as string[]).map(clean);
      const content = lines.join('\n');
      if (lines.length === 0 || content.length === 0 || content.length > ALERT_CONTENT_MAX) throw new RangeError('alerts.post: 1 to 2,000 characters of lines');
      if (carriesPersonShape(content) || carriesPersonShape(key) || carriesPersonShape(post.source)) {
        throw new RangeError('alerts.post: a staff alert carries no id run of 32 hexadecimal characters, no UUID and no address');
      }
      const at = context.now();
      const id = randomHex(16);
      const changed = await db.run(
        `INSERT INTO ${table} (id, source, channel, dedup_key, content, state, attempts, next_at, created) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?) ON CONFLICT (dedup_key) DO NOTHING`,
        [id, post.source, post.channel, key, content, at, at],
      );
      if (Number(changed.changes) !== 1) return null;
      await cap(post.channel, at);
      return { id };
    },
    async list(filter, options = {}) {
      const asked = options.limit;
      const limit = typeof asked === 'number' && Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, ALERT_LIST_MAX) : 10;
      if (filter?.source !== undefined) {
        if (typeof filter.source !== 'string') throw new TypeError('alerts.list: source is a job name');
        return (await db.all<Row>(`SELECT * FROM ${table} WHERE source = ? ORDER BY created DESC, id DESC LIMIT ?`, [filter.source, limit])).map(rowView);
      }
      const prefix = filter?.prefix ?? '';
      if (typeof prefix !== 'string') throw new TypeError('alerts.list: prefix is a string');
      const pattern = `${prefix.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      return (await db.all<Row>(`SELECT * FROM ${table} WHERE dedup_key LIKE ? ESCAPE '\\' ORDER BY created DESC, id DESC LIMIT ?`, [pattern, limit])).map(rowView);
    },
    sendDue(nowMs) {
      if (running !== null) return running;
      const run = (async (): Promise<Counts> => {
        const counts: Counts = { sent: 0, retried: 0, failed: 0, dropped: 0 };
        if (context.stopped || context.closed) return counts;
        counts.dropped += await capAll(nowMs);
        for (let tried = 0; tried < DRAIN_ROWS_MAX; tried += 1) {
          // No row begins once stop() has begun: a hook's settlement writes through the host's handle, which it closes once stop() answers.
          if (context.stopped || context.closed) break;
          if (!(await oneRow(nowMs, counts))) break;
        }
        return counts;
      })().finally(() => {
        running = null;
      });
      running = run;
      return run;
    },
  };
}
