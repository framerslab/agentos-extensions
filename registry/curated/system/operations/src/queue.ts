/**
 * @fileoverview The bounded in-memory queues (D27, D30, D47): one a kind, captures, lines, events
 * and beats, each to its bound from `OpsLimits`. A full queue drops the oldest and counts it, so
 * what is kept is the newest, and a batch a failed flush puts back goes in front of what came
 * since, the bound holding by dropping the oldest again. Nothing in the enqueue path awaits:
 * `push` is synchronous, and the queue is a ring, so a push at the bound costs the same as any.
 */

/** The four queues, one a kind of entry. */
export type OpsQueueName = 'captures' | 'lines' | 'events' | 'beats';

/** A ring of at most `limit` items: a push at the bound drops the oldest and counts it. */
export class BoundedQueue<T> {
  /** The ring: slot `(head + n) % limit` holds the item queued n after the oldest. */
  private readonly slots: Array<T | undefined> = [];
  /** The slot of the oldest item. */
  private head = 0;
  private count = 0;
  private droppedCount = 0;

  constructor(
    readonly name: OpsQueueName,
    readonly limit: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError(`the ${name} queue's bound must be a safe integer of 0 or more`);
    }
  }

  /** How many items wait. */
  get size(): number {
    return this.count;
  }

  /** How many were dropped at the bound since the count was last taken. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Queues `item`. At the bound the oldest item goes to make room and is counted, and the answer is
   * false; a queue whose bound is 0 keeps nothing and counts `item`. Never awaits.
   */
  push(item: T): boolean {
    if (this.limit === 0) {
      this.droppedCount += 1;
      return false;
    }
    if (this.count === this.limit) {
      this.slots[this.head] = item;
      this.head = (this.head + 1) % this.limit;
      this.droppedCount += 1;
      return false;
    }
    this.slots[(this.head + this.count) % this.limit] = item;
    this.count += 1;
    return true;
  }

  /** Takes up to `max` items, the oldest first, leaving the rest. */
  drain(max: number = Number.POSITIVE_INFINITY): T[] {
    const wanted = Number.isNaN(max) ? 0 : Math.max(0, Math.floor(max));
    const take = Math.min(this.count, wanted);
    const items = new Array<T>(take);
    for (let index = 0; index < take; index += 1) {
      const slot = (this.head + index) % this.limit;
      items[index] = this.slots[slot] as T;
      this.slots[slot] = undefined;
    }
    if (take > 0) {
      this.head = (this.head + take) % this.limit;
      this.count -= take;
    }
    return items;
  }

  /**
   * Puts `items`, a batch `drain` took, back in front of what was queued since, since they are
   * older; past the bound the oldest go, each counted. Answers how many went.
   */
  requeue(items: readonly T[]): number {
    if (items.length === 0) return 0;
    const all = [...items, ...this.drain()];
    const over = Math.max(0, all.length - this.limit);
    for (let index = over; index < all.length; index += 1) this.push(all[index] as T);
    this.droppedCount += over;
    return over;
  }

  /** Answers the drop count and resets it, for the line that reports it. */
  takeDropped(): number {
    const count = this.droppedCount;
    this.droppedCount = 0;
    return count;
  }
}
