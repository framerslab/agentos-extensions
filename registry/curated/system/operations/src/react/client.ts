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

/** `base` and `path` joined with one slash between them. */
export const joinPath = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;

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

/** Reads `url` as JSON through the client; a refusal answers its word, a failed read or a body that is not JSON answers `failed`. */
export async function readJson<T>(client: OpsClient, url: string, init?: RequestInit): Promise<JsonAnswer<T>> {
  let response: Response;
  try {
    response = await client.fetch(url, { ...init, headers: { Accept: 'application/json', ...(init?.headers as Record<string, string> | undefined) } });
  } catch {
    return { error: 'failed', status: 0 };
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const word = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : 'failed';
    return { error: word, status: response.status };
  }
  return { data: body as T };
}

/** One frame of an event stream: a comment, or an event with its id, name and data text. */
export type SseFrame = { readonly comment: string } | { readonly id: string | null; readonly event: string; readonly data: string };

/** Splits event-stream text into frames as it arrives; `push` answers the frames complete so far and keeps the rest. */
export class SseParser {
  private buffered = '';

  push(text: string): SseFrame[] {
    this.buffered += text.replace(/\r\n/g, '\n');
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
