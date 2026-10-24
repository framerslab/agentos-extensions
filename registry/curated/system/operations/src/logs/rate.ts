/**
 * @fileoverview The rate cut (D30): one line shape (process, kind, status, path) is kept at most
 * `limit` times a minute. Past that the lines are counted, and at the minute's end one
 * `ops_rate_cut` line with the count stands in their place. The minute is the clock's UTC minute;
 * `drain` answers the cut lines owed once the minute has ended, or at `stop()` whatever the minute.
 * A minute tracks `SHAPES_MAX` shapes; the lines of every shape first seen past them share one
 * tally under the same limit, so a producer of ever new shapes is cut too, and that tally's line
 * names the process the package runs in and no kind, status or path.
 */

/** The kind of the line that stands for the lines a shape lost to the rate cut (D30). */
export const RATE_CUT_KIND = 'ops_rate_cut';

/** What the rate cut counts by: a line's process, kind, status and path (D30). */
export interface LineShape {
  readonly process: string;
  readonly kind: string;
  readonly status: number | null;
  readonly path: string | null;
}

/**
 * One cut line owed: the shape, how many lines it stands for, and its time (the minute's last
 * millisecond, or the clock's when forced earlier). The tally the shapes past `SHAPES_MAX` share
 * answers the package's own process with a null kind, status and path.
 */
export interface RateCutLine {
  readonly process: string;
  /** The shape's kind, or null for the tally the shapes first seen past `SHAPES_MAX` share. */
  readonly kind: string | null;
  readonly status: number | null;
  readonly path: string | null;
  readonly count: number;
  readonly at: number;
}

interface Tally {
  readonly line: Omit<RateCutLine, 'count' | 'at'>;
  kept: number;
  cut: number;
}

/** A minute in milliseconds: the span the rate cut counts over. */
export const MINUTE_MS = 60_000;

/**
 * Distinct shapes tracked within one minute, which bounds what the rate cut holds. Past this, a
 * new shape's lines go to the one tally such shapes share, kept at most `limit` times in all.
 */
export const SHAPES_MAX = 10_000;

const keyOf = (shape: LineShape): string => `${shape.process}\u0000${shape.kind}\u0000${shape.status ?? ''}\u0000${shape.path ?? ''}`;

/** Keeps each line shape at most `limit` times a minute and counts the rest (D30). */
export class RateCut {
  private minute = -1;
  private readonly tallies = new Map<string, Tally>();
  /** The tally the shapes first seen past `SHAPES_MAX` share this minute, once one has come. */
  private overflow: Tally | null = null;

  /**
   * @param limit - the lines of one shape kept a minute, 0 or more.
   * @param process - the process the package runs in, which the shared tally's line names.
   */
  constructor(
    private readonly limit: number,
    private readonly process: string,
  ) {
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
    const tally = this.tallyOf(shape);
    if (tally.kept < this.limit) {
      tally.kept += 1;
      return { keep: true, ended };
    }
    tally.cut += 1;
    return { keep: false, ended };
  }

  /** The tally of `shape`: its own while fewer than `SHAPES_MAX` shapes are tracked, else the shared one. */
  private tallyOf(shape: LineShape): Tally {
    const key = keyOf(shape);
    const known = this.tallies.get(key);
    if (known !== undefined) return known;
    if (this.tallies.size < SHAPES_MAX) {
      const tally: Tally = { line: { process: shape.process, kind: shape.kind, status: shape.status, path: shape.path }, kept: 0, cut: 0 };
      this.tallies.set(key, tally);
      return tally;
    }
    if (this.overflow === null) this.overflow = { line: { process: this.process, kind: null, status: null, path: null }, kept: 0, cut: 0 };
    return this.overflow;
  }

  /**
   * The cut lines owed at `at`: those of the held minute once it has ended, or of the running
   * minute too when `force` is set, the shared tally's last. Each carries the minute's last
   * millisecond as its time, or `at` when that comes first.
   */
  drain(at: number, force = false): readonly RateCutLine[] {
    if (this.tallies.size === 0 && this.overflow === null) {
      this.minute = -1;
      return [];
    }
    const minute = Math.floor(at / MINUTE_MS);
    if (!force && minute === this.minute) return [];
    const end = Math.min(this.minute * MINUTE_MS + MINUTE_MS - 1, at);
    const lines: RateCutLine[] = [];
    for (const { line, cut } of this.tallies.values()) {
      if (cut > 0) lines.push({ ...line, count: cut, at: end });
    }
    if (this.overflow !== null && this.overflow.cut > 0) lines.push({ ...this.overflow.line, count: this.overflow.cut, at: end });
    this.tallies.clear();
    this.overflow = null;
    this.minute = -1;
    return lines;
  }
}
