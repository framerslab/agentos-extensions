/**
 * @fileoverview The bounds every call to Linear runs under: one deadline joined with the caller's signal, a call that
 * stops being waited on at that deadline whatever the fetch does with its signal, no redirect followed, no credentials
 * or referrer sent by the fetch itself, and an answer read whole under a byte cap. A call that gets no answer throws
 * `TrackerNoAnswer` with its cause; a body past the cap throws `ReadCapExceeded`, which each caller turns into its own
 * fault. Also the checks every address and credential passes before a call.
 * @module agentos-ext-linear/http
 */

import { ReadCapExceeded, TrackerNoAnswer } from '@framers/agentos-ext-account-sources';
import { LinearFault } from './faults.js';

/** The hosts a stand-in may answer at over plain HTTP. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an object that is not null, such as an options or input object a caller passes. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A nonempty credential of bounded length with no whitespace or control character. */
export function credential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
}

/** A deadline in milliseconds: a positive whole number no larger than ten minutes. */
export function deadlineMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 600_000;
}

/** The address a string names, or null when it names none. */
function addressOf(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Throws `configuration` unless `value` is an address a person's browser may be sent back to: absolute, with no
 * userinfo and no fragment, over HTTPS, or over plain HTTP at a loopback host.
 */
export function checkCallback(value: unknown): asserts value is string {
  const url = addressOf(value);
  if (url === null || (value as string).includes('#') || url.username !== '' || url.password !== '') throw new LinearFault('configuration');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) throw new LinearFault('configuration');
}

/**
 * A stand-in's address, taken only on CI (`CI=true`) and only at a loopback or `.invalid` host, over HTTPS or over
 * plain HTTP at a loopback host, with no userinfo, query or fragment. Throws `configuration` for any other. A host
 * passes one for its tests; it never takes one from a request.
 */
export function standInAddress(value: unknown): string {
  const url = addressOf(value);
  if (url === null || /[?#]/.test(value as string) || url.username !== '' || url.password !== '') throw new LinearFault('configuration');
  const loopback = LOOPBACK.has(url.hostname);
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  const reserved = loopback || url.hostname.endsWith('.invalid');
  if (!scheme || !reserved || process.env.CI !== 'true') throw new LinearFault('configuration');
  return value as string;
}

/** One call's signal (the caller's, ended at the deadline) and the fault a call without an answer throws. */
export interface Deadline {
  readonly signal: AbortSignal;
  /** The fault for a call that got no answer: the caller's cancel, the deadline, or a failed connection. */
  noAnswer(): TrackerNoAnswer;
}

/**
 * The deadline of one call: its own timeout joined with the caller's signal, so the call and the reading of its answer
 * end at whichever comes first.
 *
 * @param caller The caller's signal, if any.
 * @param timeoutMs How long the call may take, its answer included.
 */
export function deadlineOf(caller: AbortSignal | undefined, timeoutMs: number): Deadline {
  const timeout = AbortSignal.timeout(timeoutMs);
  return {
    signal: caller === undefined ? timeout : AbortSignal.any([caller, timeout]),
    noAnswer: () => new TrackerNoAnswer(caller?.aborted === true ? 'cancelled' : timeout.aborted ? 'timeout' : 'network'),
  };
}

/** Releases an answer's body unread; the cancel is asked for and never awaited. */
export function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Settles as `work` does, or rejects with the deadline's `TrackerNoAnswer` as soon as its signal aborts, whichever
 * comes first, even when `work` never settles. What `work` answers after that is handed to `release`.
 */
export function untilDeadline<T>(work: Promise<T>, deadline: Deadline, release?: (late: T) => void): Promise<T> {
  const { signal } = deadline;
  return new Promise<T>((resolve, reject) => {
    let ended = false;
    const end = (): void => {
      ended = true;
      reject(deadline.noAnswer());
    };
    if (signal.aborted) end();
    else signal.addEventListener('abort', end, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', end);
        if (ended) release?.(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', end);
        if (!ended) reject(error);
      },
    );
  });
}

/**
 * An answer's body read as it streams, under `maxBytes` and the deadline. A length the headers state past the cap is
 * refused unread; at the deadline or the caller's cancel the read ends and the body's reader is cancelled.
 */
async function readUnder(response: Response, maxBytes: number, deadline: Deadline): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    discard(response);
    throw new ReadCapExceeded(maxBytes);
  }
  const reader = response.body.getReader();
  const stop = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  deadline.signal.addEventListener('abort', stop, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await untilDeadline(reader.read(), deadline);
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) throw new ReadCapExceeded(maxBytes);
      chunks.push(chunk.value);
    }
  } catch (error) {
    stop();
    if (error instanceof ReadCapExceeded || error instanceof TrackerNoAnswer) throw error;
    throw deadline.noAnswer();
  } finally {
    deadline.signal.removeEventListener('abort', stop);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

/** An answer read whole: its status, its headers and its body's text. */
export interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/**
 * Makes one call under `deadline` and reads its answer under `maxBytes`. The fetch is called as a plain function, with
 * the deadline's signal, `redirect: 'manual'` (a redirect is answered as it came and never followed, so a token or a
 * bearer reaches Linear's own address alone), and no credentials or referrer of its own. Throws `TrackerNoAnswer` when
 * the call or the reading of its answer fails, is cancelled or passes the deadline, and `ReadCapExceeded` past the cap.
 */
export async function boundedCall(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  deadline: Deadline,
  maxBytes: number,
): Promise<Answer> {
  if (deadline.signal.aborted) throw deadline.noAnswer();
  let response: Response;
  try {
    response = await untilDeadline(
      fetchImpl(input, { ...init, signal: deadline.signal, redirect: 'manual', credentials: 'omit', referrerPolicy: 'no-referrer' }),
      deadline,
      discard,
    );
  } catch (error) {
    if (error instanceof TrackerNoAnswer) throw error;
    throw deadline.noAnswer();
  }
  const bytes = await readUnder(response, maxBytes, deadline);
  return { status: response.status, headers: response.headers, text: new TextDecoder().decode(bytes) };
}

/** An answer's text read as a JSON object; an empty object for any other text, so its fields read as absent. */
export function jsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
