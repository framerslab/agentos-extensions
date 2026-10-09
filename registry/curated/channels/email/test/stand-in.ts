/**
 * @fileoverview A stand-in for Resend's `POST /emails` on a loopback port, for the transport's specs: it keeps each
 * request's headers and JSON body, answers 200 with an id, and lets a spec queue the next answer or a delay.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request the stand-in took: the headers a spec reads and the JSON body. */
export interface Received {
  authorization: string | undefined;
  idempotencyKey: string | undefined;
  userAgent: string | undefined;
  contentType: string | undefined;
  body: Record<string, unknown>;
}

/** The next request's answer: a status with a body (JSON unless it is a string) and headers, or a delay before the usual 200. */
export type Queued = { status: number; body: unknown; headers?: Record<string, string> } | { delayMs: number };

/** The running stand-in. */
export interface ResendStandIn {
  /** The origin to give the transport as its base URL. */
  url: string;
  /** Every `POST /emails` it took, in order. */
  received: Received[];
  /** Queues the answer to the next request. */
  queue(answer: Queued): void;
  /** Stops it and drops its connections. */
  close(): Promise<void>;
}

/** One request header's value when it came once. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/** A request's body, read whole. */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Writes an answer: a string body as it is, anything else as JSON. */
function answer(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/** Starts the stand-in on 127.0.0.1 on a free port. */
export async function startResendStandIn(): Promise<ResendStandIn> {
  const received: Received[] = [];
  const queued: Queued[] = [];
  let accepted = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const raw = await bodyOf(request);
      if (request.method !== 'POST' || request.url !== '/emails') {
        answer(response, 404, { statusCode: 404, name: 'not_found', message: 'The requested endpoint does not exist.' });
        return;
      }
      received.push({
        authorization: header(request, 'authorization'),
        idempotencyKey: header(request, 'idempotency-key'),
        userAgent: header(request, 'user-agent'),
        contentType: header(request, 'content-type'),
        body: JSON.parse(raw) as Record<string, unknown>,
      });
      const next = queued.shift();
      if (next !== undefined && 'status' in next) {
        answer(response, next.status, next.body, next.headers);
        return;
      }
      if (next !== undefined) await new Promise((resolve) => setTimeout(resolve, next.delayMs));
      accepted += 1;
      if (!response.destroyed) answer(response, 200, { id: `email_${accepted}` });
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    queue: (next) => {
      queued.push(next);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
