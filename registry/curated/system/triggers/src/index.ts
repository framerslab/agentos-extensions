/**
 * @fileoverview The package's root entry: the contract's types, `createScheduler`,
 * `createSchedulerForTests`, `createWatcher`, `migrateTriggers`, `scheduleWords` and
 * `computeNextRunAtMs`.
 */
import type { Scheduler, TriggersOptions, Watcher } from './contract.js';
import { createScheduler as createSchedulerInternal, type SchedulerInternals } from './scheduler.js';
import { createWatcher as createWatcherInternal, type WatcherOptions } from './watcher.js';

export type * from './contract.js';
export type { SchedulerInternals } from './scheduler.js';
export type { WatcherOptions } from './watcher.js';
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
 * run it claimed has called its body) and `settled()` (once every run in flight has settled, and every write a
 * `report()` began) on its own clock.
 */
export const createSchedulerForTests: (options: TriggersOptions) => SchedulerInternals = (options) => createSchedulerInternal(options, { arm: false });

/**
 * The stall watcher, for a process that runs no jobs: `start()` passes at once and then every `everyMs` (a minute by
 * default) under the watch lease, telling the host's handlers of a stall, its recovery and a job that stays failed, each
 * handler call given up as a throw after `handlerTimeoutMs` (30 seconds by default);
 * `stop()` clears the interval and waits for a pass in progress.
 */
export const createWatcher: (options: WatcherOptions) => Watcher = (options) => createWatcherInternal(options);
