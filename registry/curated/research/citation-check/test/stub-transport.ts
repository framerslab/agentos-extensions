import type { Transport, TransportRules } from '../src/index';

// A transport that answers from a table and counts every request it is asked for, so a test can say a page was never
// requested. It follows no redirect and applies no rule of its own: whatever rule a test proves is applied before the
// request reaches it.

/** What the stub answers for one address. */
export interface StubAnswer {
  status: number;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

/** One request as the stub received it. */
export interface StubCall {
  url: string;
  rules: TransportRules | undefined;
}

/** A stub transport and the requests it received, in order. */
export interface StubTransport {
  transport: Transport;
  calls: StubCall[];
  /** The addresses requested, in order. */
  urls(): string[];
}

/**
 * A transport that answers each address with `answer(url)`: an answer, or an error the request fails with. A missing
 * answer is a 404.
 */
export function stubTransport(answer: (url: string) => StubAnswer | Error | undefined): StubTransport {
  const calls: StubCall[] = [];
  const transport: Transport = async (url, signal, rules) => {
    signal.throwIfAborted();
    calls.push({ url, rules });
    const spec = answer(url) ?? { status: 404, body: 'Not found.' };
    if (spec instanceof Error) throw spec;
    const bytes = typeof spec.body === 'string' ? Buffer.from(spec.body, 'utf8') : (spec.body ?? new Uint8Array(0));
    const headers = new Map(Object.entries(spec.headers ?? { 'content-type': 'text/html; charset=utf-8' }).map(([name, value]) => [name.toLowerCase(), value]));
    return {
      status: spec.status,
      finalUrl: url,
      header: (name: string) => headers.get(name.toLowerCase()) ?? null,
      read: async (cap: number) => (bytes.byteLength > cap ? null : bytes),
      readPrefix: async (cap: number) => bytes.subarray(0, cap),
      discard: async () => undefined,
    };
  };
  return { transport, calls, urls: () => calls.map((call) => call.url) };
}

/** An HTML page with the given head and body. */
export function htmlPage(head: string, body: string): StubAnswer {
  return { status: 200, body: `<!DOCTYPE html><html><head>${head}</head><body>${body}</body></html>`, headers: { 'content-type': 'text/html; charset=utf-8' } };
}
