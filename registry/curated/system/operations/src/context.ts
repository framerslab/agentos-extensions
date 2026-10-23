/**
 * @fileoverview What `createOperations` builds once and every surface shares: the checked
 * options, the limits, the clock, the field gate with the timer that writes its held `ops_refused`
 * lines, the four bounded queues and the flushers `stop()` runs. The checks: a logger with `info`,
 * `warn` and `error`, three distinct lock integers, a non-empty `fields` rule, 2 to 12 category
 * words.
 */
import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { OpsLimits, OpsLogger, OpsOptions } from './contract.js';
import { createFieldGate, requireFieldRules, type FieldGate } from './fields.js';
import { resolveLimits } from './limits.js';
import { isOwnMetricName } from './events/own.js';
import { BoundedQueue } from './queue.js';
import { dialectOf } from './store/migrations.js';
import { DEFAULT_PREFIX, requireDialectPrefix, requirePrefix, tableName, type OpsTableName } from './store/prefix.js';

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

/** The four bounded queues of one `Operations`, one a kind: captures, lines, events and beats. */
export interface OpsQueues {
  readonly captures: BoundedQueue<unknown>;
  readonly lines: BoundedQueue<OpsQueuedLine>;
  readonly events: BoundedQueue<OpsQueuedEvent>;
  readonly beats: BoundedQueue<OpsQueuedBeat>;
}

/** A timed job a surface runs between `start()` and `stop()`: a queue's flush cadence, and the jobs once they exist. */
export interface OpsTimer {
  start(): void;
  stop(): void;
}

/**
 * What every surface of one `Operations` shares: the checked options, the limits, the logger, the
 * clock, the field gate, the queues, the flushers `stop()` runs and the timers `start()` starts.
 */
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
  /** What `start()` starts and `stop()` ends: the timed flushes, and the jobs once they exist. */
  readonly timers: Set<OpsTimer>;
  /** `<prefix>_<name>`. */
  table(name: OpsTableName): string;
  /** Set by the first `start({ shared: true })` and kept: whether this process runs the shared jobs. */
  shared: boolean;
  started: boolean;
  stopped: boolean;
}

/** A word the package accepts for a process, a category, a plan, an event's kind or a metric's name: a letter, then at most 31 letters, digits, underscores or hyphens. */
export const WORD = /^[a-z][a-z0-9_-]{0,31}$/;

/** Whether `value` is a word under `WORD`. */
export const isWord = (value: unknown): value is string => typeof value === 'string' && WORD.test(value);

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

/** How often a started process writes the field gate's held `ops_refused` lines of a minute that has ended (D40). */
export const REFUSED_EVERY_MS = 5_000;

/**
 * The timer that writes the field gate's held `ops_refused` lines once their minute has ended, so
 * a refusal with no later one to carry it is logged within seconds of its minute's end, never only
 * at `stop()` (D40). Started by `start()`, ended by `stop()`; nothing here throws.
 */
function refusedTimer(gate: FieldGate): OpsTimer {
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => {
        try {
          gate.drain(false);
        } catch {
          // The host's clock failed: the next turn tries again.
        }
      }, REFUSED_EVERY_MS);
      timer.unref?.();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
}

/** Checks the options (Behaviour 7) and builds the shared context. */
export function createContext(options: OpsOptions): OpsContext {
  if (typeof options !== 'object' || options === null) throw new TypeError('createOperations: options must be an object');
  const db = requireDb(options.db);
  const logger = requireLogger(options.logger);
  const prefix = requireDialectPrefix(requirePrefix(options.prefix ?? DEFAULT_PREFIX), dialectOf(db));
  requireText('release', options.release);
  requireWord('process', options.process);
  requireLocks(options.locks);
  requireText('alertsTo', options.alertsTo);
  if (!isFunction(options.mail)) throw new TypeError('createOperations: mail must be a function');
  if (!isFunction(options.routePattern)) throw new TypeError('createOperations: routePattern must be a function');
  if (options.describe !== undefined && !isFunction(options.describe)) {
    throw new TypeError('createOperations: describe must be a function when given');
  }
  if (options.audit !== undefined && !isFunction(options.audit)) throw new TypeError('createOperations: audit must be a function when given');
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
    if (metrics.plans.includes('all')) {
      throw new TypeError('createOperations: metrics.plans must not hold all, the word the totals give the sum over the plans');
    }
    if (typeof metrics.metrics !== 'object' || metrics.metrics === null) throw new TypeError('createOperations: metrics.metrics must be an object');
    for (const [name, entry] of Object.entries(metrics.metrics)) {
      if (!WORD.test(name)) throw new TypeError('createOperations: metrics.metrics has a name that is not a word');
      if (isOwnMetricName(name)) throw new TypeError(`createOperations: metrics.metrics.${name} is one of the package's own metrics`);
      const candidate: unknown = entry;
      if (isFunction(candidate)) continue;
      if (typeof candidate !== 'object' || candidate === null || !isFunction((candidate as { count?: unknown }).count)) {
        throw new TypeError(`createOperations: metrics.metrics.${name} must be a function or an entry with a count function`);
      }
      const marks = candidate as { losesDeleted?: unknown; fillsBack?: unknown; source?: unknown };
      if (marks.losesDeleted !== undefined && marks.losesDeleted !== true) {
        throw new TypeError(`createOperations: metrics.metrics.${name}.losesDeleted must be true when given`);
      }
      if (marks.fillsBack !== undefined && marks.fillsBack !== false) {
        throw new TypeError(`createOperations: metrics.metrics.${name}.fillsBack must be false when given`);
      }
      if (marks.source !== undefined && (typeof marks.source !== 'string' || marks.source.length === 0 || marks.source.length > 256)) {
        throw new TypeError(`createOperations: metrics.metrics.${name}.source must be a string of 1 to 256 characters when given`);
      }
    }
    if (metrics.funnel !== undefined) {
      if (!Array.isArray(metrics.funnel) || metrics.funnel.length !== 4) throw new TypeError('createOperations: metrics.funnel must name four metrics');
      for (const step of metrics.funnel) {
        requireWord('metrics.funnel', step);
        if (!Object.prototype.hasOwnProperty.call(metrics.metrics, step) && !isOwnMetricName(step)) {
          throw new TypeError(`createOperations: metrics.funnel names ${step}, which is no metric of the host's or the package's`);
        }
      }
    }
    if (metrics.retention !== undefined && !isFunction(metrics.retention)) {
      throw new TypeError('createOperations: metrics.retention must be a function when given');
    }
    if (!isFunction(metrics.excluded)) throw new TypeError('createOperations: metrics.excluded must be a function');
  }
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const fields = createFieldGate(rule, logger, now, (pathname) => options.routePattern(pathname));

  return {
    db,
    prefix,
    options,
    limits,
    logger,
    now,
    fields,
    queues: {
      captures: new BoundedQueue<unknown>('captures', limits.captureQueue),
      lines: new BoundedQueue<OpsQueuedLine>('lines', limits.lineQueue),
      events: new BoundedQueue<OpsQueuedEvent>('events', limits.eventQueue),
      beats: new BoundedQueue<OpsQueuedBeat>('beats', limits.beatQueue),
    },
    flushers: new Set(),
    timers: new Set<OpsTimer>([refusedTimer(fields)]),
    table: (name) => tableName(prefix, name),
    shared: false,
    started: false,
    stopped: false,
  };
}
