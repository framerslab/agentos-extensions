import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One post the product received, with the status it answered. */
export interface ReceivedPost {
  path: string;
  headers: IncomingHttpHeaders;
  /** The JSON body, or the text when it is not JSON. */
  body: any;
  status: number;
}

/**
 * The product's events route for the scheduler's tests: a `node:http` server that records every POST (its headers and
 * its JSON body) and answers 204, or the statuses queued in `answers`, in order.
 */
export class FakeProduct {
  /** Every post, in the order it arrived. */
  readonly received: ReceivedPost[] = [];
  /** Statuses for the next posts, used up in order; 204 when it is empty. */
  readonly answers: number[] = [];
  private server: Server | undefined;
  private port = 0;
  private readonly waiters = new Set<() => void>();

  /** Where the scheduler posts the reports. */
  get url(): string {
    return `http://127.0.0.1:${this.port}/events`;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = text;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          // kept as text
        }
        const status = this.answers.shift() ?? 204;
        this.received.push({ path: req.url ?? '/', headers: req.headers, body, status });
        res.writeHead(status);
        res.end();
        for (const waiter of [...this.waiters]) waiter();
      });
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.port = (server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Resolves once `n` posts have arrived. */
  async waitFor(n: number, timeoutMs = 5_000): Promise<void> {
    await this.until(() => (this.received.length >= n ? true : undefined), timeoutMs, `${n} posts`);
  }

  /** Resolves with the first post of this event for this run, once it has arrived. */
  waitForEvent(runId: string, event: string, timeoutMs = 5_000): Promise<ReceivedPost> {
    return this.until(() => this.received.find((p) => p.body?.runId === runId && p.body?.event === event), timeoutMs, `${event} for ${runId}`);
  }

  /** What arrived, as run, sequence, event and status: no content. */
  summary(): string {
    return JSON.stringify(this.received.map((p) => [p.body?.runId, p.body?.seq, p.body?.event, p.status]));
  }

  private until<T>(check: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
    const now = check();
    if (now !== undefined) return Promise.resolve(now);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`the product did not receive ${what} within ${timeoutMs} ms; it received ${this.summary()}`));
      }, timeoutMs);
      const waiter = (): void => {
        const value = check();
        if (value === undefined) return;
        this.waiters.delete(waiter);
        clearTimeout(timer);
        resolve(value);
      };
      this.waiters.add(waiter);
    });
  }
}
