import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import net, { type AddressInfo } from 'node:net';

// What the tests share: a server on the loopback address that serves synthetic pages, and a guard that refuses and
// records every connection and every fetch to any other host. Nothing here names a real person or a real site.

/** One request as the fixture server received it. */
export interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** The fixture server: its origin, the requests it received, and how to stop it. */
export interface FixtureServer {
  origin: string;
  received: Received[];
  close(): Promise<void>;
}

/** A page with the claim's words as they stand, one of them in a table cell. */
export const VERBATIM_PAGE = [
  '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Harbour report</title></head><body>',
  '<nav><a href="/">Home</a></nav>',
  '<article><h1>Harbour report</h1>',
  '<p>The harbour opened in 1887 and handled 4,200 ships in its first year. Its lighthouse stands 31 metres tall.</p>',
  '<table><tr><th>Berths</th><td>Twelve berths serve cargo ships.</td></tr></table>',
  '</article></body></html>',
].join('');

/** The same words with typographic quotes, dashes, capitals, a non-breaking space and a soft hyphen. */
export const TYPOGRAPHIC_PAGE =
  '<html><body><p>The KEEPER’S log calls it the bright&shy;est light&nbsp;on the coast — a claim repeated in 1902–1903.</p></body></html>';

/** Five sentences that share some words with a claim and none of its phrasing. */
export const PARAPHRASE_PAGE = [
  '<html><body>',
  '<p>The harbour handled many ships.</p>',
  '<p>Ships arrived in the first year.</p>',
  '<p>The harbour is old.</p>',
  '<p>Fishing boats leave before dawn.</p>',
  '<p>Its first year was busy.</p>',
  '</body></html>',
].join('');

/** A page with no text a reader sees. */
export const EMPTY_PAGE = '<html><head><title>Nothing here</title></head><body><script>var shown = false;</script></body></html>';

/** What the fake embeddings endpoint answers for every input: one vector, so every claim is as near as can be. */
export const FAKE_EMBEDDING = [0.6, 0.8, 0];

/** Starts the fixture server on 127.0.0.1 and a free port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  const received: Received[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const path = request.url ?? '/';
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: request.method ?? 'GET', path, headers: request.headers, body });
      const { pathname } = new URL(path, 'http://127.0.0.1');
      const html = (status: number, text: string, type = 'text/html; charset=utf-8'): void => {
        response.writeHead(status, { 'content-type': type });
        response.end(text);
      };
      switch (pathname) {
        case '/verbatim':
          return html(200, VERBATIM_PAGE);
        case '/typographic':
          return html(200, TYPOGRAPHIC_PAGE);
        case '/paraphrase':
          return html(200, PARAPHRASE_PAGE);
        case '/empty':
          return html(200, EMPTY_PAGE);
        case '/missing':
          return html(404, '<p>Not found.</p>');
        case '/moved':
          response.writeHead(302, { location: '/verbatim' });
          return response.end();
        case '/latin1':
          // "Café crème served daily." in ISO-8859-1: é is 0xE9, è is 0xE8.
          response.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
          return response.end(Buffer.concat([Buffer.from('<p>Caf'), Buffer.from([0xe9]), Buffer.from(' cr'), Buffer.from([0xe8]), Buffer.from('me served daily.</p>')]));
        case '/notes.txt':
          return html(200, 'First paragraph of plain notes.\n\nThe archive keeps letters from 1850 onward.\n', 'text/plain; charset=utf-8');
        case '/report.pdf':
          return html(200, '%PDF-1.4\n% synthetic\n', 'application/pdf');
        case '/slow': {
          const timer = setTimeout(() => html(200, '<p>Late.</p>'), 3_000);
          response.on('close', () => clearTimeout(timer));
          return;
        }
        case '/v1/embeddings': {
          // The OpenAI embeddings contract: `input` in, one `data` entry per input with its index, and the usage.
          const parsed = JSON.parse(body || '{}') as { input?: string | string[] };
          const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input ?? ''];
          response.writeHead(200, { 'content-type': 'application/json' });
          return response.end(
            JSON.stringify({
              object: 'list',
              data: inputs.map((_input, index) => ({ object: 'embedding', index, embedding: FAKE_EMBEDDING })),
              model: 'fixture-embedding',
              usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
            }),
          );
        }
        default:
          return html(404, '<p>Not found.</p>');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    received,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The hosts the guard lets a test reach: the loopback address the fixture server listens on. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Every attempt to reach another host since the guard was set, in order; a test that expects none checks it is empty. */
export const outsideAttempts: string[] = [];

/** The host a `Socket.connect` call names, or null for a local IPC path. */
function connectHost(args: unknown[]): string | null {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === 'string') return null;
    return typeof options.host === 'string' ? options.host : 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/u.test(first)) return null;
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}

/**
 * Refuses every TCP connection and every `fetch` to a host other than the loopback address, recording each attempt in
 * {@link outsideAttempts}; a refused connection fails on the next tick, as a refused connection does. Answers the
 * function that puts the originals back.
 */
export function guardNetwork(): () => void {
  const connect = net.Socket.prototype.connect;
  const fetchBefore = globalThis.fetch;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const host = connectHost(args);
    if (host !== null && !LOCAL_HOSTS.has(host)) {
      outsideAttempts.push(`connection to ${host}`);
      process.nextTick(() => this.destroy(new Error('network access outside the fixture server is blocked')));
      return this;
    }
    return (connect as (...rest: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (!LOCAL_HOSTS.has(url.hostname)) {
      outsideAttempts.push(`fetch ${url.origin}`);
      throw new TypeError('network access outside the fixture server is blocked');
    }
    return fetchBefore(input, init);
  }) as typeof fetch;
  return () => {
    net.Socket.prototype.connect = connect;
    globalThis.fetch = fetchBefore;
  };
}
