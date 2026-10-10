/**
 * @file limiter.ts
 * @description One limiter for every request a process makes to one public source: at most `concurrency` at once,
 * starts at least `spacingMs` apart, at most `perMinute` starts in any 60 seconds, a wait of at most `waitMs` for a
 * slot or the spacing, and a block until `Retry-After` has passed after a 429 or a 503. Wikimedia's defaults: 3 at
 * once, 250 ms (under 5 a second), 200 a minute, five seconds when no `Retry-After` comes. A start is stamped when its
 * request begins, after the caller's own check before it (`beforeStart`) has settled, so a request that check refuses
 * spends no start; a block, or a spacing past the wait, can still refuse a request once that check has run.
 *
 * @module agentos/extensions/research/public-sources/limiter
 */

/** Why the limiter refused: a block in force, the minute's starts used, no slot within the wait, or the caller's `onSend`. */
export class LimiterRefused extends Error {
  constructor(readonly reason: 'blocked' | 'minute' | 'wait' | 'caller') {
    super(`The source's limiter refused the request (${reason}).`);
    this.name = 'LimiterRefused';
  }
}

/** The limiter's numbers and its clock. */
export interface LimiterOptions {
  /** The most requests at once; 3 when left out. */
  concurrency?: number;
  /** The fewest milliseconds between two starts; 250 when left out. */
  spacingMs?: number;
  /** The most starts in any 60 seconds; 200 when left out. */
  perMinute?: number;
  /** The longest wait for a slot or the spacing before a refusal, in milliseconds; 2,000 when left out. */
  waitMs?: number;
  /**
   * The clock every measure is read on (the spacing, the wait, the minute's window and a block), in milliseconds;
   * `Date.now` when left out. The waits themselves run on timers, so it must move with real time.
   */
  now?: () => number;
}

const MINUTE_MS = 60_000;
const BLOCK_DEFAULT_MS = 5_000;
const BLOCK_MAX_MS = 3_600_000;
const POLL_MS = 25;

/** A `Retry-After` value as milliseconds from `now`: seconds or an HTTP date; five seconds when absent or unreadable; an hour at most. */
export function retryAfterMs(header: string | null, now: number): number {
  const value = (header ?? '').trim();
  let ms = Number.NaN;
  if (/^\d+$/u.test(value)) ms = Number(value) * 1000;
  else if (value !== '') ms = Date.parse(value) - now;
  if (!Number.isFinite(ms) || ms < 0) return BLOCK_DEFAULT_MS;
  return Math.min(ms, BLOCK_MAX_MS);
}

/** Waits `ms`, or rejects with the signal's reason when it aborts first. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The limiter. */
export class SourceLimiter {
  private readonly concurrency: number;
  private readonly spacingMs: number;
  private readonly perMinute: number;
  private readonly waitMs: number;
  private readonly now: () => number;
  private active = 0;
  /** Requests that hold a slot while their `beforeStart` runs: each holds one of the minute's starts until stamped. */
  private pending = 0;
  private lastStart = Number.NEGATIVE_INFINITY;
  private starts: number[] = [];
  private blockedUntil = 0;

  constructor(options: LimiterOptions = {}) {
    this.concurrency = options.concurrency ?? 3;
    this.spacingMs = options.spacingMs ?? 250;
    this.perMinute = options.perMinute ?? 200;
    this.waitMs = options.waitMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  /** Blocks every request until `Retry-After` has passed. */
  block(retryAfter: string | null): void {
    const at = this.now();
    this.blockedUntil = Math.max(this.blockedUntil, at + retryAfterMs(retryAfter, at));
  }

  /**
   * Runs one request under the limiter, or throws `LimiterRefused` without running it.
   *
   * `beforeStart`, when given, runs once the request holds its slot and before its start is stamped, for a check of the
   * caller's own such as a quota: what it throws ends the request with no start spent. Once it has settled, the start
   * is stamped at least `spacingMs` after any start made meanwhile. The request can still be refused then, with nothing
   * run: by a block that came meanwhile, or by a spacing that would take its wait past `waitMs` (the time `beforeStart`
   * took is not counted as waiting).
   */
  async run<T>(task: () => Promise<T>, signal?: AbortSignal, beforeStart?: () => void | Promise<void>): Promise<T> {
    signal?.throwIfAborted();
    const deadline = this.now() + this.waitMs;
    for (;;) {
      const at = this.now();
      if (at < this.blockedUntil) throw new LimiterRefused('blocked');
      this.starts = this.starts.filter((start) => at - start < MINUTE_MS);
      if (this.starts.length + this.pending >= this.perMinute) throw new LimiterRefused('minute');
      const spacing = this.lastStart + this.spacingMs - at;
      if (this.active < this.concurrency && spacing <= 0) break;
      const wait = this.active >= this.concurrency ? POLL_MS : spacing;
      if (at + wait > deadline) throw new LimiterRefused('wait');
      await sleep(wait, signal);
    }
    this.active += 1;
    try {
      if (beforeStart !== undefined) {
        this.pending += 1;
        try {
          const granted = this.now();
          await beforeStart();
          // The wait for the slot and the spacing keeps to `waitMs` in all; the time `beforeStart` took is not a wait.
          const until = deadline + (this.now() - granted);
          for (;;) {
            signal?.throwIfAborted();
            const at = this.now();
            if (at < this.blockedUntil) throw new LimiterRefused('blocked');
            const spacing = this.lastStart + this.spacingMs - at;
            if (spacing <= 0) break;
            if (at + spacing > until) throw new LimiterRefused('wait');
            await sleep(spacing, signal);
          }
        } finally {
          this.pending -= 1;
        }
      }
      // No await lies between the last check above and the stamp, so no other request starts in between.
      const at = this.now();
      this.lastStart = at;
      this.starts.push(at);
      return await task();
    } finally {
      this.active -= 1;
    }
  }
}
