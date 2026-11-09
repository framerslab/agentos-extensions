// @vitest-environment jsdom
/**
 * `./react`'s jobs hooks over a stub `fetch`: `useJobs` reads the list once and again every 30
 * seconds while the page is visible, keeps the rows through a failed read, says when it last read,
 * whether a read runs, whether the connection is away, the refusal's word and a 401's sign-out, and
 * stops after 15 minutes without a successful read; `useJob` reads a job's page the same way and
 * pauses, resumes and runs it by POST, replacing the job only from the server's answer.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_GIVE_UP_MS, JOBS_POLL_MS, useJob, useJobs, type OpsClient } from '../src/react/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const BASE = '/api/v1/admin/jobs';
const COUNTS = { total: 2, failed: 1, stalled: 0, missed24h: 0, paused: 0, attention: 1 };
const JOB_OK = { name: 'ticket_routing', state: 'ok', paused: null, handRun: null };
const JOB_FAILED = { name: 'ops_sweep', state: 'failed', paused: null, handRun: null };
const PAGE = { jobs: [JOB_FAILED, JOB_OK], cursor: null, counts: COUNTS };
const JOB_PAGE = { job: JOB_OK, runs: [], missed: [], alerts: [], changes: [], kept: { runs: 100, alerts: 50, changes: 50 } };

const roots: Root[] = [];

/** Renders `use` inside a component and answers its latest result. */
function renderHook<T>(use: () => T): { readonly current: () => T; unmount(): void } {
  let latest!: T;
  function Probe(): ReactNode {
    latest = use();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe />));
  return {
    current: () => latest,
    unmount: () => act(() => root.unmount()),
  };
}

/** Moves the fake timers (and the fake clock) on by `ms`, flushing React. */
async function pass(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

/** An answer of `status` whose body reads as `body`; its body settles in microtasks alone, so the fake timers hold nothing back. */
const json = (body: unknown, status = 200): Response => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

/** A promise and the function that settles it. */
function deferred<T>(): { readonly promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

let visibility: 'visible' | 'hidden' = 'visible';

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
  vi.restoreAllMocks();
});

describe('useJobs', () => {
  it('polls every 30 seconds and gives up after 15 minutes', () => {
    expect(JOBS_POLL_MS).toBe(30_000);
    expect(JOBS_GIVE_UP_MS).toBe(15 * 60_000);
  });

  it('reads the list once under its filter and exposes the jobs, the counts, the cursor and the time it read', async () => {
    const calls: string[] = [];
    const client: OpsClient = {
      fetch: async (input) => {
        calls.push(String(input));
        return json(PAGE);
      },
      base: BASE,
    };
    const hook = renderHook(() => useJobs(client, { state: 'attention', process: 'sweeper' }));
    expect(hook.current()).toMatchObject({ jobs: null, counts: null, updatedAt: null, updating: true });
    await pass(0);
    expect(calls).toEqual([`${BASE}?state=attention&process=sweeper`]);
    expect(hook.current()).toMatchObject({ jobs: PAGE.jobs, counts: COUNTS, cursor: null, updatedAt: NOW, updating: false, offline: false, error: null, signedOut: false, stale: false });
  });

  it('reads <base> with no query and no slash when the filter is empty', async () => {
    const calls: string[] = [];
    const client: OpsClient = { fetch: async (input) => (calls.push(String(input)), json(PAGE)), base: `${BASE}/` };
    renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(calls).toEqual([BASE]);
  });

  it('a 401 sets signedOut and no error', async () => {
    const client: OpsClient = { fetch: async () => json({ error: 'signed_out' }, 401), base: BASE };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(hook.current()).toMatchObject({ signedOut: true, error: null, offline: false, jobs: null, updatedAt: null, updating: false });
  });

  it('a network failure sets error and offline and keeps the last rows; a refusal sets its word; the next read clears both', async () => {
    let answer: 'ok' | 'throw' | 'refuse' = 'ok';
    const client: OpsClient = {
      fetch: async () => {
        if (answer === 'throw') throw new TypeError('the network is away');
        if (answer === 'refuse') return json({ error: 'unavailable' }, 503);
        return json(PAGE);
      },
      base: BASE,
    };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(hook.current().jobs).toEqual(PAGE.jobs);

    answer = 'throw';
    await pass(JOBS_POLL_MS);
    expect(hook.current()).toMatchObject({ jobs: PAGE.jobs, counts: COUNTS, updatedAt: NOW, error: 'failed', offline: true, signedOut: false, updating: false });

    answer = 'refuse';
    await pass(JOBS_POLL_MS);
    expect(hook.current()).toMatchObject({ jobs: PAGE.jobs, updatedAt: NOW, error: 'unavailable', offline: false });

    answer = 'ok';
    await pass(JOBS_POLL_MS);
    expect(hook.current()).toMatchObject({ jobs: PAGE.jobs, updatedAt: NOW + 3 * JOBS_POLL_MS, error: null, offline: false });
  });

  it('reads again every 30 seconds while the page is visible, none while it is hidden, and once at once when it shows', async () => {
    let reads = 0;
    const client: OpsClient = { fetch: async () => (reads += 1, json(PAGE)), base: BASE };
    renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(reads).toBe(1);
    await pass(JOBS_POLL_MS - 1);
    expect(reads).toBe(1);
    await pass(1);
    expect(reads).toBe(2);
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await pass(4 * JOBS_POLL_MS);
    expect(reads).toBe(2);
    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await pass(0);
    expect(reads).toBe(3);
    await pass(JOBS_POLL_MS);
    expect(reads).toBe(4);
  });

  it('while the browser says offline it reads nothing and says so, and reads at once when the connection returns', async () => {
    let reads = 0;
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const client: OpsClient = { fetch: async () => (reads += 1, json(PAGE)), base: BASE };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(reads).toBe(1);
    online = false;
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(hook.current()).toMatchObject({ offline: true, jobs: PAGE.jobs });
    await pass(3 * JOBS_POLL_MS);
    expect(reads).toBe(1);
    expect(hook.current().offline).toBe(true);
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await pass(0);
    expect(reads).toBe(2);
    expect(hook.current()).toMatchObject({ offline: false, error: null });
  });

  it('stops reading after 15 minutes without a successful read, and says the list is stale', async () => {
    let reads = 0;
    const client: OpsClient = { fetch: async () => (reads += 1, json({ error: 'unavailable' }, 503)), base: BASE };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(reads).toBe(1);
    for (let i = 0; i < JOBS_GIVE_UP_MS / JOBS_POLL_MS - 1; i += 1) await pass(JOBS_POLL_MS);
    expect(hook.current().stale).toBe(false);
    await pass(JOBS_POLL_MS);
    // The read at 15 minutes failed too: 31 reads, and none after.
    expect(reads).toBe(1 + JOBS_GIVE_UP_MS / JOBS_POLL_MS);
    expect(hook.current()).toMatchObject({ stale: true, error: 'unavailable' });
    await pass(20 * JOBS_POLL_MS);
    expect(reads).toBe(1 + JOBS_GIVE_UP_MS / JOBS_POLL_MS);
  });
});

describe('useJob', () => {
  it("reads the job's page once and polls it", async () => {
    const calls: string[] = [];
    const client: OpsClient = { fetch: async (input) => (calls.push(String(input)), json(JOB_PAGE)), base: BASE };
    const hook = renderHook(() => useJob(client, 'ticket_routing'));
    await pass(0);
    expect(calls).toEqual([`${BASE}/ticket_routing`]);
    expect(hook.current()).toMatchObject({ page: JOB_PAGE, job: JOB_OK, updatedAt: NOW, updating: false, acting: null, error: null });
    await pass(JOBS_POLL_MS);
    expect(calls).toHaveLength(2);
  });

  it('pause(note), resume() and runNow() POST and replace the job from the answer only, never before it', async () => {
    const posts: Array<{ url: string; method: string; body: string | null; type: string | null }> = [];
    const answers = new Map<string, ReturnType<typeof deferred<Response>>>();
    const client: OpsClient = {
      fetch: async (input, init) => {
        const url = String(input);
        if ((init?.method ?? 'GET') === 'GET') return json(JOB_PAGE);
        posts.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null, type: new Headers(init?.headers).get('content-type') });
        const held = deferred<Response>();
        answers.set(url.slice(url.lastIndexOf('/') + 1), held);
        return held.promise;
      },
      base: BASE,
    };
    const hook = renderHook(() => useJob(client, 'ticket_routing'));
    await pass(0);

    const paused = { ...JOB_OK, state: 'paused', paused: { by: 'acct_1', at: NOW, note: 'waiting' } };
    let pausing!: Promise<unknown>;
    await act(async () => {
      pausing = hook.current().pause('waiting');
    });
    expect(posts).toEqual([{ url: `${BASE}/ticket_routing/pause`, method: 'POST', body: JSON.stringify({ note: 'waiting' }), type: 'application/json' }]);
    // Until the server answers, the job is as last read.
    expect(hook.current()).toMatchObject({ acting: 'pause', job: JOB_OK });
    await act(async () => {
      answers.get('pause')!.resolve(json(paused));
      await pausing;
    });
    await expect(pausing).resolves.toEqual({ job: paused });
    expect(hook.current()).toMatchObject({ acting: null, job: paused, page: { ...JOB_PAGE, job: paused } });

    let resuming!: Promise<unknown>;
    await act(async () => {
      resuming = hook.current().resume();
    });
    expect(posts[1]).toMatchObject({ url: `${BASE}/ticket_routing/resume`, method: 'POST' });
    expect(hook.current()).toMatchObject({ acting: 'resume', job: paused });
    await act(async () => {
      answers.get('resume')!.resolve(json(JOB_OK));
      await resuming;
    });
    expect(hook.current()).toMatchObject({ acting: null, job: JOB_OK });

    const asked = { ...JOB_OK, handRun: { by: 'acct_1', at: NOW } };
    let running!: Promise<unknown>;
    await act(async () => {
      running = hook.current().runNow();
    });
    expect(posts[2]).toMatchObject({ url: `${BASE}/ticket_routing/run`, method: 'POST' });
    await act(async () => {
      answers.get('run')!.resolve(json(asked));
      await running;
    });
    expect(hook.current()).toMatchObject({ acting: null, job: asked });
  });

  it("a refused command leaves the job as it was and answers the word, a host's own error shape and retryAt among it", async () => {
    let answer: Response = json({ error: 'already', status: 409 }, 409);
    const client: OpsClient = {
      fetch: async (_input, init) => ((init?.method ?? 'GET') === 'GET' ? json(JOB_PAGE) : answer),
      base: BASE,
    };
    const hook = renderHook(() => useJob(client, 'ticket_routing'));
    await pass(0);
    let result: unknown;
    await act(async () => {
      result = await hook.current().pause();
    });
    expect(result).toEqual({ error: 'already', status: 409 });
    expect(hook.current()).toMatchObject({ acting: null, job: JOB_OK });

    answer = json({ error: 'hand_runs_used', status: 429, retryAt: NOW + 3_600_000 }, 429);
    await act(async () => {
      result = await hook.current().runNow();
    });
    expect(result).toEqual({ error: 'hand_runs_used', status: 429, retryAt: NOW + 3_600_000 });

    answer = json({ error: { kind: 'job_not_safe', message: 'x' } }, 409);
    await act(async () => {
      result = await hook.current().runNow();
    });
    expect(result).toEqual({ error: 'job_not_safe', status: 409 });
    expect(hook.current().job).toEqual(JOB_OK);
  });

  it("a poll read that began before a command's answer never puts back the job the command replaced", async () => {
    const reads: Array<ReturnType<typeof deferred<Response>>> = [];
    const paused = { ...JOB_OK, state: 'paused', paused: { by: 'acct_1', at: NOW, note: null } };
    const client: OpsClient = {
      fetch: async (_input, init) => {
        if ((init?.method ?? 'GET') !== 'GET') return json(paused);
        const held = deferred<Response>();
        reads.push(held);
        return held.promise;
      },
      base: BASE,
    };
    const hook = renderHook(() => useJob(client, 'ticket_routing'));
    await act(async () => {
      reads[0]!.resolve(json(JOB_PAGE));
    });
    await pass(0);
    expect(hook.current().job).toEqual(JOB_OK);
    // The next poll begins and is held; the pause answers meanwhile; then the held read answers the job as it was.
    await pass(JOBS_POLL_MS);
    expect(reads).toHaveLength(2);
    await act(async () => {
      await hook.current().pause();
    });
    expect(hook.current().job).toEqual(paused);
    await act(async () => {
      reads[1]!.resolve(json(JOB_PAGE));
    });
    await pass(0);
    expect(hook.current().job).toEqual(paused);
  });

  it('reads nothing for a null name, and its commands answer not_found without a request', async () => {
    const fetchStub = vi.fn(async () => json(JOB_PAGE));
    const hook = renderHook(() => useJob({ fetch: fetchStub, base: BASE }, null));
    await pass(JOBS_POLL_MS);
    expect(fetchStub).not.toHaveBeenCalled();
    let result: unknown;
    await act(async () => {
      result = await hook.current().pause('x');
    });
    expect(result).toEqual({ error: 'not_found', status: 404 });
    expect(fetchStub).not.toHaveBeenCalled();
    expect(hook.current()).toMatchObject({ page: null, job: null, updating: false });
  });
});
