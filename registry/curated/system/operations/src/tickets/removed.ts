/**
 * @fileoverview What the limits remember of removed requests (D12, D46). The quota, the cooldown
 * and the hourly rate count rows, and `remove` and `staffRemove` delete a request's rows (deleted
 * means gone: no tombstone), so a person who opened, removed and opened again in a loop counted as
 * one who had opened once, and each open mailed the team an alert. This memory keeps, by account,
 * the opening times of the person's requests removed in the last 24 hours and the times of their
 * messages removed in the last hour, and the two checks add them to their COUNT. It is the
 * process's alone: no table holds a deleted row and this release adds no migration, so another
 * process and a restart start with nothing (the README says so). Bounded: at most 10,000 accounts,
 * the least recently remembered forgotten first, and each account's times trimmed to their windows
 * whenever they are read or added. An account's deletion forgets it.
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** How many accounts the memory holds at most; past it the least recently remembered is forgotten. */
export const REMOVED_ACCOUNTS_MAX = 10_000;

interface Remembered {
  /** The opening times of the person's removed requests, within the last 24 hours. */
  openings: number[];
  /** The times of the person's removed messages, within the last hour. */
  messages: number[];
}

/** The times the limits remember of a removed request: its opening, when the person opened it, and the person's messages on it. */
export interface RemovedTimes {
  readonly openings?: readonly number[];
  readonly messages?: readonly number[];
}

/** The times of removed requests and messages the limits still count, by account, in this process. */
export class RemovedMemory {
  /** By account, in the order they were last remembered: a Map keeps insertion order, and a remembered account is moved to the end. */
  private readonly accounts = new Map<string, Remembered>();

  constructor(private readonly max = REMOVED_ACCOUNTS_MAX) {}

  /** Remembers `times` for `accountId`; a time already out of its window is dropped, and the account becomes the most recently remembered. */
  remember(accountId: string, times: RemovedTimes, nowMs: number): void {
    const entry = this.trimmed(accountId, nowMs) ?? { openings: [], messages: [] };
    for (const at of times.openings ?? []) {
      if (at > nowMs - DAY_MS) entry.openings.push(at);
    }
    for (const at of times.messages ?? []) {
      if (at > nowMs - HOUR_MS) entry.messages.push(at);
    }
    this.accounts.delete(accountId);
    if (entry.openings.length === 0 && entry.messages.length === 0) return;
    this.accounts.set(accountId, entry);
    while (this.accounts.size > this.max) {
      const oldest = this.accounts.keys().next().value;
      if (oldest === undefined) break;
      this.accounts.delete(oldest);
    }
  }

  /** The opening times of `accountId`'s requests removed in the last 24 hours. */
  openings(accountId: string, nowMs: number): readonly number[] {
    return this.trimmed(accountId, nowMs)?.openings ?? [];
  }

  /** The times of `accountId`'s messages removed in the last hour. */
  messages(accountId: string, nowMs: number): readonly number[] {
    return this.trimmed(accountId, nowMs)?.messages ?? [];
  }

  /** Forgets everything remembered of `accountId`: its deletion. */
  forget(accountId: string): void {
    this.accounts.delete(accountId);
  }

  /** How many accounts are remembered. */
  get size(): number {
    return this.accounts.size;
  }

  /** `accountId`'s entry with its times trimmed to their windows, dropped when nothing is left; null when none. */
  private trimmed(accountId: string, nowMs: number): Remembered | null {
    const entry = this.accounts.get(accountId);
    if (entry === undefined) return null;
    entry.openings = entry.openings.filter((at) => at > nowMs - DAY_MS);
    entry.messages = entry.messages.filter((at) => at > nowMs - HOUR_MS);
    if (entry.openings.length === 0 && entry.messages.length === 0) {
      this.accounts.delete(accountId);
      return null;
    }
    return entry;
  }
}
