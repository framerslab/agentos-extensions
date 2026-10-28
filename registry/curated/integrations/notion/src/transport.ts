/**
 * @fileoverview The bounds every call to Notion runs under: one deadline joined with the caller's signal, a call that
 * stops being waited on once that deadline's signal aborts whatever the fetch does with it, no redirect followed and no
 * credentials or referrer sent by the fetch itself, and an answer read under a byte cap. Each failure is a fixed fault.
 * @module agentos-ext-notion/transport
 */

import { NotionFault } from './faults.js';

/** The hosts a stand-in may answer at over plain HTTP. */
const LOOPBACK: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for an object that is not null, such as an options or input object a caller passes. */
export function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

/** A nonempty credential of bounded length with no whitespace or control character. */
export function credential(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !/[\x00-\x20\x7f]/.test(value);
}

/** True for a loopback host, where plain HTTP serves. */
export function loopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname);
}

/**
 * Throws `configuration` unless `value` is an absolute address with no userinfo and no query or fragment mark (looked
 * for in the string itself, since a URL reads an empty `search` and `hash` for a bare mark), over HTTPS or over plain
 * HTTP at a loopback host. A stand-in's address must also be read on CI (`CI=true`) and be at a loopback or `.invalid`
 * host.
 */
export function checkAddress(value: unknown, standIn: boolean): asserts value is string {
  if (typeof value !== 'string') throw new NotionFault('configuration');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NotionFault('configuration');
  }
  const loopback = loopbackHost(url.hostname);
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  const reserved = loopback || url.hostname.endsWith('.invalid');
  if (url.username !== '' || url.password !== '' || /[?#]/.test(value) || !scheme || (standIn && (process.env.CI !== 'true' || !reserved))) {
    throw new NotionFault('configuration');
  }
}

/** What one call is bounded by. */
export interface CallBounds {
  /** The caller's signal: once it aborts no call starts, and a call under way stops being waited on. */
  readonly signal?: AbortSignal;
  /** How long the call may take, its answer included. */
  readonly timeoutMs: number;
  /** The most bytes read of the answer. */
  readonly maxBytes: number;
  /** Leaves a successful answer's body unread, for a call whose answer the caller does not need. */
  readonly skipSuccessBody?: boolean;
}

/** An answer read whole: its status, headers and text. */
export interface CallAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

/** Cancels an answer's body without waiting, ignoring a failure to. */
function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * Settles as `work` does, or rejects with `stopped()` as soon as `signal` aborts, whichever comes first, even when
 * `work` never settles. A value `work` answers after that is handed to `late`.
 */
function raced<T>(work: Promise<T>, signal: AbortSignal, stopped: () => Error, late: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const abort = (): void => {
      if (done) return;
      done = true;
      reject(stopped());
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (done) {
          late(value);
          return;
        }
        done = true;
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        if (done) return;
        done = true;
        reject(error);
      },
    );
  });
}

/**
 * Makes one call under `bounds` and reads its answer. Throws `NotionFault` with `cancelled` when the caller's signal
 * had aborted before the call (nothing is sent), and once the call has started with `cancelled` or `timeout` when it is
 * stopped, `network` when the call or the reading of its answer fails, and `response_too_large` past the cap.
 */
export async function call(fetchImpl: typeof fetch, url: string, init: RequestInit, bounds: CallBounds): Promise<CallAnswer> {
  const callers = bounds.signal === undefined ? [] : [bounds.signal];
  if (callers.some((caller) => caller.aborted)) throw new NotionFault('cancelled');
  const deadline = AbortSignal.timeout(bounds.timeoutMs);
  const signal = AbortSignal.any([...callers, deadline]);
  const stopped = (): NotionFault => new NotionFault(deadline.aborted ? 'timeout' : 'cancelled');
  let response: Response;
  try {
    response = await raced(
      fetchImpl(url, { ...init, signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }),
      signal,
      stopped,
      discard,
    );
  } catch (error) {
    if (error instanceof NotionFault) throw error;
    throw signal.aborted ? stopped() : new NotionFault('network');
  }
  const { status, headers } = response;
  if (bounds.skipSuccessBody === true && status >= 200 && status <= 299) {
    discard(response);
    return { status, headers, text: '' };
  }
  const declared = Number(headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > bounds.maxBytes) {
    discard(response);
    throw new NotionFault('response_too_large');
  }
  if (response.body === null) return { status, headers, text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await raced(reader.read(), signal, stopped, () => {});
      if (chunk.done) break;
      const bytes = chunk.value as Uint8Array;
      total += bytes.byteLength;
      if (total > bounds.maxBytes) throw new NotionFault('response_too_large');
      chunks.push(bytes);
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof NotionFault) throw error;
    throw signal.aborted ? stopped() : new NotionFault('network');
  }
  return { status, headers, text: Buffer.concat(chunks).toString('utf8') };
}

/** An answer's text read as a JSON object; an empty object for any other text, so its fields read as absent. */
export function jsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isObject(parsed) && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
