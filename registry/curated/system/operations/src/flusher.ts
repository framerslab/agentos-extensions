/**
 * @fileoverview The flush cadence of a queue (D30, D47). A `QueueFlusher` drains its bounded queue
 * through `flushQueue`, a batch of 500 statements at a time: at once when the queue reaches 500,
 * every 5 seconds once `start()` has run, and at `stop()` through the context's flushers. A batch
 * that fails whole (the database away) goes back to the front of the queue for the next flush, the
 * bound holding by dropping the oldest. Two flushes never run at the same time on one queue; a
 * call made while one is in flight waits for it and runs once more, so what came in meanwhile goes
 * too. Nothing in the push path awaits, and nothing here throws.
 */
import type { BatchOperation } from '@framers/sql-storage-adapter';
import type { OpsContext, OpsTimer } from './context.js';
import { FLUSH_BATCH, flushQueue, type FlushOutcome } from './flush.js';
import type { BoundedQueue } from './queue.js';

/** The queue size that flushes at once, and the size of one batch (D30). */
export const FLUSH_AT = FLUSH_BATCH;
/** The cadence of the timed flush once the process has started the package (D30, D45). */
export const FLUSH_EVERY_MS = 5_000;

/** The queue a `QueueFlusher` drains, the statement each item becomes, and its cadence. */
export interface QueueFlusherOptions<T> {
  readonly queue: BoundedQueue<T>;
  /** The statement one queued item becomes. */
  readonly toOperation: (item: T) => BatchOperation;
  /**
   * Runs before a flush drains the queue, so a module can queue what the flush owes: the rate
   * cut's lines of an ended minute, or of the running minute too when `force` is set at `stop()`.
   */
  readonly before?: (force: boolean) => void;
  readonly everyMs?: number;
  readonly at?: number;
}

const NOTHING: FlushOutcome = Object.freeze({ written: 0, refused: 0, kept: 0, dropped: 0 });

/**
 * Drains one bounded queue every 5 seconds once started, at once at the batch size, and at
 * `stop()` (D30, D47).
 */
export class QueueFlusher<T> implements OpsTimer {
  private readonly everyMs: number;
  private readonly at: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private kicked = false;
  private inFlight: Promise<FlushOutcome> | null = null;
  private next: Promise<FlushOutcome> | null = null;
  private nextForce = false;

  constructor(
    private readonly context: OpsContext,
    private readonly options: QueueFlusherOptions<T>,
  ) {
    this.everyMs = options.everyMs ?? FLUSH_EVERY_MS;
    this.at = options.at ?? FLUSH_AT;
    context.flushers.add(() => this.flush(true).then(() => undefined));
    context.timers.add(this);
  }

  /** Queues `item` (the queue drops its oldest at the bound and counts) and kicks a flush at the batch size. Never awaits. */
  push(item: T): void {
    this.options.queue.push(item);
    if (this.options.queue.size >= this.at) this.kick();
  }

  /** Schedules one flush on the next turn of the event loop, however often it is called before then. */
  kick(): void {
    if (this.kicked) return;
    this.kicked = true;
    const timer = setTimeout(() => {
      this.kicked = false;
      void this.flush(false);
    }, 0);
    timer.unref?.();
  }

  /** Starts the timed flush; a second call changes nothing. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.flush(false), this.everyMs);
    this.timer.unref?.();
  }

  /** Ends the timed flush; what the queue holds waits for `flush()`. */
  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Drains the queue, a batch of `at` statements at a time, and answers the sum of the outcomes. A
   * call made while a flush is in flight waits for it and runs once more; `force` reaches the
   * `before` hook of that later run.
   */
  flush(force = false): Promise<FlushOutcome> {
    if (this.inFlight === null) return this.begin(force);
    this.nextForce = this.nextForce || force;
    if (this.next === null) {
      this.next = this.inFlight.then(() => {
        const again = this.nextForce;
        this.next = null;
        this.nextForce = false;
        return this.begin(again);
      });
    }
    return this.next;
  }

  private begin(force: boolean): Promise<FlushOutcome> {
    const flight = this.drain(force).finally(() => {
      if (this.inFlight === flight) this.inFlight = null;
    });
    this.inFlight = flight;
    return flight;
  }

  /** Never rejects. At most the queue's bound goes in one call, so a push that keeps pace never holds the flush. */
  private async drain(force: boolean): Promise<FlushOutcome> {
    const { queue, toOperation, before } = this.options;
    const { db, logger } = this.context;
    try {
      before?.(force);
    } catch {
      // A module's hook never stops the flush.
    }
    const build = (items: readonly T[]): BatchOperation[] => items.map(toOperation);
    const rounds = Math.ceil(queue.limit / Math.max(1, this.at)) + 1;
    let total: FlushOutcome = NOTHING;
    for (let round = 0; round < rounds; round += 1) {
      if (round > 0 && queue.size === 0) break;
      let outcome: FlushOutcome;
      try {
        outcome = await flushQueue(db, queue, build, logger, this.at);
      } catch {
        break;
      }
      total = {
        written: total.written + outcome.written,
        refused: total.refused + outcome.refused,
        kept: total.kept + outcome.kept,
        dropped: total.dropped + outcome.dropped,
      };
      if (outcome.kept > 0) break;
    }
    return total;
  }
}
