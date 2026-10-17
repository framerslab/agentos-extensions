/**
 * @fileoverview The reader's one GET: Google's Calendar API, or on CI alone a stand-in at a loopback or `.invalid`
 * host; a bearer token the host supplies; one deadline over the call, from the wait for its token to the last byte of
 * its answer; the answer read under a size cap; the caller's cancellation, held whether or not the token supplier, the
 * fetch or the body heeds it; and a fixed word for every failure, never Google's text.
 * @module agentos-ext-calendar-google/reader/http
 */

/** Google's Calendar API, version 3. */
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** One deadline over a call, from the wait for its token to the last byte of its answer, by default. */
export const READ_DEADLINE_MS = 10_000;

/** The most bytes read of one answer, by default: a page of 250 events with long descriptions fits. */
export const READ_MAX_BYTES = 8_388_608;

/** Why a read failed, as a fixed word. */
export type CalendarReadFailure = 'configuration' | 'refused' | 'limited' | 'failed' | 'timeout' | 'too_large' | 'cancelled';

/** A read's fixed failure; its message is `calendar_read_<reason>`. */
export class CalendarReadFault extends Error {
  /**
   * @param reason Why the read failed: `refused` for a 401 or a 403 that is not a quota, `limited` for a 429 or a quota's
   * 403, `failed` for any other answer, a network failure or a body that is not JSON, `timeout` past the deadline,
   * `too_large` past the size cap, `cancelled` once the caller aborted, `configuration` for a malformed input.
   * @param status The HTTP status Google answered, when it answered.
   */
  constructor(readonly reason: CalendarReadFailure, readonly status?: number) {
    super(`calendar_read_${reason}`);
    this.name = 'CalendarReadFault';
  }
}

/** The loopback hosts a stand-in may listen on, the only hosts plain HTTP is taken at. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * The API's base address: Google's, or a stand-in's, taken only on CI (`CI=true`) at a loopback or `.invalid` host,
 * with no userinfo, query or fragment, over HTTPS or over plain HTTP at a loopback host. Any other throws
 * `configuration`. Never take it from a request.
 */
export function checkApiAddress(api: string | undefined): string {
  if (api === undefined) return GOOGLE_CALENDAR_API;
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new CalendarReadFault('configuration');
  }
  const loopback = LOOPBACK.has(url.hostname);
  const reserved = loopback || url.hostname.endsWith('.invalid');
  const scheme = url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  if (process.env.CI !== 'true' || !reserved || !scheme || url.username !== '' || url.password !== '' || /[?#]/.test(api)) {
    throw new CalendarReadFault('configuration');
  }
  return api.replace(/\/+$/, '');
}

/**
 * Settles as `work` settles, or, the moment `signal` aborts first, rejects with the signal's reason, as fetch does,
 * whether or not the work heeds the signal. A value the work gives after that goes to `drop`, so it can be let go, and
 * a later failure of the work is ignored.
 */
export function raceSignal<T>(work: Promise<T>, signal: AbortSignal, drop?: (late: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      reject(signal.reason);
    };
    void work.then(
      (value) => {
        signal.removeEventListener('abort', stop);
        if (!stopped) {
          resolve(value);
          return;
        }
        try {
          drop?.(value);
        } catch {
          // Letting a late value go changes nothing of the read that stopped.
        }
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop);
        reject(error);
      },
    );
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

/** Lets go of an answer no one reads: its body is cancelled, so the connection under it is freed. */
export function discardBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

/**
 * An answer's body read whole under `maxBytes`; past it the stream is cancelled and `too_large` thrown. Once `signal`
 * aborts, before the reading or during it, the stream is cancelled and the signal's reason thrown, whether or not the
 * stream heeds the cancellation: a body cut short is never answered as a whole one.
 */
export async function readCappedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (response.body === null) {
    signal?.throwIfAborted();
    return new Uint8Array(0);
  }
  const reader = response.body.getReader();
  const release = (): void => {
    void reader.cancel().catch(() => {});
  };
  // A stop cancels the stream at once, even while a read waits on a body that never comes.
  signal?.addEventListener('abort', release, { once: true });
  let whole = false;
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await (signal === undefined ? reader.read() : raceSignal(reader.read(), signal));
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new CalendarReadFault('too_large');
      chunks.push(value);
    }
    // A stream the stop cancelled reads as ended, so the stop is read again here: its bytes are not the whole body.
    signal?.throwIfAborted();
    whole = true;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    signal?.removeEventListener('abort', release);
    // A body left unread, past the cap, at a stop or on a failure, is cancelled so its connection is freed.
    if (!whole) release();
  }
}

/** The reasons of a 403 that mean a quota or a rate, not a refusal (Google's standard error reasons). */
const LIMIT_REASONS: ReadonlySet<string> = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);

/** True when Google's error body names a quota or a rate among its reasons. */
export function namesALimit(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return false;
  const errors = (error as { errors?: unknown }).errors;
  return Array.isArray(errors) && errors.some((entry) => typeof entry === 'object' && entry !== null && LIMIT_REASONS.has(String((entry as { reason?: unknown }).reason)));
}
