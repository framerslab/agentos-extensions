/**
 * @fileoverview The log search (D32): by kind (one or several, exact, at most 20), path (a prefix), status
 * (one code or a class from 2xx to 5xx), process, and a time range (the last hour by default, 14
 * days at most), newest first, 100 a page by a cursor of time and id. A `from` older than 14 days
 * is cut to 14 days, never refused. A line's answer carries all its fields.
 */
import type { OpsContext } from '../context.js';
import type { OpsLogLine, OpsLogPage, OpsSearch } from '../contract.js';

export const PAGE_SIZE = 100;
export const DEFAULT_WINDOW_MS = 60 * 60_000;
export const WINDOW_MAX_MS = 14 * 86_400_000;
/** How many kinds one search may name. */
const KINDS_MAX = 20;
const TEXT_MAX = 512;
/** The cursor this search gives: the last line's time and id. */
const CURSOR = /^(\d{1,15})\.(ln_[0-9a-f]{32})$/;
const CLASSES: Readonly<Record<'2xx' | '3xx' | '4xx' | '5xx', readonly [number, number]>> = {
  '2xx': [200, 299],
  '3xx': [300, 399],
  '4xx': [400, 499],
  '5xx': [500, 599],
};

/** Whether `value` names one of the four status classes. */
const isStatusClass = (value: unknown): value is keyof typeof CLASSES =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(CLASSES, value);

interface Row {
  id: string;
  at: number | string;
  process: string;
  kind: string;
  status: number | string | null;
  path: string | null;
  fields: unknown;
}

const plain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function requireTime(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`search: ${name} must be milliseconds since the epoch`);
  }
  return Math.floor(value);
}

function requireText(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > TEXT_MAX) {
    throw new TypeError(`search: ${name} must be a string of 1 to ${TEXT_MAX} characters`);
  }
  return value;
}

/** The stored fields as the search answers them: words and integers under their keys, nothing else. */
export function parseFields(value: unknown): Readonly<Record<string, string | number>> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!plain(parsed)) return {};
  const fields: Record<string, string | number> = {};
  for (const [key, entry] of Object.entries(parsed)) {
    if (typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry))) fields[key] = entry;
  }
  return fields;
}

const toLine = (row: Row): OpsLogLine => ({
  id: String(row.id),
  at: Number(row.at),
  process: String(row.process),
  kind: String(row.kind),
  status: row.status === null || row.status === undefined ? null : Number(row.status),
  path: row.path === null || row.path === undefined ? null : String(row.path),
  fields: parseFields(row.fields),
});

export async function searchLines(context: OpsContext, query: OpsSearch = {}): Promise<OpsLogPage> {
  if (!plain(query)) throw new TypeError('search: the query must be an object');
  const now = context.now();
  const where: string[] = [];
  const parameters: unknown[] = [];

  const to = query.to === undefined ? now : requireTime('to', query.to);
  const asked = query.from === undefined ? to - DEFAULT_WINDOW_MS : requireTime('from', query.from);
  const from = Math.max(asked, now - WINDOW_MAX_MS);
  if (from > to) return { lines: [], cursor: null };
  where.push('at >= ?', 'at <= ?');
  parameters.push(from, to);

  if (query.kind !== undefined) {
    const kinds = Array.isArray(query.kind) ? [...query.kind] : [query.kind];
    // A longer list is refused, never cut short: a page for the first kinds alone would read as complete.
    if (kinds.length > KINDS_MAX) throw new RangeError(`search: kind may name at most ${KINDS_MAX} kinds`);
    if (kinds.length === 0) return { lines: [], cursor: null };
    for (const kind of kinds) requireText('kind', kind);
    where.push(`kind IN (${kinds.map(() => '?').join(', ')})`);
    parameters.push(...kinds);
  }
  if (query.path !== undefined) {
    const path = requireText('path', query.path);
    where.push('substr(path, 1, ?) = ?');
    parameters.push(path.length, path);
  }
  if (query.status !== undefined) {
    if (typeof query.status === 'number') {
      if (!Number.isSafeInteger(query.status)) throw new TypeError('search: status must be an integer or a class such as 5xx');
      where.push('status = ?');
      parameters.push(query.status);
    } else if (isStatusClass(query.status)) {
      const [low, high] = CLASSES[query.status];
      where.push('status >= ?', 'status <= ?');
      parameters.push(low, high);
    } else {
      throw new TypeError('search: status must be an integer or a class such as 5xx');
    }
  }
  if (query.process !== undefined) {
    where.push('process = ?');
    parameters.push(requireText('process', query.process));
  }
  if (query.cursor !== undefined) {
    const match = CURSOR.exec(String(query.cursor));
    if (match === null) throw new RangeError('search: the cursor is not one this search gave');
    const at = Number(match[1]);
    where.push('(at < ? OR (at = ? AND id < ?))');
    parameters.push(at, at, match[2]);
  }

  const rows = await context.db.all<Row>(
    `SELECT id, at, process, kind, status, path, fields FROM ${context.table('log_lines')}
     WHERE ${where.join(' AND ')} ORDER BY at DESC, id DESC LIMIT ${PAGE_SIZE + 1}`,
    parameters,
  );
  const lines = rows.slice(0, PAGE_SIZE).map(toLine);
  const last = lines[lines.length - 1];
  const cursor = rows.length > PAGE_SIZE && last !== undefined ? `${last.at}.${last.id}` : null;
  return { lines, cursor };
}
