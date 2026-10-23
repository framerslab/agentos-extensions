/**
 * @fileoverview The bounded in-memory queues (D27, D30, D47): one a kind, captures, lines, events
 * and beats, each to its bound from `OpsLimits`. A full queue drops the newest and counts it.
 * Nothing in the enqueue path awaits: `push` is synchronous, and the flush drains what it holds.
 */

export type OpsQueueName = 'captures' | 'lines' | 'events' | 'beats';

export class BoundedQueue<T> {
  private items: T[] = [];
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
    return this.items.length;
  }

  /** How many were dropped at the bound since the count was last taken. */
  get dropped(): number {
    return this.droppedCount;
  }

  /** Queues `item`; answers false, and counts, when the queue is full. Never awaits. */
  push(item: T): boolean {
    if (this.items.length >= this.limit) {
      this.droppedCount += 1;
      return false;
    }
    this.items.push(item);
    return true;
  }

  /** Takes up to `max` items in the order they came, leaving the rest. */
  drain(max: number = Number.POSITIVE_INFINITY): T[] {
    if (max >= this.items.length) {
      const all = this.items;
      this.items = [];
      return all;
    }
    return this.items.splice(0, max);
  }

  /** Answers the drop count and resets it, for the line that reports it. */
  takeDropped(): number {
    const count = this.droppedCount;
    this.droppedCount = 0;
    return count;
  }
}
