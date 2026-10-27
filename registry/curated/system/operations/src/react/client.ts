/**
 * @fileoverview What the hooks share (D39): the product's `fetch` with the base path its support
 * routes live under, the shape every read answers, and the readers of a JSON answer and of a
 * `text/event-stream` body. The hooks add no cookie, header or address of their own: the product's
 * `fetch` carries its sign-in (D4).
 */

/** The product's fetch and the base path of its support routes, without a trailing slash: `/api/v1/support` for the person's, the admin's path for staff's. */
export interface OpsClient {
  readonly fetch: typeof fetch;
  readonly base: string;
}

/** What a reading hook answers: the data once read, the refusal's word or `failed` when the read failed, whether a read is in flight, and a function that reads again. */
export interface OpsRead<T> {
  readonly data: T | null;
  readonly error: string | null;
  readonly loading: boolean;
  refresh(): Promise<void>;
}

/** `base` and `path` joined with one slash between them, whichever side carries it. */
export const joinPath = (base: string, path: string): string => `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;

/** A query string from `params`, the undefined and empty values left out; empty when nothing is left. */
export function queryOf(params: Readonly<Record<string, string | number | undefined>>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return pairs.length === 0 ? '' : `?${pairs.join('&')}`;
}

/** A JSON read's answer: the data, or the refusal's word (`{ error }` as `./http` answers it) with its status. */
export type JsonAnswer<T> = { readonly data: T } | { readonly error: string; readonly status: number };

/**
 * Reads `url` as JSON through the client: a refusal answers its word with its status, a read that
 * throws or a 2xx whose body is not JSON answers `failed` (with the status, 0 for a throw), and a
 * 204 or 205 answers `data: null`. The caller's headers go through in any form `fetch` takes (a
 * record, a `Headers`, pairs), with `Accept: application/json` added when the caller set none.
 */
export async function readJson<T>(client: OpsClient, url: string, init?: RequestInit): Promise<JsonAnswer<T>> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Accept')) headers.set('Accept', 'application/json');
  let response: Response;
  try {
    response = await client.fetch(url, { ...init, headers });
  } catch {
    return { error: 'failed', status: 0 };
  }
  if (response.status === 204 || response.status === 205) return { data: null as unknown as T };
  let body: unknown = null;
  let parsed = false;
  try {
    body = await response.json();
    parsed = true;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const word = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : 'failed';
    return { error: word, status: response.status };
  }
  // A 2xx whose body is not JSON is a failed read, never data.
  if (!parsed) return { error: 'failed', status: response.status };
  return { data: body as T };
}

/** One frame of an event stream: a comment, or an event with its id, name and data text. */
export type SseFrame = { readonly comment: string } | { readonly id: string | null; readonly event: string; readonly data: string };

/**
 * Splits event-stream text into frames as it arrives; `push` answers the frames complete so far and
 * keeps the rest. A line ends at a line feed, a carriage return, or the pair, as the format allows,
 * and the chunks need not split at line ends: a carriage return that ends one chunk ends its line
 * at once, and a line feed that opens the next chunk is the pair's second half, no line of its own,
 * so a frame split across two chunks is neither merged into the frame before it nor lost.
 */
export class SseParser {
  private buffered = '';
  /** Whether the last chunk ended with a carriage return, whose line feed may open the next chunk. */
  private pendingCr = false;

  push(text: string): SseFrame[] {
    const chunk = this.pendingCr && text.startsWith('\n') ? text.slice(1) : text;
    this.pendingCr = chunk.endsWith('\r');
    this.buffered += chunk.replace(/\r\n|\r/g, '\n');
    const frames: SseFrame[] = [];
    for (;;) {
      const end = this.buffered.indexOf('\n\n');
      if (end === -1) return frames;
      const raw = this.buffered.slice(0, end);
      this.buffered = this.buffered.slice(end + 2);
      if (raw.length === 0) continue;
      if (raw.startsWith(':')) {
        frames.push({ comment: raw.slice(1).trim() });
        continue;
      }
      let id: string | null = null;
      let event = 'message';
      const data: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      frames.push({ id, event, data: data.join('\n') });
    }
  }
}

/** Whether the page is visible: true where there is no document (a test, a worker), and whenever the document does not say `hidden` (D14). */
export function pageVisible(): boolean {
  const doc = (globalThis as { document?: { visibilityState?: string } }).document;
  return doc === undefined || doc.visibilityState !== 'hidden';
}
