/**
 * @fileoverview The rate cut (D30): one line shape (process, kind, status, path) is kept at most
 * `limit` times a minute. Past that the lines are counted, and at the minute's end one
 * `ops_rate_cut` line with the count stands in their place. The minute is the clock's UTC minute;
 * `drain` answers the cut lines owed once the minute has ended, or at `stop()` whatever the minute.
 */

/** The kind of the line that stands for the lines a shape lost to the rate cut (D30). */
export const RATE_CUT_KIND = 'ops_rate_cut';

export interface LineShape {
  readonly process: string;
  readonly kind: string;
  readonly status: number | null;
  readonly path: string | null;
}

/** One cut line owed: the shape, how many lines it stands for, and its time (the minute's last millisecond, or the clock's when forced earlier). */
export interface RateCutLine extends LineShape {
  readonly count: number;
  readonly at: number;
}

interface Tally {
  readonly shape: LineShape;
  kept: number;
  cut: number;
}

export const MINUTE_MS = 60_000;

/** Distinct shapes tracked within one minute; past this, a new shape is kept untracked, since a shape that repeats shows early. */
const SHAPES_MAX = 10_000;

const keyOf = (shape: LineShape): string => `${shape.process}\u0000${shape.kind}\u0000${shape.status ?? ''}\u0000${shape.path ?? ''}`;

export class RateCut {
  private minute = -1;
  private readonly tallies = new Map<string, Tally>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError('the rate cut takes a limit of 0 or more');
  }

  /**
   * Keeps or cuts one line of `shape` at `at`, and answers the cut lines of a minute that ended
   * before it, which the caller queues first so they keep their order.
   */
  admit(shape: LineShape, at: number): { readonly keep: boolean; readonly ended: readonly RateCutLine[] } {
    const ended = this.drain(at, false);
    const minute = Math.floor(at / MINUTE_MS);
    if (this.minute === -1) this.minute = minute;
    const key = keyOf(shape);
    let tally = this.tallies.get(key);
    if (tally === undefined) {
      if (this.tallies.size >= SHAPES_MAX) return { keep: true, ended };
      tally = { shape: { process: shape.process, kind: shape.kind, status: shape.status, path: shape.path }, kept: 0, cut: 0 };
      this.tallies.set(key, tally);
    }
    if (tally.kept < this.limit) {
      tally.kept += 1;
      return { keep: true, ended };
    }
    tally.cut += 1;
    return { keep: false, ended };
  }

  /**
   * The cut lines owed at `at`: those of the held minute once it has ended, or of the running
   * minute too when `force` is set. Each carries the minute's last millisecond as its time, or
   * `at` when that comes first.
   */
  drain(at: number, force = false): readonly RateCutLine[] {
    if (this.tallies.size === 0) {
      this.minute = -1;
      return [];
    }
    const minute = Math.floor(at / MINUTE_MS);
    if (!force && minute === this.minute) return [];
    const end = Math.min(this.minute * MINUTE_MS + MINUTE_MS - 1, at);
    const lines: RateCutLine[] = [];
    for (const { shape, cut } of this.tallies.values()) {
      if (cut > 0) lines.push({ ...shape, count: cut, at: end });
    }
    this.tallies.clear();
    this.minute = -1;
    return lines;
  }
}
