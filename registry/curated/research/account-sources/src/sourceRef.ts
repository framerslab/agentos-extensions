import type { SourceRef } from './types.js';

/**
 * The 1-based first and last lines of a span at valid UTF-16 offsets, with an exclusive end.
 * CRLF counts as one break; an empty span belongs to the line at its start.
 */
export function lineRange(text: string, start: number, end: number): [number, number] {
  const first = 1 + (text.slice(0, start).match(/\n/gu)?.length ?? 0);
  const last = 1 + (text.slice(0, Math.max(start, end - 1)).match(/\n/gu)?.length ?? 0);
  return [first, last];
}

/** A source's address, with a GitHub file's line anchor when it carries lines. */
export function sourceRefLink(ref: SourceRef): string | null {
  if (ref.url === null || ref.kind !== 'github' || ref.lines === undefined) return ref.url;
  const [first, last] = ref.lines;
  const url = ref.url.split('#')[0];
  return `${url}#L${first}${first === last ? '' : `-L${last}`}`;
}

/** Whether an unknown value carries a source's required fields and optional path and line range. */
export function isSourceRef(value: unknown): value is SourceRef {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.kind !== 'string' || typeof ref.title !== 'string' || typeof ref.readAt !== 'string') return false;
  if (ref.url !== null && typeof ref.url !== 'string') return false;
  if (ref.version !== null && typeof ref.version !== 'string') return false;
  if (ref.path !== undefined && typeof ref.path !== 'string') return false;
  if (ref.lines !== undefined) {
    if (!Array.isArray(ref.lines) || ref.lines.length !== 2) return false;
    const [first, last] = ref.lines;
    if (typeof first !== 'number' || typeof last !== 'number' || !Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first) return false;
  }
  return true;
}
