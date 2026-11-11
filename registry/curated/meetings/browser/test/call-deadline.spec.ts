import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserMeetingProvider } from '../src/BrowserMeetingProvider.js';

// A scheduler that takes the connection and never answers, as a hung process does. Without a deadline each call
// waits for Node's fetch to give up at undici's 300-second headers timeout; with one it fails at the deadline, as a
// refusal fails, so the manager's retry and purge paths take it.

const run = { runId: 'r1', ownerRef: 'a', providerName: 'browser', platform: 'google_meet' as const, state: 'in_call' as const, keep: 'none' as const, meetingUrl: 'https://meet.google.com/abc-defg-hij', botName: 'Notes', notice: { text: 'n', version: '1', lateArrivalText: 's' }, stopPhrase: 'stop', limits: { waitingRoomMs: 1, aloneMs: 1, totalMs: 1 }, requestedAt: 0, joinAt: 0, billedSeconds: 0 };
const dispatchInput = { run, room: { url: 'wss://lk.test', name: 'bot-r1', publishToken: 'jwt' }, workerToken: 'tok-tok-tok-tok-tok', reportUrl: 'https://product.test/events/browser/r1' };

describe('BrowserMeetingProvider: a scheduler that never answers', () => {
  let server: Server;
  let schedulerUrl: string;
  const seen: string[] = [];

  beforeEach(async () => {
    seen.length = 0;
    server = createServer((req) => {
      seen.push(`${req.method} ${req.url}`); // takes the request and never answers it
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    schedulerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const provider = () => new BrowserMeetingProvider({ schedulerUrl, schedulerToken: 'client-credential', workerId: 'w1', startTimeoutMs: 300, callTimeoutMs: 150 });

  /** The time `call` takes to settle and what it rejected with. */
  async function settle(call: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> {
    const start = Date.now();
    try {
      await call();
    } catch (error) {
      return { ms: Date.now() - start, error };
    }
    throw new Error('the call resolved against a scheduler that never answers');
  }

  it('ends a start at its deadline with an ordinary error', async () => {
    const { ms, error } = await settle(() => provider().dispatch(dispatchInput));
    expect(seen).toEqual(['POST /runs']);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('Error');
    expect((error as Error).message).toBe('scheduler did not answer within 300 ms');
    expect(ms).toBeGreaterThanOrEqual(250);
    expect(ms).toBeLessThan(2_000);
  });

  it.each([
    { call: 'command', path: 'POST /runs/r1/command', run: (p: BrowserMeetingProvider) => p.command('r1', { name: 'postChat', text: 'hi' }) },
    { call: 'deleteRun', path: 'DELETE /runs/r1', run: (p: BrowserMeetingProvider) => p.deleteRun({ runId: 'r1' }) },
    { call: 'usage', path: 'GET /runs', run: (p: BrowserMeetingProvider) => p.usage({}) },
  ])('ends $call at the deadline for every other call', async ({ path, run: call }) => {
    const { ms, error } = await settle(() => call(provider()));
    expect(seen).toEqual([path]);
    expect((error as Error).message).toBe('scheduler did not answer within 150 ms');
    expect(ms).toBeLessThan(2_000);
  });

  it('lets a host purge runs one after another without each waiting for the scheduler', async () => {
    const p = provider();
    const start = Date.now();
    for (const runId of ['r1', 'r2', 'r3']) await expect(p.deleteRun({ runId })).rejects.toThrow('scheduler did not answer within 150 ms');
    expect(seen).toEqual(['DELETE /runs/r1', 'DELETE /runs/r2', 'DELETE /runs/r3']);
    expect(Date.now() - start).toBeLessThan(3_000);
  });
});
