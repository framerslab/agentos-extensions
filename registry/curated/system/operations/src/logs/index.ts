/**
 * @fileoverview `./logs`: `Lines`, the log table with its rate cut and its search (D30, D32, D40).
 * `push` checks the line (the process a word; `kind`, `status` and `path` under the product's own
 * rules for those keys where it declares them, each value still fitting its column, else a word,
 * an HTTP status and a route pattern the host's `routePattern` answers with itself; the rest
 * through the `fields` gate), keeps one
 * shape at most `lineShapePerMinute` times a minute (a minute tracks 10,000 shapes, and the shapes
 * first seen past them share one tally under the same limit), and queues it; the queue flushes every 5
 * seconds or at 500. `push` never throws and never waits; a refusal is counted into the minute's
 * `ops_refused` line, never written. A field under the name of a column (`kind`, `status`,
 * `path`) stays in `fields` unless it repeats the column's value, so nothing a line carries is
 * lost. A line of kind `ops_rate_cut` is the package's own, which the rate cut writes into the
 * table itself; the same line handed back by a host logger that pushes what it logs is left out,
 * without a refusal, so a cut is stored and counted once.
 */
import { isWord, type OpsContext, type OpsQueuedLine } from '../context.js';
import type { Lines } from '../contract.js';
import type { OpsCheckedFields } from '../fields.js';
import { QueueFlusher } from '../flusher.js';
import { ownLine } from '../own-lines.js';
import { clean } from '../store/clean.js';
import { newId } from '../store/ids.js';
import { RATE_CUT_KIND, RateCut, type RateCutLine } from './rate.js';
import { searchLines } from './search.js';

const REFUSED = Symbol('refused');

/** The line's own columns; a field under one of these names is left out only when it repeats the column's value. */
const COLUMNS = new Set(['kind', 'status', 'path']);

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStatus = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599;

/** What the `kind` and `path` columns hold: text. */
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** What the `status` column holds: a whole number (`BIGINT` on PostgreSQL). */
const isWhole = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);

/**
 * Builds `Lines` over `context`: `push` checks a line, holds its shape to the rate cut and queues
 * it; `search` reads the table (D30, D32, D40).
 */
export function createLines(context: OpsContext): Lines {
  const { logger, now, fields: gate } = context;
  const table = context.table('log_lines');
  const rate = new RateCut(context.limits.lineShapePerMinute, context.options.process);
  const statement = `INSERT INTO ${table} (id, at, process, kind, status, path, fields) VALUES (?, ?, ?, ?, ?, ?, ?)`;
  const declared = (key: string): boolean => Object.prototype.hasOwnProperty.call(gate.rule, key);

  const flusher = new QueueFlusher<OpsQueuedLine>(context, {
    queue: context.queues.lines,
    toOperation: (line) => ({
      statement,
      parameters: [
        line.id,
        line.at,
        clean(line.process),
        clean(line.kind),
        line.status,
        line.path === null ? null : clean(line.path),
        JSON.stringify(line.fields),
      ],
    }),
    before: (force) => queueCuts(rate.drain(now(), force)),
  });

  /**
   * Queues one `ops_rate_cut` line a cut shape, in place of the lines it lost, and logs each. The
   * tally the shapes past the tracked number share has no kind, so its line carries the count alone.
   */
  function queueCuts(cuts: readonly RateCutLine[]): void {
    for (const cut of cuts) {
      const fields: Record<string, string | number> = cut.kind === null ? { count: cut.count } : { kind: cut.kind, count: cut.count };
      context.queues.lines.push({
        id: newId('ln'),
        at: cut.at,
        process: cut.process,
        kind: RATE_CUT_KIND,
        status: cut.status,
        path: cut.path,
        fields,
      });
      ownLine(logger, 'warn', RATE_CUT_KIND, { process: cut.process, ...fields });
    }
  }

  /**
   * One column of the line: under the product's rule for its key when the rule declares the key,
   * else under the package's own check; `undefined` is null. A value the product's rule admits
   * must still fit the column (`fits`: text for `kind` and `path`, a whole number for `status`),
   * so a rule that admits another type never sends the table a value it refuses on one dialect and
   * keeps on the other, or a value no statement can be built from. A refusal is counted under the key.
   */
  function column<T extends string | number>(
    key: 'kind' | 'status' | 'path',
    value: unknown,
    own: (value: unknown) => value is T,
    fits: (value: unknown) => value is T,
  ): T | null | typeof REFUSED {
    if (value === undefined) return null;
    if (declared(key)) {
      const checked = gate.check({ [key]: value });
      if (checked === null) return REFUSED;
      const kept: unknown = checked[key];
      if (fits(kept)) return kept;
      gate.refuse(key);
      return REFUSED;
    }
    if (own(value)) return value;
    gate.refuse(key);
    return REFUSED;
  }

  /** The row a pushed line becomes, or null once its refusal is counted. */
  function check(line: unknown): OpsQueuedLine | null {
    if (!plain(line)) {
      gate.refuse('line');
      return null;
    }
    if (line.kind === RATE_CUT_KIND) return null;
    if (!isWord(line.process)) {
      gate.refuse('process');
      return null;
    }
    if (line.kind === undefined) {
      gate.refuse('kind');
      return null;
    }
    const kind = column<string>('kind', line.kind, isWord, isText);
    if (kind === REFUSED || kind === null) return null;
    const status = column<number>('status', line.status, isStatus, isWhole);
    if (status === REFUSED) return null;
    const path = column<string>('path', line.path, (value): value is string => gate.path(value), isText);
    if (path === REFUSED) return null;
    const checked: OpsCheckedFields | null = line.fields === undefined ? {} : gate.check(line.fields);
    if (checked === null) return null;
    const columns: Readonly<Record<string, string | number | null>> = { kind, status, path };
    const fields: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(checked)) {
      if (!(COLUMNS.has(key) && columns[key] === value)) fields[key] = value;
    }
    return { id: newId('ln'), at: now(), process: line.process, kind, status, path, fields };
  }

  return {
    push(line) {
      try {
        const checked = check(line);
        if (checked === null) return;
        const { keep, ended } = rate.admit(checked, checked.at);
        queueCuts(ended);
        if (keep) flusher.push(checked);
      } catch {
        // push never throws (D47); a line the check cannot read is lost and nothing else.
      }
    },
    search: (query) => searchLines(context, query),
  };
}
