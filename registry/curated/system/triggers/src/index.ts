/**
 * @fileoverview The package's root entry: the contract's types, `createScheduler`,
 * `createSchedulerForTests`, `migrateTriggers`, `scheduleWords` and `computeNextRunAtMs`. The
 * stall watcher is added by the next release of this entry.
 */
import type { Scheduler, TriggersOptions } from './contract.js';
import { createScheduler as createSchedulerInternal, type SchedulerInternals } from './scheduler.js';

export type * from './contract.js';
export type { SchedulerInternals } from './scheduler.js';
export { migrateTriggers } from './store/migrations.js';
export { scheduleWords } from './words.js';
export { computeNextRunAtMs } from './cron.js';

/**
 * The scheduler of record over `options.db`: the process that runs jobs registers them and calls `start()`, which
 * restores every job and arms the tick; a process that only reads and commands builds one and never starts it.
 */
export const createScheduler: (options: TriggersOptions) => Scheduler = (options) => createSchedulerInternal(options);

/**
 * The same scheduler for a host's tests: no interval is armed, and the test drives `tick()` (which resolves once each
 * run it claimed has called its body) and `settled()` (once every run in flight has settled) on its own clock.
 */
export const createSchedulerForTests: (options: TriggersOptions) => SchedulerInternals = (options) => createSchedulerInternal(options, { arm: false });
