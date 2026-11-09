// @vitest-environment jsdom
/**
 * `./react`'s jobs hooks over a stub `fetch`: `useJobs` reads the list once and again every 30
 * seconds while the page is visible, keeps the rows through a failed read, says when it last read,
 * whether a read runs, whether the connection is away, the refusal's word and a 401's sign-out, and
 * stops after 15 minutes without a successful read; `useJob` reads a job's page the same way and
 * pauses, resumes and runs it by POST, replacing the job only from the server's answer.
 */
import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOBS_GIVE_UP_MS, JOBS_POLL_MS, JOBS_READ_TIMEOUT_MS, useJob, useJobs, type OpsClient } from '../src/react/index.js';

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

  it('mounted while the browser says offline, it reads nothing until the connection returns', async () => {
    let reads = 0;
    let online = false;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const client: OpsClient = { fetch: async () => (reads += 1, json(PAGE)), base: BASE };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(reads).toBe(0);
    expect(hook.current()).toMatchObject({ offline: true, updating: false, jobs: null });
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await pass(0);
    expect(reads).toBe(1);
    expect(hook.current()).toMatchObject({ offline: false, jobs: PAGE.jobs });
  });

  it('a read slower than the interval is never superseded by a timed read, and its answer shows', async () => {
    const held: Array<ReturnType<typeof deferred<Response>>> = [];
    const client: OpsClient = {
      fetch: async () => {
        const answer = deferred<Response>();
        held.push(answer);
        return answer.promise;
      },
      base: BASE,
    };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    expect(held).toHaveLength(1);
    // The tick at 30 seconds finds the read still running and starts none.
    await pass(40_000);
    expect(held).toHaveLength(1);
    await act(async () => {
      held[0]!.resolve(json(PAGE));
    });
    await pass(0);
    expect(hook.current()).toMatchObject({ jobs: PAGE.jobs, updatedAt: NOW + 40_000, updating: false, error: null });
    await pass(20_000);
    expect(held).toHaveLength(2);
  });

  it('a read with no answer is ended at 45 seconds as a timeout, and the next tick reads again', async () => {
    expect(JOBS_READ_TIMEOUT_MS).toBe(45_000);
    let reads = 0;
    const client: OpsClient = {
      fetch: (_input, init) => {
        reads += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The read was aborted.', 'AbortError')));
        });
      },
      base: BASE,
    };
    const hook = renderHook(() => useJobs(client, {}));
    await pass(0);
    await pass(45_000 - 1);
    expect(reads).toBe(1);
    expect(hook.current().updating).toBe(true);
    await pass(1);
    expect(reads).toBe(1);
    expect(hook.current()).toMatchObject({ updating: false, error: 'timeout', offline: false });
    await pass(15_000);
    expect(reads).toBe(2);
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

  it("a command while another is in flight answers busy without a request, and the first one's answer shows", async () => {
    const posts: string[] = [];
    const held = deferred<Response>();
    const paused = { ...JOB_OK, state: 'paused', paused: { by: 'acct_1', at: NOW, note: 'x' } };
    const client: OpsClient = {
      fetch: async (input, init) => {
        if ((init?.method ?? 'GET') === 'GET') return json(JOB_PAGE);
        posts.push(String(input));
        return held.promise;
      },
      base: BASE,
    };
    const hook = renderHook(() => useJob(client, 'ticket_routing'));
    await pass(0);
    let pausing!: Promise<unknown>;
    await act(async () => {
      pausing = hook.current().pause('x');
    });
    // The second command is not awaited before the first is answered, so a hook that sent it waits on nothing.
    let second!: Promise<unknown>;
    await act(async () => {
      second = hook.current().resume();
    });
    expect(posts).toEqual([`${BASE}/ticket_routing/pause`]);
    expect(hook.current().acting).toBe('pause');
    await act(async () => {
      held.resolve(json(paused));
      await pausing;
    });
    await expect(second).resolves.toEqual({ error: 'busy', status: 409 });
    expect(hook.current()).toMatchObject({ acting: null, job: paused });
  });

  it("another job shows no command in flight, its commands are not held by the first job's, and the first one's answer leaves it as it is", async () => {
    const posts: string[] = [];
    const held = deferred<Response>();
    const client: OpsClient = {
      fetch: async (input, init) => {
        const url = String(input);
        if ((init?.method ?? 'GET') === 'GET') return json({ ...JOB_PAGE, job: { ...JOB_OK, name: url.slice(url.lastIndexOf('/') + 1) } });
        posts.push(url);
        if (url.endsWith('/ticket_routing/pause')) return held.promise;
        return json({ ...JOB_OK, name: 'ops_sweep', handRun: { by: 'acct_1', at: NOW } });
      },
      base: BASE,
    };
    let choose: (name: string) => void = () => undefined;
    const hook = renderHook(() => {
      const [name, setName] = useState('ticket_routing');
      choose = setName;
      return useJob(client, name);
    });
    await pass(0);
    let pausing!: Promise<unknown>;
    await act(async () => {
      pausing = hook.current().pause();
    });
    expect(hook.current().acting).toBe('pause');
    await act(async () => {
      choose('ops_sweep');
    });
    await pass(0);
    expect(hook.current()).toMatchObject({ acting: null, job: { name: 'ops_sweep', handRun: null } });
    let ran: unknown;
    await act(async () => {
      ran = await hook.current().runNow();
    });
    expect(ran).toMatchObject({ job: { name: 'ops_sweep', handRun: { by: 'acct_1' } } });
    expect(posts).toEqual([`${BASE}/ticket_routing/pause`, `${BASE}/ops_sweep/run`]);
    await act(async () => {
      held.resolve(json({ ...JOB_OK, state: 'paused' }));
      await pausing;
    });
    expect(hook.current()).toMatchObject({ acting: null, job: { name: 'ops_sweep', state: 'ok' } });
  });

  it('a command answered before the first read lands is not undone by that read: the page is read again', async () => {
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
    await pass(0);
    expect(reads).toHaveLength(1);
    let result: unknown;
    await act(async () => {
      result = await hook.current().pause();
    });
    expect(result).toEqual({ job: paused });
    expect(reads).toHaveLength(2);
    // The read begun before the pause answers the job as it was: it is dropped.
    await act(async () => {
      reads[0]!.resolve(json(JOB_PAGE));
    });
    await pass(0);
    expect(hook.current().job).toBeNull();
    await act(async () => {
      reads[1]!.resolve(json({ ...JOB_PAGE, job: paused }));
    });
    await pass(0);
    expect(hook.current().job).toEqual(paused);
  });

  it('a job chosen while the browser says offline shows offline, never a read in flight, and is read when the connection returns', async () => {
    let online = true;
    vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
    const calls: string[] = [];
    const client: OpsClient = {
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return json({ ...JOB_PAGE, job: { ...JOB_OK, name: url.slice(url.lastIndexOf('/') + 1) } });
      },
      base: BASE,
    };
    let choose: (name: string) => void = () => undefined;
    const hook = renderHook(() => {
      const [name, setName] = useState('ticket_routing');
      choose = setName;
      return useJob(client, name);
    });
    await pass(0);
    expect(calls).toEqual([`${BASE}/ticket_routing`]);
    online = false;
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
    });
    await act(async () => {
      choose('ops_sweep');
    });
    await pass(0);
    expect(hook.current()).toMatchObject({ offline: true, updating: false, job: null });
    await pass(JOBS_POLL_MS);
    expect(hook.current()).toMatchObject({ offline: true, updating: false, job: null });
    expect(calls).toHaveLength(1);
    online = true;
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await pass(0);
    expect(calls).toEqual([`${BASE}/ticket_routing`, `${BASE}/ops_sweep`]);
    expect(hook.current()).toMatchObject({ offline: false, job: { name: 'ops_sweep' } });
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
