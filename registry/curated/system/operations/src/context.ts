/**
 * @fileoverview What `createOperations` builds once and every surface shares: the checked
 * options, the limits, the clock, the field gate, the four bounded queues and the flushers
 * `stop()` runs. The checks: a logger with `info`, `warn` and `error`, three distinct lock
 * integers, a non-empty `fields` rule, 2 to 12 category words.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsLimits, OpsLogger, OpsOptions } from './contract.js';
import { createFieldGate, requireFieldRules, type FieldGate } from './fields.js';
import { resolveLimits } from './limits.js';
import { BoundedQueue } from './queue.js';
import { DEFAULT_PREFIX, requirePrefix, tableName, type OpsTableName } from './store/prefix.js';

/** A queued log line: the row `ops_log_lines` takes. */
export interface OpsQueuedLine {
  readonly id: string;
  readonly at: number;
  readonly process: string;
  readonly kind: string;
  readonly status: number | null;
  readonly path: string | null;
  readonly fields: Readonly<Record<string, string | number>>;
}

/** A queued event: the row `ops_events` takes, `at` cut to the hour. */
export interface OpsQueuedEvent {
  readonly id: string;
  readonly at: number;
  readonly kind: string;
  readonly plan: string | null;
  readonly n: number;
  readonly fields: Readonly<Record<string, string | number>>;
}

/** A queued beat: the row `ops_beats` takes. */
export interface OpsQueuedBeat {
  readonly job: string;
  readonly at: number;
  readonly outcome: 'ok' | 'failed' | 'skipped';
}

export interface OpsQueues {
  readonly captures: BoundedQueue<unknown>;
  readonly lines: BoundedQueue<OpsQueuedLine>;
  readonly events: BoundedQueue<OpsQueuedEvent>;
  readonly beats: BoundedQueue<OpsQueuedBeat>;
}

export interface OpsContext {
  readonly db: StorageAdapter;
  readonly prefix: string;
  readonly options: OpsOptions;
  readonly limits: OpsLimits;
  readonly logger: OpsLogger;
  readonly now: () => number;
  readonly fields: FieldGate;
  readonly queues: OpsQueues;
  /** What `stop()` runs, within its deadline: each surface registers the flush of its queue. */
  readonly flushers: Set<() => Promise<void>>;
  /** `<prefix>_<name>`. */
  table(name: OpsTableName): string;
  /** Set by `start()`: whether this process runs the shared jobs. */
  shared: boolean;
  started: boolean;
  stopped: boolean;
}

/** A word the package accepts for a process, a category or a plan: a letter, then at most 31 letters, digits, underscores or hyphens. */
const WORD = /^[a-z][a-z0-9_-]{0,31}$/;

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === 'function';

function requireLogger(logger: unknown): OpsLogger {
  const candidate = logger as Partial<OpsLogger> | null | undefined;
  if (!candidate || !isFunction(candidate.info) || !isFunction(candidate.warn) || !isFunction(candidate.error)) {
    throw new TypeError('createOperations: logger must have info, warn and error functions');
  }
  return candidate as OpsLogger;
}

function requireDb(db: unknown): StorageAdapter {
  const candidate = db as Partial<StorageAdapter> | null | undefined;
  if (
    !candidate ||
    typeof candidate.kind !== 'string' ||
    !isFunction(candidate.run) ||
    !isFunction(candidate.get) ||
    !isFunction(candidate.all) ||
    !isFunction(candidate.exec) ||
    !isFunction(candidate.transaction)
  ) {
    throw new TypeError('createOperations: db must be a storage adapter with run, get, all, exec and transaction');
  }
  return candidate as StorageAdapter;
}

function requireLocks(locks: unknown): readonly [number, number, number] {
  if (!Array.isArray(locks) || locks.length !== 3 || !locks.every((lock) => Number.isSafeInteger(lock))) {
    throw new TypeError('createOperations: locks must be three safe integers, the tick, the sweep and the totals');
  }
  if (new Set(locks).size !== 3) throw new TypeError('createOperations: locks must be three distinct integers');
  return locks as unknown as readonly [number, number, number];
}

function requireWord(name: string, value: unknown): string {
  if (typeof value !== 'string' || !WORD.test(value)) {
    throw new TypeError(`createOperations: ${name} must be a word (a letter, then letters, digits, underscores or hyphens)`);
  }
  return value;
}

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new TypeError(`createOperations: ${name} must be a string of 1 to 256 characters`);
  }
  return value;
}

function requireCategories(categories: unknown): void {
  if (!Array.isArray(categories) || categories.length < 2 || categories.length > 12) {
    throw new TypeError('createOperations: tickets.categories must list 2 to 12 words');
  }
  for (const category of categories) requireWord('tickets.categories', category);
  if (new Set(categories).size !== categories.length) {
    throw new TypeError('createOperations: tickets.categories must not repeat a word');
  }
}

/** Checks the options (Behaviour 7) and builds the shared context. */
export function createContext(options: OpsOptions): OpsContext {
  if (typeof options !== 'object' || options === null) throw new TypeError('createOperations: options must be an object');
  const db = requireDb(options.db);
  const logger = requireLogger(options.logger);
  const prefix = requirePrefix(options.prefix ?? DEFAULT_PREFIX);
  requireText('release', options.release);
  requireWord('process', options.process);
  requireLocks(options.locks);
  requireText('alertsTo', options.alertsTo);
  if (!isFunction(options.mail)) throw new TypeError('createOperations: mail must be a function');
  if (!isFunction(options.routePattern)) throw new TypeError('createOperations: routePattern must be a function');
  if (options.describe !== undefined && !isFunction(options.describe)) {
    throw new TypeError('createOperations: describe must be a function when given');
  }
  if (options.now !== undefined && !isFunction(options.now)) throw new TypeError('createOperations: now must be a function when given');
  const rule = requireFieldRules(options.fields);
  if (options.tickets !== undefined) {
    const tickets = options.tickets;
    if (typeof tickets !== 'object' || tickets === null) throw new TypeError('createOperations: tickets must be an object when given');
    requireCategories(tickets.categories);
    for (const hook of ['identity', 'audit', 'staffRecipients', 'excluded'] as const) {
      if (!isFunction(tickets[hook])) throw new TypeError(`createOperations: tickets.${hook} must be a function`);
    }
    if (tickets.notify !== undefined && !isFunction(tickets.notify)) {
      throw new TypeError('createOperations: tickets.notify must be a function when given');
    }
    if (typeof tickets.words !== 'object' || tickets.words === null) throw new TypeError('createOperations: tickets.words must be given');
    if (!Array.isArray(tickets.tokenPaths)) throw new TypeError('createOperations: tickets.tokenPaths must be a list');
  }
  if (options.metrics !== undefined) {
    const metrics = options.metrics;
    if (typeof metrics !== 'object' || metrics === null) throw new TypeError('createOperations: metrics must be an object when given');
    if (!Array.isArray(metrics.plans) || metrics.plans.length === 0) throw new TypeError('createOperations: metrics.plans must list the plan words');
    for (const plan of metrics.plans) requireWord('metrics.plans', plan);
    if (typeof metrics.metrics !== 'object' || metrics.metrics === null) throw new TypeError('createOperations: metrics.metrics must be an object');
    if (!isFunction(metrics.excluded)) throw new TypeError('createOperations: metrics.excluded must be a function');
  }
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;

  return {
    db,
    prefix,
    options,
    limits,
    logger,
    now,
    fields: createFieldGate(rule, logger, now, (pathname) => options.routePattern(pathname)),
    queues: {
      captures: new BoundedQueue<unknown>('captures', limits.captureQueue),
      lines: new BoundedQueue<OpsQueuedLine>('lines', limits.lineQueue),
      events: new BoundedQueue<OpsQueuedEvent>('events', limits.eventQueue),
      beats: new BoundedQueue<OpsQueuedBeat>('beats', limits.beatQueue),
    },
    flushers: new Set(),
    table: (name) => tableName(prefix, name),
    shared: false,
    started: false,
    stopped: false,
  };
}
