/**
 * @fileoverview The reader's one GET: Google's Calendar API, or on CI alone a stand-in at a loopback or `.invalid`
 * host; a bearer token the host supplies; one deadline over the call and the reading of its answer; the answer read
 * under a size cap; the caller's cancellation; and a fixed word for every failure, never Google's text.
 * @module agentos-ext-calendar-google/reader/http
 */

/** Google's Calendar API, version 3. */
export const GOOGLE_CALENDAR_API = 'https://www.googleapis.com/calendar/v3';

/** One deadline over a call and the reading of its answer, by default. */
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

/** An answer's body read whole under `maxBytes`; past it the stream is cancelled and `too_large` thrown. */
export async function readCappedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => {});
      throw new CalendarReadFault('too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
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
