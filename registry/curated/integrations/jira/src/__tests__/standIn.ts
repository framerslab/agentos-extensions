/**
 * @fileoverview Fetch stand-ins for the pack's tests: one that records each request and answers from a route, a JSON
 * answer, a fetch that never answers, a grant store over memory, and the reading of an Atlassian Document Format
 * description back to plain text.
 */

import type { IOAuthTokenStore, OAuthTokenSet } from '@framers/agentos/auth';

/** One request the stand-in received. */
export interface Seen {
  method: string;
  url: string;
  headers: Headers;
  body: string | null;
}

/** A fetch that answers from `route` and records every request. */
export function standIn(route: (request: Seen) => Response | Promise<Response>): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request: Seen = {
      method: init?.method ?? 'GET',
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    seen.push(request);
    return route(request);
  };
  return { fetchImpl, seen };
}

/** A JSON answer. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

/** A fetch that never answers, rejecting with its signal's reason when the signal aborts, as fetch does. */
export const neverAnswers: typeof fetch = async (_input, init) => {
  const signal = init?.signal ?? undefined;
  return new Promise<Response>((_resolve, reject) => {
    if (signal === undefined) return;
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
};

/** A fetch that never settles and ignores its signal, so only the pack's own race can end the wait. */
export const ignoresSignal: typeof fetch = async () => new Promise<Response>(() => undefined);

/** Grants kept in memory by key, the shape the core's `IOAuthTokenStore` asks. */
export class MemoryStore implements IOAuthTokenStore {
  readonly kept = new Map<string, OAuthTokenSet>();

  async load(key: string): Promise<OAuthTokenSet | null> {
    return this.kept.get(key) ?? null;
  }

  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    this.kept.set(key, tokens);
  }

  async clear(key: string): Promise<void> {
    this.kept.delete(key);
  }
}

/** An Atlassian Document Format node, as far as the tests read one. */
interface AdfNode {
  type?: unknown;
  text?: unknown;
  content?: unknown;
}

/**
 * Plain text from an Atlassian Document Format document: its paragraphs a blank line apart, a hard break a line break,
 * each text node's text as it is. Anything that is not a `doc` of paragraphs answers undefined.
 */
export function adfText(document: unknown): string | undefined {
  const doc = document as AdfNode | null;
  if (doc === null || typeof doc !== 'object' || doc.type !== 'doc' || !Array.isArray(doc.content)) return undefined;
  const paragraphs: string[] = [];
  for (const paragraph of doc.content as AdfNode[]) {
    if (paragraph?.type !== 'paragraph') return undefined;
    const inline = paragraph.content === undefined ? [] : paragraph.content;
    if (!Array.isArray(inline)) return undefined;
    let text = '';
    for (const node of inline as AdfNode[]) {
      if (node?.type === 'text' && typeof node.text === 'string') text += node.text;
      else if (node?.type === 'hardBreak') text += '\n';
      else return undefined;
    }
    paragraphs.push(text);
  }
  return paragraphs.join('\n\n');
}
