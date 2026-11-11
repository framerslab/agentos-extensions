/**
 * @file robots.ts
 * @description robots.txt as RFC 9309 gives it (https://www.rfc-editor.org/rfc/rfc9309.html). The file of a page's
 * origin is read through the transport the page is read through, under a deadline of its own, and parsed to its
 * first `maxBytes` bytes (the RFC's floor is 500 KiB; a line the limit cuts is left out). Its groups are matched by
 * product token without case, the `*` group when none names the token; within the groups that apply, the longest
 * matching rule decides, an `Allow` over a `Disallow` of the same length, `*` matching any run of characters and a
 * final `$` the end of the path and query. A 400-range answer allows every page (2.3.1.3); a 500-range answer, a
 * failed request or a passed deadline refuses every page (2.3.1.4); a file past five redirects is taken as
 * unavailable (2.3.1.2). An origin's answer is kept for `cacheMs` per transport.
 *
 * @module agentos/extensions/research/citation-check/robots
 */

import type { Transport, TransportAnswer } from './page.js';

/** How robots.txt is read before a page and before each redirect hop. */
export interface RobotsRule {
  /** The product token groups are matched against, without case; `*` obeys the `*` group alone. */
  token: string;
  /** The deadline of the robots.txt request, in milliseconds. */
  timeoutMs: number;
  /** The parsing limit, in bytes: what lies past it is ignored. RFC 9309 sets its floor at 500 KiB. */
  maxBytes: number;
  /** How long an origin's answer is kept, in milliseconds. */
  cacheMs: number;
}

/** The parsing limit RFC 9309's section 2.5 sets as the least a reader parses: 500 KiB, written as 512,000 bytes. */
export const ROBOTS_PARSING_FLOOR = 512_000;

/** One `Allow` or `Disallow` line: its path pattern with its percent-encoding made one form. */
export interface RobotsLine {
  allow: boolean;
  pattern: string;
}

/** One group: the product tokens of its `User-agent` lines, in lower case, and its rules. */
export interface RobotsGroup {
  agents: string[];
  rules: RobotsLine[];
}

/** A robots.txt as read: its groups, or every page allowed (no file) or refused (no answer). */
export type RobotsFile = { kind: 'rules'; groups: RobotsGroup[] } | { kind: 'allow-all' } | { kind: 'disallow-all' };

const ALLOW_ALL: RobotsFile = Object.freeze({ kind: 'allow-all' as const });
const DISALLOW_ALL: RobotsFile = Object.freeze({ kind: 'disallow-all' as const });

/** The characters RFC 3986 calls unreserved, which a percent-encoding of them stands for. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/u;
/** The most origins one transport keeps an answer for; the oldest goes first. */
const CACHE_ENTRIES = 1_000;

/**
 * A path in one form for comparison: characters outside printable ASCII percent-encoded in UTF-8, an encoded
 * unreserved character decoded, and every other encoding in upper case (RFC 9309, 2.2.2).
 */
function normalizePath(path: string): string {
  let encoded = '';
  for (const char of path) {
    const code = char.codePointAt(0) as number;
    if (code > 0x20 && code < 0x7f) {
      encoded += char;
      continue;
    }
    try {
      encoded += encodeURIComponent(char);
    } catch {
      // A lone surrogate has no UTF-8 form; it is left out.
    }
  }
  return encoded.replace(/%([0-9A-Fa-f]{2})/gu, (_whole, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/**
 * Parses a robots.txt's text into its groups. Consecutive `User-agent` lines open one group, which its `Allow` and
 * `Disallow` lines fill; a rule before any `User-agent` line, an empty rule and every other line (`Sitemap`,
 * `Crawl-delay`, a comment) are passed over.
 */
export function parseRobots(text: string): RobotsFile {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let readingAgents = false;
  for (const raw of text.replace(/^﻿/u, '').split(/\r\n|\r|\n/u)) {
    const line = raw.replace(/#.*$/u, '').trim();
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (field === 'user-agent') {
      if (current === null || !readingAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
        readingAgents = true;
      }
      if (value !== '') current.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (current === null) continue;
      readingAgents = false;
      if (value !== '') current.rules.push({ allow: field === 'allow', pattern: normalizePath(value) });
    }
  }
  return { kind: 'rules', groups };
}

/** Whether a group's `User-agent` value names the token: the same word without case, or the word with a version after it. */
function namesToken(agent: string, token: string): boolean {
  return agent === token || (token !== '*' && agent.startsWith(`${token}/`));
}

/**
 * Whether a rule's pattern matches a path and query from their start: `*` any run of characters, a final `$` the end.
 * Each piece between wildcards is found at its first place after the one before it, which is where it leaves the most
 * path for the pieces after it, so the time grows with the pattern and the path and never with the ways to split them.
 */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const first = pieces[0] as string;
  if (!path.startsWith(first)) return false;
  if (pieces.length === 1) return !anchored || path.length === first.length;
  let at = first.length;
  for (const piece of pieces.slice(1, -1)) {
    if (piece === '') continue;
    const found = path.indexOf(piece, at);
    if (found === -1) return false;
    at = found + piece.length;
  }
  const last = pieces[pieces.length - 1] as string;
  if (anchored) return path.length - last.length >= at && path.endsWith(last);
  return path.indexOf(last, at) !== -1;
}

/**
 * Whether robots.txt lets a reader with this product token read the address. `/robots.txt` itself is always allowed.
 *
 * @param file - The file, from {@link readRobots} or {@link parseRobots}.
 * @param token - The reader's product token; `*` obeys the `*` group alone.
 * @param url - The address to read.
 */
export function robotsAllows(file: RobotsFile, token: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.pathname === '/robots.txt') return true;
  if (file.kind === 'allow-all') return true;
  if (file.kind === 'disallow-all') return false;
  const path = normalizePath(`${target.pathname}${target.search}`) || '/';
  const wanted = token.trim().toLowerCase();
  let groups = file.groups.filter((group) => group.agents.some((agent) => namesToken(agent, wanted)));
  if (groups.length === 0) groups = file.groups.filter((group) => group.agents.includes('*'));
  let best: RobotsLine | null = null;
  for (const group of groups) {
    for (const rule of group.rules) {
      if (!matches(rule.pattern, path)) continue;
      const longer = best === null || rule.pattern.length > best.pattern.length;
      const allowOverDisallow = best !== null && rule.pattern.length === best.pattern.length && rule.allow && !best.allow;
      if (longer || allowOverDisallow) best = rule;
    }
  }
  return best === null || best.allow;
}

/** How {@link readRobots} reads an origin's file. */
export interface ReadRobotsOptions {
  /** The transport the file is requested through, the one the pages are read through. */
  transport: Transport;
  /** The token, the deadline, the parsing limit and how long an answer is kept. */
  robots: RobotsRule;
  /** The host's rule, which the transport applies to the file's address and to each of its redirect hops. */
  allowUrl?: (url: string) => boolean;
  /** The caller's cancellation, which is thrown. */
  signal?: AbortSignal;
  /** The clock the kept answers are timed by; `Date.now` when left out. */
  now?: () => number;
}

/** The answers each transport keeps, by origin, with when each was read. */
const kept = new WeakMap<Transport, Map<string, { at: number; file: RobotsFile }>>();

/** Whether an error is a transport's refusal of a file past its redirects. */
function pastRedirects(error: unknown): boolean {
  return error instanceof Error && error.name === 'PageRefusal' && (error as Error & { failure?: unknown }).failure === 'redirects';
}

/** A file's bytes as text, held to the parsing limit; past it, the line the limit cuts is left out. */
function robotsText(bytes: Uint8Array, limit: number): string {
  let held = bytes;
  if (bytes.byteLength > limit) {
    held = bytes.subarray(0, limit);
    const lastBreak = Math.max(held.lastIndexOf(0x0a), held.lastIndexOf(0x0d));
    held = held.subarray(0, lastBreak + 1);
  }
  return new TextDecoder('utf-8').decode(held);
}

/** Requests the file and reads what its answer means. */
async function fetchRobots(robotsUrl: string, options: ReadRobotsOptions): Promise<RobotsFile> {
  const deadline = AbortSignal.timeout(options.robots.timeoutMs);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  let answer: TransportAnswer;
  try {
    answer = await options.transport(robotsUrl, signal, options.allowUrl !== undefined ? { allowUrl: options.allowUrl } : undefined);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    return pastRedirects(error) ? ALLOW_ALL : DISALLOW_ALL;
  }
  try {
    if (answer.status >= 200 && answer.status < 300) {
      const limit = options.robots.maxBytes;
      // One byte past the limit says whether the file runs past it.
      const bytes = answer.readPrefix !== undefined ? await answer.readPrefix(limit + 1) : await answer.read(limit + 1);
      if (bytes === null) return DISALLOW_ALL;
      return parseRobots(robotsText(bytes, limit));
    }
    await answer.discard();
    return answer.status >= 500 ? DISALLOW_ALL : ALLOW_ALL;
  } catch {
    await answer.discard().catch(() => undefined);
    if (options.signal?.aborted) throw options.signal.reason;
    return DISALLOW_ALL;
  }
}

/**
 * Reads the robots.txt of an address's origin through the transport, or the answer the transport keeps for it.
 * A 2xx answer is parsed; a 400-range answer allows every page; a 500-range answer, a failed request, a passed
 * deadline or a hop the host rule refuses refuses every page; a file past five redirects allows every page.
 *
 * @param url - Any address of the origin.
 * @param options - The transport, the rule, the host rule for the file's hops, the caller's cancellation.
 * @throws The caller's cancellation reason, when `signal` aborts; a `TypeError` for an address that does not parse.
 */
export async function readRobots(url: string, options: ReadRobotsOptions): Promise<RobotsFile> {
  const origin = new URL(url).origin;
  const now = options.now ?? Date.now;
  let answers = kept.get(options.transport);
  if (answers === undefined) {
    answers = new Map();
    kept.set(options.transport, answers);
  }
  const held = answers.get(origin);
  if (held !== undefined && now() - held.at < options.robots.cacheMs) return held.file;
  const file = await fetchRobots(`${origin}/robots.txt`, options);
  answers.delete(origin);
  answers.set(origin, { at: now(), file });
  if (answers.size > CACHE_ENTRIES) answers.delete(answers.keys().next().value as string);
  return file;
}
