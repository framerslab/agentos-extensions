/**
 * @fileoverview Persistent weighted request quotas on PostgreSQL through `@framers/sql-storage-adapter`: three
 * released core spend meters (a project's rolling minute, a mailbox's rolling minute and a project's UTC day), and with
 * ceilings a fourth, each method's rolling minute in each mailbox, request slots that every worker shares and that
 * expire after a process dies, and durable provider retry times for a project, a mailbox or one method of a mailbox.
 * @module account-sources/sync/SourceQuota
 */

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import { SqlSpendMeter, spendMeterDdl } from '@framers/agentos/safety/runtime';
import { SourceSyncFault } from './state.js';

/**
 * The provider call a request makes, by its name: Gmail's `list`, `read`, `changes`, `profile` and `labels`, or another
 * provider's own methods, such as Slack's `conversations.history`. A name is a letter, then at most 63 letters,
 * digits, dots, underscores, colons or hyphens; the policy gives each its weight.
 */
export type SourceQuotaMethod = string;
/** Gmail's method names, in the order a policy's fingerprint has recorded their weights since the first release. */
const gmailMethods: readonly string[] = ['list', 'read', 'changes', 'profile', 'labels'];
/** The form of a method name. */
const methodName = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
/**
 * One method's ceiling: the requests of the method each mailbox may make in any rolling 60 seconds, as a provider such
 * as Slack limits each method of each workspace, and optionally the most objects one request may ask for (Slack's
 * `limit` on a page). Both are positive safe integers.
 */
export interface SourceQuotaCeiling {
  /** Requests of the method each mailbox may make in any rolling 60-second window. */
  readonly perMinute: number;
  /** The most objects one request of the method may ask for; a request that names more is refused. */
  readonly maxObjects?: number;
}
/**
 * Budgets and limits that every worker sharing the tables holds identically. Every value is a positive safe integer,
 * `timeoutMs` is at most 60,000, `slotGraceMs` lies between `timeoutMs` and 120,000, and `mailboxConcurrency` is at
 * most `projectConcurrency`; `SourceQuota` throws `invalid_source_quota_policy` otherwise.
 */
export interface SourceQuotaPolicy {
  /** Weighted units a project may consume in any rolling 60-second window. */
  readonly projectMinute: number;
  /** Weighted units one mailbox may consume in any rolling 60-second window. */
  readonly mailboxMinute: number;
  /** Weighted units a project may consume in one UTC day. */
  readonly projectDay: number;
  /** Requests a project may have in flight across every worker. */
  readonly projectConcurrency: number;
  /** Requests one mailbox may have in flight across every worker. */
  readonly mailboxConcurrency: number;
  /** Milliseconds after dispatch before the request's signal aborts. */
  readonly timeoutMs: number;
  /** Milliseconds a slot outlives its request's deadline, so a process that dies mid-request frees it. */
  readonly slotGraceMs: number;
  /**
   * Units each method consumes, by its name: at least one method, each name of the form `SourceQuotaMethod` gives. A
   * request for a method without a weight is refused.
   */
  readonly weights: Readonly<Record<SourceQuotaMethod, number>>;
}
/** One provider request attempt. Keys are opaque strings of 1 to 512 characters, never an address. */
export interface SourceQuotaRequest {
  /** The project whose budgets and slots every worker shares. */
  readonly projectKey: string;
  /** A stable key for the mailbox inside the project: a mailbox, or a workspace such as a Slack installation. */
  readonly mailboxKey: string;
  /** The method called, which sets the attempt's weight and, with a ceiling, its own minute budget. */
  readonly method: SourceQuotaMethod;
  /** Unique for one HTTP attempt. A network retry needs a new id. */
  readonly attemptId: string;
  /**
   * The objects the call asks for, such as a page's `limit`, a positive safe integer; a request for more than its
   * method's ceiling's `maxObjects` is refused.
   */
  readonly objects?: number;
}
/**
 * Why a request was deferred: a budget without room, its method's ceiling without room in its mailbox
 * (`method_minute`), a full concurrency limit or a recorded provider wait.
 */
export type SourceQuotaReason = 'project_minute' | 'mailbox_minute' | 'project_day' | 'method_minute'
  | 'project_concurrency' | 'mailbox_concurrency' | 'provider_wait';
/**
 * What `SourceQuota.run` answers: the transport's value; a deferral with the earliest time, in epoch milliseconds, to
 * try again, nothing sent; `late` when the call could not start within a second of the clock reading taken once its
 * three budgets hold its weight, after a slow commit, a long wait for the project's lock or a stalled process: nothing
 * was sent, so its units go back to the three budgets, and the attempt is retryable by a new `run` with a new attempt
 * id from `retryAt`, in epoch milliseconds, a second after the late start was found; or `duplicate` for an attempt id
 * seen before, which never sends.
 */
export type SourceQuotaResult<T> =
  | { readonly kind: 'completed'; readonly value: T }
  | { readonly kind: 'deferred'; readonly reason: SourceQuotaReason; readonly retryAt: number }
  | { readonly kind: 'late'; readonly retryAt: number }
  | { readonly kind: 'duplicate' };
/**
 * What one `SourceQuota.compact` call deleted. Each table gives up at most 1,000 rows a call: `more` is true when one
 * gave that many, so a further call may find more to delete, and false when every table gave fewer.
 */
export interface SourceQuotaCompaction {
  /** Attempt records deleted a day after their slots expired. */
  readonly attempts: number;
  /** Provider waits of a mailbox, and with ceilings of one method of a mailbox, deleted once passed. */
  readonly mailboxWaits: number;
  /** Reservations settled more than a day ago, deleted from the budgets' meters together, the methods' among them. */
  readonly reservations: number;
  /** The minute budgets' account rows idle for a day, the methods' among them, deleted together. */
  readonly windows: number;
  /** Whether a table gave a full page of 1,000 rows; a host calls `compact` again while it is true. */
  readonly more: boolean;
}
/** The quota's table prefix, policy, method ceilings and clock. */
export interface SourceQuotaOptions {
  /** Prefix of the quota tables, the one given to `sourceQuotaSchema`; `agentos_source_quota` unless given. */
  readonly tablePrefix?: string;
  /** The budgets and limits, the same in every worker. */
  readonly policy: SourceQuotaPolicy;
  /**
   * Ceilings by method, each for a method the policy weighs: a method's own rolling minute in each mailbox, held for
   * every mailbox of the quota alike, and the most objects one request may ask for. They belong to the quota, one a
   * connector, and are the same in every worker; the policy fingerprint every worker checks holds them. A quota with
   * ceilings also keeps a provider wait for one method of a mailbox (`defer` with `method`).
   */
  readonly ceilings?: Readonly<Record<SourceQuotaMethod, SourceQuotaCeiling>>;
  /** Tests may inject a clock; production uses the database clock across workers. */
  readonly clock?: (tx: StorageAdapter) => Promise<number>;
}
interface Permit { token: string; expiresAt: number; sendBy: number; timeoutMs: number }
interface ProjectRow { policy: string; retry_at: string | number }
class QuotaDeferred extends Error {
  constructor(readonly reason: SourceQuotaReason, readonly retryAt: number) { super('source_quota_deferred'); }
}
class QuotaDuplicate extends Error { constructor() { super('source_quota_duplicate'); } }
class QuotaLate extends Error { constructor(readonly retryAt: number) { super('source_quota_late'); } }
/**
 * Milliseconds within which an attempt must start its call, from the clock read once its three budgets hold its weight:
 * their statements run under the project's lock and can take longer than the window.
 */
const sendWindowMs = 1000;
/** The minute budgets' rolling window: a consumed unit leaves it once more than this has passed since its reservation. */
const minuteMs = 60_000;
/** Rows of each table one `compact` call deletes at most. */
const compactLimit = 1000;
const integer = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;
const key = (s: string): boolean => typeof s === 'string' && s.length > 0 && s.length <= 512;
const dayEnd = (now: number): number => (Math.floor(now / 86_400_000) + 1) * 86_400_000;
function tables(prefix = 'agentos_source_quota') {
  if (!/^[a-z][a-z0-9_]{0,27}$/.test(prefix)) throw new Error('invalid_source_quota_prefix');
  return { projects: `"${prefix}_projects"`, mailboxes: `"${prefix}_mailboxes"`,
    attempts: `"${prefix}_attempts"`, pm: `${prefix}_pm`, mm: `${prefix}_mm`, pd: `${prefix}_pd`,
    methods: `"${prefix}_methods"`, mt: `${prefix}_mt` };
}
/**
 * The quota tables' DDL under a prefix of a lower-case letter and at most 27 lower-case letters, digits or underscores
 * (`agentos_source_quota` unless given), as nine scripts for the host's migration to run with `exec`: the project,
 * mailbox and attempt tables, the attempts' index, a core spend meter's tables and indexes for each budget under
 * `<prefix>_pm`, `<prefix>_mm` and `<prefix>_pd`, then the methods' provider waits and the methods' minute budget under
 * `<prefix>_mt`, which a quota uses only with ceilings. Throws `invalid_source_quota_prefix` for another prefix.
 */
export function sourceQuotaSchema(prefix = 'agentos_source_quota'): readonly string[] {
  const t = tables(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.projects} (project_key TEXT PRIMARY KEY,policy TEXT NOT NULL,retry_at BIGINT NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS ${t.mailboxes} (project_key TEXT NOT NULL,mailbox_key TEXT NOT NULL,
      retry_at BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(project_key,mailbox_key))`,
    `CREATE TABLE IF NOT EXISTS ${t.attempts} (attempt_id TEXT PRIMARY KEY,project_key TEXT NOT NULL,
      mailbox_key TEXT NOT NULL,token TEXT NOT NULL,send_by BIGINT NOT NULL,expires_at BIGINT NOT NULL,
      started BOOLEAN NOT NULL DEFAULT FALSE,finished BOOLEAN NOT NULL DEFAULT FALSE)`,
    `CREATE INDEX IF NOT EXISTS "${prefix}_active" ON ${t.attempts}(project_key,finished,expires_at)`,
    spendMeterDdl(t.pm), spendMeterDdl(t.mm), spendMeterDdl(t.pd),
    `CREATE TABLE IF NOT EXISTS ${t.methods} (project_key TEXT NOT NULL,mailbox_key TEXT NOT NULL,method TEXT NOT NULL,
      retry_at BIGINT NOT NULL DEFAULT 0,PRIMARY KEY(project_key,mailbox_key,method))`,
    spendMeterDdl(t.mt),
  ];
}
const positiveInteger = (n: number): boolean => integer(n) && n > 0;
/**
 * A frozen copy of the policy in the order its fingerprint records it: Gmail's five methods first, in their first
 * release's order, then any other method by name, so a Gmail quota's fingerprint is the one every earlier release
 * recorded.
 */
function checkedPolicy(policy: SourceQuotaPolicy): SourceQuotaPolicy {
  const names = Object.keys(policy.weights);
  const ordered = [...gmailMethods.filter((name) => names.includes(name)),
    ...names.filter((name) => !gmailMethods.includes(name)).sort()];
  const weights = Object.freeze(Object.fromEntries(ordered.map((name): [string, number] => [name, policy.weights[name]!])));
  const copy = { projectMinute: policy.projectMinute, mailboxMinute: policy.mailboxMinute,
    projectDay: policy.projectDay, projectConcurrency: policy.projectConcurrency,
    mailboxConcurrency: policy.mailboxConcurrency, timeoutMs: policy.timeoutMs,
    slotGraceMs: policy.slotGraceMs, weights };
  const numbers = [copy.projectMinute, copy.mailboxMinute, copy.projectDay, copy.projectConcurrency,
    copy.mailboxConcurrency, copy.timeoutMs, copy.slotGraceMs, ...Object.values(weights)];
  if (ordered.length === 0 || !ordered.every((name) => methodName.test(name))
    || !numbers.every(positiveInteger) || copy.timeoutMs > 60_000
    || copy.slotGraceMs < copy.timeoutMs || copy.slotGraceMs > 120_000
    || copy.mailboxConcurrency > copy.projectConcurrency) throw new Error('invalid_source_quota_policy');
  return Object.freeze(copy);
}
/**
 * A frozen copy of the ceilings by method name, or null for none; each method must have a weight and each value be a
 * positive safe integer.
 */
function checkedCeilings(ceilings: SourceQuotaOptions['ceilings'],
  weights: Readonly<Record<string, number>>): Readonly<Record<string, SourceQuotaCeiling>> | null {
  if (ceilings === undefined) return null;
  const entries = Object.keys(ceilings).sort().map((name): [string, SourceQuotaCeiling] => {
    const ceiling = ceilings[name]!;
    if (!Object.hasOwn(weights, name) || !positiveInteger(ceiling.perMinute)
      || (ceiling.maxObjects !== undefined && !positiveInteger(ceiling.maxObjects))) {
      throw new Error('invalid_source_quota_policy');
    }
    return [name, Object.freeze({ perMinute: ceiling.perMinute,
      ...(ceiling.maxObjects === undefined ? {} : { maxObjects: ceiling.maxObjects }) })];
  });
  return Object.freeze(Object.fromEntries(entries));
}
/** One budget a request reserves its units in: its meter, table, allowance, account, reason and units. */
interface Budget {
  readonly meter: SqlSpendMeter;
  readonly table: string;
  readonly allowance: number;
  readonly accountId: string;
  readonly reason: SourceQuotaReason;
  readonly units: number;
}

/**
 * Combines released meters, which decide every admission and every refund; this class never reimplements their
 * accounting SQL. It reads a minute budget's reservations only to say when a request it refused has room.
 */
export class SourceQuota {
  private readonly t: ReturnType<typeof tables>;
  private readonly policy: SourceQuotaPolicy;
  private readonly ceilings: Readonly<Record<string, SourceQuotaCeiling>> | null;
  private readonly fingerprint: string;
  /**
   * Takes a PostgreSQL adapter with transactions and runs no DDL. Throws `source_quota_requires_postgres` for another
   * adapter, `invalid_source_quota_prefix` for a bad prefix and `invalid_source_quota_policy` for a bad policy or a
   * ceiling for a method without a weight or with a value that is not a positive safe integer.
   */
  constructor(private readonly db: StorageAdapter, private readonly options: SourceQuotaOptions) {
    if (db.kind !== 'postgres' || !db.capabilities.has('transactions')) throw new Error('source_quota_requires_postgres');
    this.t = tables(options.tablePrefix); this.policy = checkedPolicy(options.policy);
    this.ceilings = checkedCeilings(options.ceilings, this.policy.weights);
    // A quota without ceilings records the fingerprint every earlier release recorded for its policy.
    this.fingerprint = JSON.stringify(this.ceilings === null ? this.policy : { ...this.policy, ceilings: this.ceilings });
  }
  /**
   * The ceiling of a method, as the quota was built with it, for a connector that sizes its pages by `maxObjects`.
   *
   * @param method - The method's name.
   * @returns The ceiling, or null for a method without one.
   */
  ceilingOf(method: SourceQuotaMethod): SourceQuotaCeiling | null {
    return this.ceilings !== null && Object.hasOwn(this.ceilings, method) ? this.ceilings[method]! : null;
  }
  /**
   * The budgets a request's units go into, under the project's lock: the project's minute, the mailbox's minute and the
   * project's day, by the method's weight, and with a ceiling for the method one unit of the method's minute in the
   * mailbox.
   */
  private budgets(tx: StorageAdapter, request: SourceQuotaRequest): Budget[] {
    const projectId = JSON.stringify([request.projectKey]);
    const units = this.policy.weights[request.method]!;
    const budgets: Budget[] = [
      { meter: this.meter(tx, this.t.pm, this.policy.projectMinute, false), table: this.t.pm,
        allowance: this.policy.projectMinute, accountId: projectId, reason: 'project_minute', units },
      { meter: this.meter(tx, this.t.mm, this.policy.mailboxMinute, false), table: this.t.mm,
        allowance: this.policy.mailboxMinute, accountId: JSON.stringify([request.projectKey, request.mailboxKey]),
        reason: 'mailbox_minute', units },
      { meter: this.meter(tx, this.t.pd, this.policy.projectDay, true), table: this.t.pd,
        allowance: this.policy.projectDay, accountId: projectId, reason: 'project_day', units },
    ];
    const ceiling = this.ceilingOf(request.method);
    if (ceiling !== null) {
      budgets.push({ meter: this.meter(tx, this.t.mt, ceiling.perMinute, false), table: this.t.mt,
        allowance: ceiling.perMinute, accountId: JSON.stringify([request.projectKey, request.mailboxKey, request.method]),
        reason: 'method_minute', units: 1 });
    }
    return budgets;
  }
  /**
   * The latest provider wait that holds a request: the project's, the mailbox's and, for a quota with ceilings, the
   * method's in the mailbox.
   */
  private async waitOf(tx: StorageAdapter, request: SourceQuotaRequest, project: ProjectRow): Promise<number> {
    const mailbox = await tx.get<{ retry_at: string | number }>(`SELECT retry_at FROM ${this.t.mailboxes}
      WHERE project_key=$1 AND mailbox_key=$2`, [request.projectKey, request.mailboxKey]);
    const method = this.ceilings === null ? null : await tx.get<{ retry_at: string | number }>(`SELECT retry_at
      FROM ${this.t.methods} WHERE project_key=$1 AND mailbox_key=$2 AND method=$3`,
      [request.projectKey, request.mailboxKey, request.method]);
    return Math.max(Number(project.retry_at), Number(mailbox?.retry_at ?? 0), Number(method?.retry_at ?? 0));
  }
  private async now(tx: StorageAdapter): Promise<number> {
    const n = this.options.clock ? await this.options.clock(tx)
      : Number((await tx.get<{ now: string | number }>(
        'SELECT floor(extract(epoch from clock_timestamp()) * 1000)::bigint AS now'))?.now);
    if (!integer(n) || n > 8_639_999_913_600_000) throw new Error('invalid_source_quota_clock');
    return n;
  }
  private async project(tx: StorageAdapter, projectKey: string): Promise<ProjectRow> {
    if (!key(projectKey)) throw new Error('invalid_source_quota_key');
    await tx.run(`INSERT INTO ${this.t.projects}(project_key,policy) VALUES($1,$2) ON CONFLICT DO NOTHING`,
      [projectKey, this.fingerprint]);
    const row = await tx.get<ProjectRow>(`SELECT policy,retry_at FROM ${this.t.projects} WHERE project_key=$1 FOR UPDATE`, [projectKey]);
    if (!row || row.policy !== this.fingerprint) throw new Error('source_quota_policy_mismatch');
    return row;
  }
  private meter(tx: StorageAdapter, prefix: string, allowance: number, daily: boolean): SqlSpendMeter {
    return new SqlSpendMeter({ db: tx, tablePrefix: prefix, allowanceFor: () => allowance,
      ...(daily ? { periodOf: (now: number) => String(Math.floor(now / 86_400_000)) } : { windowMs: minuteMs }),
      ensureSchema: false, requireShared: true, leaseMs: 120_000, maxAttemptsPerOperation: 1,
      unknownAfterLease: 'consume', retry: { attempts: 1, baseDelayMs: 0, maxDelayMs: 0, deadlineMs: 1000 } });
  }
  private async reserve(request: SourceQuotaRequest): Promise<Permit> {
    const ceiling = typeof request.method === 'string' ? this.ceilingOf(request.method) : null;
    if (![request.projectKey, request.mailboxKey, request.attemptId].every(key)
      || typeof request.method !== 'string' || !Object.hasOwn(this.policy.weights, request.method)
      || (request.objects !== undefined && (!positiveInteger(request.objects)
        || (ceiling?.maxObjects !== undefined && request.objects > ceiling.maxObjects)))) {
      throw new SourceSyncFault('invalid_response');
    }
    return this.db.transaction(async (tx) => {
      const project = await this.project(tx, request.projectKey); const now = await this.now(tx);
      if (await tx.get(`SELECT attempt_id FROM ${this.t.attempts} WHERE attempt_id=$1`, [request.attemptId])) throw new QuotaDuplicate();
      const retryAt = await this.waitOf(tx, request, project);
      if (retryAt > now) throw new QuotaDeferred('provider_wait', retryAt);
      const slots = await tx.all<{ mailbox_key: string; expires_at: string | number }>(
        `SELECT mailbox_key,expires_at FROM ${this.t.attempts} WHERE project_key=$1 AND finished=FALSE AND expires_at>$2`,
        [request.projectKey, now]);
      const local = slots.filter((s) => s.mailbox_key === request.mailboxKey);
      if (local.length >= this.policy.mailboxConcurrency) {
        throw new QuotaDeferred('mailbox_concurrency', Math.min(...local.map((s) => Number(s.expires_at))));
      }
      if (slots.length >= this.policy.projectConcurrency) {
        throw new QuotaDeferred('project_concurrency', Math.min(...slots.map((s) => Number(s.expires_at))));
      }
      for (const entry of this.budgets(tx, request)) {
        const reserved = await entry.meter.reserve({ accountId: entry.accountId,
          operationId: request.attemptId, units: entry.units, now });
        if (reserved.status !== 'reserved') {
          if (reserved.reason !== 'allowance_exhausted') throw new QuotaDuplicate();
          // Propagate past the outer transaction: nested adapter calls have no savepoint.
          throw new QuotaDeferred(entry.reason, entry.reason === 'project_day' ? dayEnd(now)
            : await this.minuteRoom(tx, entry.table, entry.accountId, request.attemptId, entry.units, entry.allowance, now));
        }
        const settled = await entry.meter.settle({ operationId: request.attemptId, outcome: 'consumed', now });
        if (settled.status !== 'settled' || settled.state !== 'consumed') throw new Error('source_quota_settle_failed');
      }
      // The send window opens once the three budgets hold the weight, at a second reading of the clock: one counted from
      // the first reading would close while their statements were still running on a slow database. The record below
      // and the commit stay inside the window: no reading can follow a commit inside its own transaction, and the start's
      // reading, which closes the window, is the one that catches a process that stalled after the commit.
      const opened = Math.max(now, await this.now(tx));
      const permit: Permit = { token: randomUUID(), sendBy: opened + sendWindowMs,
        expiresAt: opened + sendWindowMs + this.policy.timeoutMs + this.policy.slotGraceMs, timeoutMs: this.policy.timeoutMs };
      await tx.run(`INSERT INTO ${this.t.attempts}(attempt_id,project_key,mailbox_key,token,send_by,expires_at)
        VALUES($1,$2,$3,$4,$5,$6)`, [request.attemptId, request.projectKey, request.mailboxKey,
          permit.token, permit.sendBy, permit.expiresAt]);
      return permit;
    });
  }
  private async begin(request: SourceQuotaRequest, permit: Permit): Promise<void> {
    const late = await this.db.transaction(async (tx): Promise<number | null> => {
      const project = await this.project(tx, request.projectKey); const now = await this.now(tx);
      const wait = await this.waitOf(tx, request, project);
      if (wait > now) throw new QuotaDeferred('provider_wait', wait);
      const updated = await tx.run(`UPDATE ${this.t.attempts} SET started=TRUE
        WHERE attempt_id=$1 AND project_key=$2 AND mailbox_key=$3 AND token=$4
        AND started=FALSE AND finished=FALSE AND send_by>=$5 AND expires_at>$5`,
        [request.attemptId, request.projectKey, request.mailboxKey, permit.token, now]);
      if (updated.changes === 1) return null;
      // This run's own attempt, still unstarted, missed only the time conditions: its send window closed before the start.
      const unstarted = await tx.get(`SELECT attempt_id FROM ${this.t.attempts}
        WHERE attempt_id=$1 AND project_key=$2 AND mailbox_key=$3 AND token=$4 AND started=FALSE AND finished=FALSE`,
        [request.attemptId, request.projectKey, request.mailboxKey, permit.token]);
      if (!unstarted) throw new QuotaDuplicate();
      // Nothing was sent and only this run holds the attempt's token, so the budgets take its units back here, the
      // method's with them, under the project's lock, through the core meters' own refund of a consumed reservation
      // (`replaced`).
      for (const { meter } of this.budgets(tx, request)) {
        const refunded = await meter.settle({ operationId: request.attemptId, outcome: 'replaced', now });
        if (refunded.status !== 'settled' || refunded.state !== 'released') throw new Error('source_quota_refund_failed');
      }
      return now + sendWindowMs;
    });
    if (late !== null) throw new QuotaLate(late);
  }
  /**
   * When a minute budget that refused `units` has room for them: a minute and a millisecond after the reservation of the
   * consumed units whose leaving the window, the earliest first, frees enough, read from the core meter's reservations
   * without the refused attempt's own. Units still reserved never leave the window by age, so with them in the way, or
   * for more units than the budget holds, it answers a minute and a millisecond from now.
   */
  private async minuteRoom(tx: StorageAdapter, table: string, accountId: string, attemptId: string,
    units: number, allowance: number, now: number): Promise<number> {
    const held = await tx.all<{ state: string; reserved_at: string | number; units: string | number }>(
      `SELECT state,reserved_at,units FROM ${table}_reservations WHERE account_id=$1 AND period='window'
        AND operation_id<>$2 AND (state='reserved' OR (state='consumed' AND reserved_at>=$3)) ORDER BY reserved_at`,
      [accountId, attemptId, now - minuteMs]);
    let left = held.reduce((sum, row) => sum + Number(row.units), 0);
    for (const row of held) {
      if (row.state !== 'consumed') continue;
      left -= Number(row.units);
      if (left + units <= allowance) return Number(row.reserved_at) + minuteMs + 1;
    }
    return now + minuteMs + 1;
  }
  private async release(request: SourceQuotaRequest, permit: Permit): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.project(tx, request.projectKey);
      await tx.run(`UPDATE ${this.t.attempts} SET finished=TRUE WHERE attempt_id=$1 AND token=$2
        AND project_key=$3 AND mailbox_key=$4`, [request.attemptId, permit.token, request.projectKey, request.mailboxKey]);
    });
  }
  /**
   * Consume weighted capacity and call the transport once. No inline HTTP retries: a retry, after a deferral or a
   * `late` answer among others, is a new `run` with a new attempt id. A failure to release the attempt's slot behind
   * what `send` threw never replaces it; behind a completed call it is `storage_unavailable`.
   */
  async run<T>(request: SourceQuotaRequest, send: (signal: AbortSignal) => Promise<T>,
    parent?: AbortSignal): Promise<SourceQuotaResult<T>> {
    if (parent?.aborted) throw new SourceSyncFault('cancelled');
    let permit: Permit;
    try { permit = await this.reserve(request); }
    catch (error) {
      if (error instanceof QuotaDeferred) return { kind: 'deferred', reason: error.reason, retryAt: error.retryAt };
      if (error instanceof QuotaDuplicate) return { kind: 'duplicate' };
      if (error instanceof SourceSyncFault) throw error;
      throw new SourceSyncFault('storage_unavailable');
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    parent?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let began = false; let failed = false;
    try {
      try { await this.begin(request, permit); began = true; }
      catch (error) {
        if (error instanceof QuotaDeferred) return { kind: 'deferred', reason: error.reason, retryAt: error.retryAt };
        if (error instanceof QuotaLate) return { kind: 'late', retryAt: error.retryAt };
        if (error instanceof QuotaDuplicate) return { kind: 'duplicate' };
        throw new SourceSyncFault('storage_unavailable');
      }
      if (parent?.aborted) throw new SourceSyncFault('cancelled');
      timer = setTimeout(abort, permit.timeoutMs);
      // The callback must consume or cancel its body before resolving and honor abort.
      const value = await send(controller.signal);
      if (controller.signal.aborted) throw new SourceSyncFault(parent?.aborted ? 'cancelled' : 'network');
      return { kind: 'completed', value };
    } catch (error) {
      failed = true; throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
      // Request units remain consumed even if begin, transport, parsing or cleanup fails. A release that fails behind
      // what `send` threw never replaces it: a refused grant has to reach the coordinator as `grant_rejected`, which
      // fences the grant, not as `storage_unavailable`, which only schedules a retry. Behind a completed call it is
      // still a storage failure, and the slot frees at its expiry either way.
      try { await this.release(request, permit); }
      catch { if (began && !failed) throw new SourceSyncFault('storage_unavailable'); }
    }
  }
  /**
   * Records a provider's wait until `retryAt` for the whole project, one mailbox, or, for a quota with ceilings, one
   * method of one mailbox, as Slack's `Retry-After` holds one method of one workspace. A longer provider wait survives
   * restarts, generation changes and shorter updates.
   *
   * @throws {SourceSyncFault} `invalid_response` for a key outside its bounds, a time that is not a nonnegative safe
   *   integer or past the latest date, or a `method` without a `mailboxKey`, without a weight, or on a quota without
   *   ceilings; `storage_unavailable` when the store cannot answer.
   */
  async defer(scope: { readonly projectKey: string; readonly mailboxKey?: string; readonly method?: SourceQuotaMethod },
    retryAt: number): Promise<void> {
    if (!key(scope.projectKey) || (scope.mailboxKey !== undefined && !key(scope.mailboxKey))
      || !integer(retryAt) || retryAt > 8_639_999_913_600_000
      || (scope.method !== undefined && (scope.mailboxKey === undefined || this.ceilings === null
        || typeof scope.method !== 'string' || !Object.hasOwn(this.policy.weights, scope.method)))) {
      throw new SourceSyncFault('invalid_response');
    }
    try {
      await this.db.transaction(async (tx) => {
        await this.project(tx, scope.projectKey);
        if (scope.method !== undefined) {
          await tx.run(`INSERT INTO ${this.t.methods}(project_key,mailbox_key,method,retry_at) VALUES($1,$2,$3,$4)
            ON CONFLICT(project_key,mailbox_key,method) DO UPDATE SET retry_at=GREATEST(${this.t.methods}.retry_at,excluded.retry_at)`,
            [scope.projectKey, scope.mailboxKey, scope.method, retryAt]);
        } else if (scope.mailboxKey === undefined) {
          await tx.run(`UPDATE ${this.t.projects} SET retry_at=GREATEST(retry_at,$2) WHERE project_key=$1`, [scope.projectKey, retryAt]);
        } else {
          await tx.run(`INSERT INTO ${this.t.mailboxes}(project_key,mailbox_key,retry_at) VALUES($1,$2,$3)
            ON CONFLICT(project_key,mailbox_key) DO UPDATE SET retry_at=GREATEST(${this.t.mailboxes}.retry_at,excluded.retry_at)`,
            [scope.projectKey, scope.mailboxKey, retryAt]);
        }
      });
    } catch { throw new SourceSyncFault('storage_unavailable'); }
  }
  /**
   * Remove expired attempt evidence after 24 hours and safely old meter records, at most 1,000 rows of each table a
   * call; with ceilings, the methods' passed waits and their minute budget's old records too. Daily totals remain.
   * Answers what it removed; while `more` is true, a further call may remove more.
   */
  async compact(): Promise<SourceQuotaCompaction> {
    try {
      return await this.db.transaction(async (tx) => {
        const now = await this.now(tx); const before = Math.max(0, now - 86_400_000);
        const attempts = (await tx.run(`DELETE FROM ${this.t.attempts} WHERE attempt_id IN (SELECT attempt_id FROM ${this.t.attempts} WHERE expires_at < $1 ORDER BY expires_at LIMIT ${compactLimit}) AND expires_at < $1`, [before])).changes;
        let mailboxWaits = (await tx.run(`DELETE FROM ${this.t.mailboxes} WHERE (project_key,mailbox_key) IN (SELECT project_key,mailbox_key FROM ${this.t.mailboxes} WHERE retry_at <= $1 LIMIT ${compactLimit}) AND retry_at <= $1`, [now])).changes;
        const pages = [attempts, mailboxWaits]; let reservations = 0; let windows = 0;
        const meters = [this.meter(tx, this.t.pm, this.policy.projectMinute, false),
          this.meter(tx, this.t.mm, this.policy.mailboxMinute, false), this.meter(tx, this.t.pd, this.policy.projectDay, true)];
        if (this.ceilings !== null) {
          // The methods' tables are a quota with ceilings' alone: a database migrated before them has none to compact.
          const methodWaits = (await tx.run(`DELETE FROM ${this.t.methods} WHERE (project_key,mailbox_key,method) IN (SELECT project_key,mailbox_key,method FROM ${this.t.methods} WHERE retry_at <= $1 LIMIT ${compactLimit}) AND retry_at <= $1`, [now])).changes;
          mailboxWaits += methodWaits; pages.push(methodWaits);
          meters.push(this.meter(tx, this.t.mt, 1, false));
        }
        for (const meter of meters) {
          // A meter answers its settled reservations and its window rows deleted, each its own page of the limit.
          const purged = await meter.purge({ before, limit: compactLimit });
          reservations += purged.reservations; windows += purged.periods; pages.push(purged.reservations, purged.periods);
        }
        return { attempts, mailboxWaits, reservations, windows, more: pages.some((n) => n >= compactLimit) };
      });
    } catch { throw new SourceSyncFault('storage_unavailable'); }
  }
}

/** Retry-After is never clamped down to the local exponential-backoff ceiling. */
export function sourceRetryAt(now: number, attempt: number, retryAfter: string | null, random = Math.random()): number {
  if (!integer(now) || !Number.isInteger(attempt) || attempt < 1 || attempt > 5
    || !Number.isFinite(random) || random < 0 || random > 1) throw new SourceSyncFault('invalid_response');
  const base = Math.min(60_000, 1000 * 2 ** (attempt - 1));
  let at = now + Math.min(60_000, Math.floor(base * (1 + random)));
  if (retryAfter !== null) {
    const value = retryAfter.trim();
    if (/^\d+$/.test(value)) {
      const seconds = Number(value);
      if (!integer(seconds) || !integer(now + seconds * 1000)) throw new SourceSyncFault('invalid_response');
      at = Math.max(at, now + seconds * 1000);
    } else {
      const parsed = Date.parse(value);
      if (integer(parsed) && new Date(parsed).toUTCString() === value) at = Math.max(at, parsed);
    }
  }
  if (!integer(at) || at > 8_639_999_913_600_000) throw new SourceSyncFault('invalid_response');
  return at;
}
