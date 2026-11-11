/**
 * @fileoverview GitHub on the loopback address, for the tests of the calls made on a person's own token: an HTTP
 * server that records each request it receives and answers from a route. The calls under test reach it through the
 * runtime's own `fetch`, so the headers, bodies, redirects and deadlines they are tested with are the ones a request
 * to GitHub carries. It also keeps what a test printed, so each test can show that no token reached a log.
 */

import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

/** One request the stand-in received. */
export interface Received {
  method: string;
  /** The address's path, without its query. */
  path: string;
  /** The address's query. */
  query: URLSearchParams;
  /** The request target as it was sent: the path and the query. */
  target: string;
  /** The request's headers, their names in lower case, as Node reads them. */
  headers: IncomingHttpHeaders;
  /** The request's body as text; empty when it had none. */
  body: string;
}

/**
 * What the stand-in answers: a status, headers and a body (anything but a string is sent as JSON), or `hang` to never
 * answer. With `cut`, the status, the headers and the body's text are sent and the body then never ends (`stall`) or
 * its connection is dropped once they are written (`drop`).
 */
export type Answer = { status: number; headers?: Record<string, string>; body?: unknown; cut?: 'stall' | 'drop' } | 'hang';

/** A running stand-in. */
export interface GitHubStandIn {
  /** The stand-in's address, `http://127.0.0.1:<port>`: the API base, and the origin of its token address. */
  base: string;
  /** Every request received, in the order they arrived. */
  received: Received[];
  /** The most requests the stand-in was answering at one time. */
  peak(): number;
  /** Stops the server and ends every connection still open, a request left unanswered included. */
  close(): Promise<void>;
}

/**
 * Starts a stand-in that answers each request from `route`, which is handed the request and the stand-in's own
 * address (for a `Link` header or a redirect that names it).
 */
export async function startGitHub(route: (request: Received, base: string) => Answer | Promise<Answer>): Promise<GitHubStandIn> {
  const received: Received[] = [];
  let base = '';
  let active = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const address = new URL(req.url ?? '/', base);
      const request: Received = {
        method: req.method ?? 'GET',
        path: address.pathname,
        query: address.searchParams,
        target: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(request);
      active += 1;
      peak = Math.max(peak, active);
      void Promise.resolve()
        .then(() => route(request, base))
        .then((answer) => {
          if (answer === 'hang') return;
          const text = answer.body === undefined || typeof answer.body === 'string';
          res.writeHead(answer.status, { ...(text ? {} : { 'content-type': 'application/json; charset=utf-8' }), ...answer.headers });
          const payload = answer.body === undefined ? '' : typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
          const { cut } = answer;
          if (cut === undefined) {
            res.end(payload);
            return;
          }
          // The headers and what there is of the body go out now; the body's end never does.
          res.flushHeaders();
          res.write(payload, () => {
            if (cut === 'drop') res.socket?.destroy();
          });
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        })
        .finally(() => {
          active -= 1;
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    received,
    peak: () => peak,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Settles after `ms` milliseconds: an answer held back, so requests made at once would overlap at the stand-in. */
export function pause(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** What a test printed while it ran, and the way to hand the console and the output streams back. */
export interface OutputWatch {
  /** Everything printed since the watch began: console calls and writes to stdout and stderr. */
  printed(): string;
  /** Hands the console and the output streams back. */
  restore(): void;
}

/** Keeps every console call and every write to stdout and stderr until `restore`, printing none of them. */
export function watchOutput(): OutputWatch {
  const lines: string[] = [];
  const keep = (...parts: unknown[]): void => {
    lines.push(parts.map((part) => (part instanceof Error ? `${part.name}: ${part.message}` : typeof part === 'string' ? part : JSON.stringify(part))).join(' '));
  };
  const write = (chunk: string | Uint8Array): boolean => {
    lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(keep),
    vi.spyOn(console, 'info').mockImplementation(keep),
    vi.spyOn(console, 'warn').mockImplementation(keep),
    vi.spyOn(console, 'error').mockImplementation(keep),
    vi.spyOn(console, 'debug').mockImplementation(keep),
    vi.spyOn(process.stdout, 'write').mockImplementation(write),
    vi.spyOn(process.stderr, 'write').mockImplementation(write),
  ];
  return {
    printed: () => lines.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** Everything of a request a token could sit in: its target, its headers and its body, as one text. */
export function wholeRequest(request: Received): string {
  return `${request.method} ${request.target}\n${JSON.stringify(request.headers)}\n${request.body}`;
}

/** How many times `text` holds `part`. */
export function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}
