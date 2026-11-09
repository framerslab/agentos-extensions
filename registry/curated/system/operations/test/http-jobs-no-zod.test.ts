/**
 * `./http` where the host has not installed `zod`, an optional peer: the entry imports, a read
 * answers, and a pause answers 500 naming the missing peer, never cached, without asking the
 * scheduler. Its own file, since `zod` once loaded is kept for the module's life.
 */
import { describe, expect, it, vi } from 'vitest';
import type { OpsHandlersOptions, OpsJobsScheduler } from '../src/contract.js';

vi.mock('zod', () => {
  throw new Error("Cannot find package 'zod'");
});

describe('the jobs handlers where zod is not installed', () => {
  it('the entry imports, a read answers, and a pause answers 500 naming the missing peer, never cached, and the scheduler is not asked', async () => {
    const { createHandlers } = await import('../src/http/index.js');
    const calls: string[] = [];
    const scheduler: OpsJobsScheduler = {
      list: async () => ({ jobs: [], cursor: null }),
      get: async (name) => (calls.push(`get ${name}`), { name }),
      runs: async () => [],
      missed: async () => [],
      pause: async (name) => (calls.push(`pause ${name}`), { name }),
      resume: async (name) => (calls.push(`resume ${name}`), { name }),
      runNow: async () => ({ queued: true }),
    };
    const options: OpsHandlersOptions = {
      auth: { person: async () => null, staff: async () => ({ accountId: 'acct_1', role: 'owner' }) },
      operations: { alerts: { post: async () => null, list: async () => [], sendDue: async () => ({ sent: 0, retried: 0, failed: 0, dropped: 0 }) } },
      scheduler,
      changes: async () => [],
    };
    const { jobs } = createHandlers(options);

    const listed = await jobs.list(new Request('https://admin.example.invalid/jobs'), {});
    expect(listed.status).toBe(200);

    const paused = await jobs.pause(new Request('https://admin.example.invalid/jobs/e_ok/pause', { method: 'POST', body: JSON.stringify({ note: 'waiting' }) }), { name: 'e_ok' });
    expect(paused.status).toBe(500);
    expect(paused.headers.get('cache-control')).toBe('no-store');
    expect(await paused.json()).toEqual({ error: 'missing_peer', status: 500, peer: 'zod' });
    expect(calls).toEqual([]);

    // The commands that read no body need no zod.
    const resumed = await jobs.resume(new Request('https://admin.example.invalid/jobs/e_ok/resume', { method: 'POST' }), { name: 'e_ok' });
    expect(resumed.status).toBe(200);
    expect(calls).toEqual(['resume e_ok']);
  });
});
