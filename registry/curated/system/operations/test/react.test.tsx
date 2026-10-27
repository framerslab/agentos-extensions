// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Markdown, SseParser, joinPath, readJson, useComposer, useRequest, useRequests, useStream, type OpsClient, type OpsTemplate } from '../src/react/index.js';
import { useState } from 'react';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** Waits until `check` answers true, flushing React between looks. */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the condition did not hold in time');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

const encoder = new TextEncoder();

/** An event stream body of `frames`, which ends after them when `end` is set, else stays open until aborted. */
function sseBody(frames: readonly string[], end: boolean, signal: AbortSignal | null | undefined): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (end) {
        controller.close();
        return;
      }
      signal?.addEventListener('abort', () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

describe('useStream (D13, D14)', () => {
  it('reconnects with Last-Event-ID after the stream ends and calls read on each delivered message while the page is visible', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; method: string; body: string | null }> = [];
    const message = { id: 'msg_1', ticketId: 'tkt_1', sender: 'staff', body: 'hello', systemKey: null, systemParams: null, pictures: [], createdAt: 1 };
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, headers, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : null });
      if (url.endsWith('/stream')) {
        const first = calls.filter((call) => call.url.endsWith('/stream')).length === 1;
        const frames = first ? [': open\n\n', `id: msg_1\nevent: message\ndata: ${JSON.stringify(message)}\n\n`] : [': open\n\n'];
        return new Response(sseBody(frames, first, init?.signal), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(null, { status: 204 });
    };
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    const delivered: unknown[] = [];
    const hook = renderHook(() => useStream(client, 'tkt_1', { onEvent: (event) => delivered.push(event), reconnectMs: 10 }));

    await waitFor(() => calls.filter((call) => call.url.endsWith('/stream')).length >= 2);
    const streams = calls.filter((call) => call.url === '/api/v1/support/requests/tkt_1/stream');
    expect(streams).toHaveLength(2);
    expect(streams[0]!.headers['last-event-id']).toBeUndefined();
    expect(streams[1]!.headers['last-event-id']).toBe('msg_1');
    expect(delivered).toEqual([{ id: 'msg_1', event: 'message', data: message }]);
    await waitFor(() => calls.some((call) => call.url === '/api/v1/support/requests/tkt_1/read'));
    const reads = calls.filter((call) => call.url === '/api/v1/support/requests/tkt_1/read');
    expect(reads).toHaveLength(1);
    expect(reads[0]!.method).toBe('POST');
    // The acknowledgment names the message the page delivered, so the server marks the thread read up to it alone: a reply that landed after it and has not reached the page stays unread (D14).
    expect(reads[0]!.headers['content-type']).toBe('application/json');
    expect(reads[0]!.body).toBe(JSON.stringify({ messageId: 'msg_1' }));
    expect(hook.current().lastEventId).toBe('msg_1');
    expect(hook.current().mode).toBe('stream');
    hook.unmount();
  });

  it("a handler changed on a re-render receives the next event: the hook keeps its callbacks in a ref written in an effect, never in render, so a render React discards leaves none of its callbacks behind for the stream to call", async () => {
    let started = false;
    let push: (frame: string) => void = () => undefined;
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/stream')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(': open\n\n'));
            push = (frame) => controller.enqueue(encoder.encode(frame));
            started = true;
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            });
          },
        });
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(null, { status: 204 });
    };
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    const delivered: Array<[number, string]> = [];
    let rerender: (generation: number) => void = () => undefined;
    const hook = renderHook(() => {
      const [generation, setGeneration] = useState(0);
      rerender = setGeneration;
      return useStream(client, 'tkt_1', { onEvent: (event) => delivered.push([generation, event.id]), markRead: false });
    });
    await waitFor(() => started);
    act(() => rerender(1));
    const message = { id: 'msg_1', ticketId: 'tkt_1', sender: 'staff', body: 'hello', systemKey: null, systemParams: null, pictures: [], createdAt: 1 };
    await act(async () => {
      push(`id: msg_1\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
    });
    await waitFor(() => delivered.length === 1);
    // The second render's handler, never the first's.
    expect(delivered).toEqual([[1, 'msg_1']]);
    expect(hook.current().mode).toBe('stream');
    hook.unmount();
  });

  it('reads a stream whose lines end in CRLF, a pair split across two chunks included, so a message is neither merged into the comment before it nor lost at a chunk boundary', async () => {
    const calls: string[] = [];
    const message = { id: 'msg_1', ticketId: 'tkt_1', sender: 'staff', body: 'hello', systemKey: null, systemParams: null, pictures: [], createdAt: 1 };
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/stream')) {
        const first = calls.filter((call) => call.endsWith('/stream')).length === 1;
        // The opening comment's final CRLF pair is split: the carriage return ends the first chunk and the line feed opens the second, which carries the message.
        const frames = first ? [': open\r\n\r', `\nid: msg_1\r\nevent: message\r\ndata: ${JSON.stringify(message)}\r\n\r\n`] : [': open\n\n'];
        return new Response(sseBody(frames, first, init?.signal), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(null, { status: 204 });
    };
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    const delivered: unknown[] = [];
    const hook = renderHook(() => useStream(client, 'tkt_1', { onEvent: (event) => delivered.push(event), reconnectMs: 10 }));
    await waitFor(() => calls.filter((call) => call.endsWith('/stream')).length >= 2);
    expect(delivered).toEqual([{ id: 'msg_1', event: 'message', data: message }]);
    expect(hook.current().lastEventId).toBe('msg_1');
    hook.unmount();
  });

  it('on stream_busy the hook polls through refresh every 20 seconds by default and reports the mode', async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: 'stream_busy' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    };
    const refreshed: number[] = [];
    const hook = renderHook(() => useStream({ fetch: fetchStub, base: '/api/v1/support' }, 'tkt_2', { onPoll: () => refreshed.push(Date.now()), pollMs: 30 }));
    await waitFor(() => hook.current().mode === 'poll' && refreshed.length >= 2);
    expect(calls.filter((url) => url.endsWith('/stream'))).toHaveLength(1);
    hook.unmount();
  });

  it('stops after a refusal the server will keep giving (a 4xx other than 408 and 429): the mode closes with the refusal named, and the hook asks no second time', async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    };
    const hook = renderHook(() => useStream({ fetch: fetchStub, base: '/api/v1/support' }, 'tkt_gone', { reconnectMs: 10 }));
    await waitFor(() => hook.current().error === 'not_found');
    // Six reconnect gaps pass: a hook that kept asking would have asked again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(calls.filter((url) => url.endsWith('/stream'))).toHaveLength(1);
    expect(hook.current().mode).toBe('closed');
    hook.unmount();
  });

  it('waits twice as long after each failed connection, from reconnectMs up, and from reconnectMs again once a connection is accepted', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    try {
      let down = true;
      let attempts = 0;
      const fetchStub: typeof fetch = async (input, init) => {
        if (!String(input).endsWith('/stream')) return new Response(null, { status: 204 });
        attempts += 1;
        if (down) throw new TypeError('the network is away');
        return new Response(sseBody([': open\n\n'], true, init?.signal), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      };
      const hook = renderHook(() => useStream({ fetch: fetchStub, base: '/api/v1/support' }, 'tkt_4', { reconnectMs: 100 }));
      const pass = async (ms: number): Promise<void> => {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(ms);
        });
      };
      await pass(0);
      expect(attempts).toBe(1);
      // The gaps after the failures: 100, 200 and 400 ms.
      await pass(99);
      expect(attempts).toBe(1);
      await pass(1);
      expect(attempts).toBe(2);
      await pass(199);
      expect(attempts).toBe(2);
      await pass(1);
      expect(attempts).toBe(3);
      await pass(399);
      expect(attempts).toBe(3);
      await pass(1);
      expect(attempts).toBe(4);
      // The connection 800 ms on is accepted and its stream ends at once: the gap after it is reconnectMs again.
      down = false;
      await pass(800);
      expect(attempts).toBe(5);
      await pass(99);
      expect(attempts).toBe(5);
      await pass(1);
      expect(attempts).toBe(6);
      hook.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useStream across requests', () => {
  it('forgets the resume cursor when the request changes, so the new stream is asked from its own start', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const message = { id: 'msg_a1', ticketId: 'tkt_a', sender: 'staff', body: 'a', systemKey: null, systemParams: null, pictures: [], createdAt: 1 };
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      if (url.endsWith('/stream')) {
        const first = url.includes('tkt_a') && calls.filter((call) => call.url === url).length === 1;
        const frames = first ? [`id: msg_a1\nevent: message\ndata: ${JSON.stringify(message)}\n\n`] : [': open\n\n'];
        return new Response(sseBody(frames, first, init?.signal), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(null, { status: 204 });
    };
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    let setTicket: (id: string) => void = () => undefined;
    const hook = renderHook(() => {
      const [ticket, set] = useState('tkt_a');
      setTicket = set;
      return useStream(client, ticket, { reconnectMs: 10 });
    });
    await waitFor(() => calls.filter((call) => call.url === '/api/v1/support/requests/tkt_a/stream').length >= 2);
    expect(hook.current().lastEventId).toBe('msg_a1');
    act(() => setTicket('tkt_b'));
    await waitFor(() => calls.some((call) => call.url === '/api/v1/support/requests/tkt_b/stream'));
    const other = calls.filter((call) => call.url === '/api/v1/support/requests/tkt_b/stream');
    expect(other[0]!.headers['last-event-id']).toBeUndefined();
    hook.unmount();
  });

  it("a change of the client's session word with the same fetch and base ends the stream and connects again, so an account switch behind one cookie-bearing fetch never keeps the first account's stream open", async () => {
    const calls: Array<{ url: string; aborted: () => boolean }> = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const signal = init?.signal ?? null;
      calls.push({ url, aborted: () => signal?.aborted ?? false });
      return new Response(sseBody([': open\n\n'], false, signal), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const first: OpsClient = { fetch: fetchStub, base: '/api/v1/support', session: 'acct_first' };
    const second: OpsClient = { fetch: fetchStub, base: '/api/v1/support', session: 'acct_second' };
    let setClient: (client: OpsClient) => void = () => undefined;
    const hook = renderHook(() => {
      const [client, set] = useState<OpsClient>(first);
      setClient = set;
      return useStream(client, 'tkt_1', { reconnectMs: 10 });
    });
    await waitFor(() => calls.length === 1 && hook.current().mode === 'stream');
    act(() => setClient(second));
    // The first session's stream is ended and the second's is opened on the same request.
    await waitFor(() => calls.length === 2);
    expect(calls[0]!.aborted()).toBe(true);
    await waitFor(() => hook.current().mode === 'stream');
    expect(calls.map((call) => call.url)).toEqual(['/api/v1/support/requests/tkt_1/stream', '/api/v1/support/requests/tkt_1/stream']);
    hook.unmount();
  });

  it('a request change sets the mode to connecting and clears the last refusal, so the hook never reads closed while it is trying', async () => {
    const calls: string[] = [];
    const fetchStub: typeof fetch = (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('tkt_busy')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'stream_busy' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
      }
      // The next request's stream stays unanswered: the hook is connecting.
      return new Promise<Response>(() => undefined);
    };
    let setTicket: (id: string) => void = () => undefined;
    const hook = renderHook(() => {
      const [ticket, set] = useState('tkt_busy');
      setTicket = set;
      return useStream({ fetch: fetchStub, base: '/api/v1/support' }, ticket, { reconnectMs: 10, pollMs: 10_000 });
    });
    await waitFor(() => hook.current().mode === 'poll');
    expect(hook.current().error).toBe('stream_busy');
    act(() => setTicket('tkt_next'));
    await waitFor(() => calls.some((url) => url.includes('tkt_next')));
    expect(hook.current()).toMatchObject({ mode: 'connecting', error: null });
    hook.unmount();
  });

  it("a refusal whose body is still being read when the page moves on never touches the next request's state", async () => {
    let endOld: () => void = () => undefined;
    const oldBody = new ReadableStream<Uint8Array>({
      start(controller) {
        endOld = () => {
          controller.enqueue(new TextEncoder().encode('not json'));
          controller.close();
        };
      },
    });
    let oldAsked = false;
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('tkt_old')) {
        oldAsked = true;
        return new Response(oldBody, { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(sseBody([': open\n\n'], false, init?.signal), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    let setTicket: (id: string) => void = () => undefined;
    const hook = renderHook(() => {
      const [ticket, set] = useState('tkt_old');
      setTicket = set;
      return useStream({ fetch: fetchStub, base: '/api/v1/support' }, ticket, { reconnectMs: 10 });
    });
    await waitFor(() => oldAsked);
    act(() => setTicket('tkt_new'));
    await waitFor(() => hook.current().mode === 'stream');
    // The old request's refusal body ends now, after the page left it.
    endOld();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(hook.current()).toMatchObject({ mode: 'stream', error: null });
    hook.unmount();
  });
});

describe('useRequest (D39)', () => {
  it('reads the request, and forgets it when the id becomes null', async () => {
    const view = { ticket: { id: 'tkt_1' }, messages: [] };
    const fetchStub: typeof fetch = async (input) => new Response(JSON.stringify(view), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    let setId: (id: string | null) => void = () => undefined;
    const hook = renderHook(() => {
      const [id, set] = useState<string | null>('tkt_1');
      setId = set;
      return useRequest(client, id);
    });
    await waitFor(() => hook.current().data !== null);
    expect(hook.current()).toMatchObject({ data: view, error: null, loading: false });
    act(() => setId(null));
    await waitFor(() => hook.current().data === null);
    expect(hook.current()).toMatchObject({ data: null, error: null, loading: false });
    hook.unmount();
  });
});

describe('useRequest across requests', () => {
  it("a refresh kept from the request the page left does nothing once the page is on the next request: it neither reads the old request again, nor cancels the next request's read, nor puts the old request's view under the new one", async () => {
    const pending: Array<{ url: string; release: () => void }> = [];
    const fetchStub: typeof fetch = (input) =>
      new Promise((resolve) => {
        const url = String(input);
        pending.push({ url, release: () => resolve(new Response(JSON.stringify({ ticket: { id: url.split('/').pop() }, messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })) });
      });
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    let setId: (id: string | null) => void = () => undefined;
    const hook = renderHook(() => {
      const [id, set] = useState<string | null>('tkt_a');
      setId = set;
      return useRequest(client, id);
    });
    await waitFor(() => pending.length === 1);
    await act(async () => pending[0]!.release());
    await waitFor(() => hook.current().data !== null);
    // A write handler keeps the first request's refresh and finishes after the page moved to the second request.
    const staleRefresh = hook.current().refresh;
    act(() => setId('tkt_b'));
    await waitFor(() => pending.length === 2 && hook.current().loading);
    act(() => void staleRefresh());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    // Nothing of the first request is read again, and the second request's read is still the one in flight.
    expect(pending.map((call) => call.url)).toEqual(['/api/v1/support/requests/tkt_a', '/api/v1/support/requests/tkt_b']);
    expect(hook.current()).toMatchObject({ data: null, error: null, loading: true });
    await act(async () => pending[1]!.release());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current()).toMatchObject({ data: { ticket: { id: 'tkt_b' }, messages: [] }, error: null, loading: false });
    hook.unmount();
  });

  it('shows nothing of the request the page left while the next one loads', async () => {
    const answers = new Map<string, () => void>();
    const fetchStub: typeof fetch = (input) =>
      new Promise((resolve) => {
        const url = String(input);
        answers.set(url, () => resolve(new Response(JSON.stringify({ ticket: { id: url.split('/').pop() }, messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
      });
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    let setId: (id: string | null) => void = () => undefined;
    const hook = renderHook(() => {
      const [id, set] = useState<string | null>('tkt_1');
      setId = set;
      return useRequest(client, id);
    });
    await waitFor(() => answers.has('/api/v1/support/requests/tkt_1'));
    act(() => answers.get('/api/v1/support/requests/tkt_1')!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ ticket: { id: 'tkt_1' }, messages: [] });

    act(() => setId('tkt_2'));
    expect(hook.current()).toMatchObject({ data: null, error: null, loading: true });
    await waitFor(() => answers.has('/api/v1/support/requests/tkt_2'));
    expect(hook.current().data).toBeNull();
    act(() => answers.get('/api/v1/support/requests/tkt_2')!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ ticket: { id: 'tkt_2' }, messages: [] });
    hook.unmount();
  });

  it("shows nothing of the client the page left while the next one loads: what was read belongs to the client's base and the path, not the path alone", async () => {
    const answers = new Map<string, () => void>();
    const fetchStub: typeof fetch = (input) =>
      new Promise((resolve) => {
        const url = String(input);
        // The answer names the base it came from, so a page that shows the old client's data under the new one is caught.
        answers.set(url, () => resolve(new Response(JSON.stringify({ tickets: [{ id: url.split('/')[3] }], cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
      });
    const person: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    const admin: OpsClient = { fetch: fetchStub, base: '/api/v1/admin/support' };
    let setClient: (client: OpsClient) => void = () => undefined;
    const hook = renderHook(() => {
      const [client, set] = useState<OpsClient>(person);
      setClient = set;
      return useRequests(client);
    });
    await waitFor(() => answers.has('/api/v1/support/requests'));
    act(() => answers.get('/api/v1/support/requests')!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ tickets: [{ id: 'support' }], cursor: null });

    act(() => setClient(admin));
    expect(hook.current()).toMatchObject({ data: null, error: null, loading: true });
    await waitFor(() => answers.has('/api/v1/admin/support/requests'));
    expect(hook.current().data).toBeNull();
    act(() => answers.get('/api/v1/admin/support/requests')!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ tickets: [{ id: 'admin' }], cursor: null });
    hook.unmount();
  });

  it("shows nothing of the client the page left while the next one loads when the two differ in their fetch alone: what was read belongs to the client, never to its base and the path alone, so another account's session under the same routes sees none of the first's requests", async () => {
    const answers = new Map<string, () => void>();
    // Each client's fetch names itself in its answer, so a page that shows the first client's data under the second is caught.
    const stub = (who: string): typeof fetch => (input) =>
      new Promise((resolve) => {
        answers.set(`${who} ${String(input)}`, () => resolve(new Response(JSON.stringify({ tickets: [{ id: who }], cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
      });
    const first: OpsClient = { fetch: stub('first'), base: '/api/v1/support' };
    const second: OpsClient = { fetch: stub('second'), base: '/api/v1/support' };
    let setClient: (client: OpsClient) => void = () => undefined;
    const hook = renderHook(() => {
      const [client, set] = useState<OpsClient>(first);
      setClient = set;
      return useRequests(client);
    });
    await waitFor(() => answers.has('first /api/v1/support/requests'));
    act(() => answers.get('first /api/v1/support/requests')!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ tickets: [{ id: 'first' }], cursor: null });

    act(() => setClient(second));
    expect(hook.current()).toMatchObject({ data: null, error: null, loading: true });
    await waitFor(() => answers.has('second /api/v1/support/requests'));
    expect(hook.current().data).toBeNull();
    act(() => answers.get('second /api/v1/support/requests')!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ tickets: [{ id: 'second' }], cursor: null });
    hook.unmount();
  });

  it("forgets what it read and reads again when the client's session word changes with the same fetch and base, so an account switch behind one cookie-bearing fetch shows none of the first account's requests", async () => {
    const answers: Array<() => void> = [];
    let reads = 0;
    const fetchStub: typeof fetch = () =>
      new Promise((resolve) => {
        reads += 1;
        const who = reads === 1 ? 'first' : 'second';
        answers.push(() => resolve(new Response(JSON.stringify({ tickets: [{ id: who }], cursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
      });
    const first: OpsClient = { fetch: fetchStub, base: '/api/v1/support', session: 'acct_first' };
    const second: OpsClient = { fetch: fetchStub, base: '/api/v1/support', session: 'acct_second' };
    let setClient: (client: OpsClient) => void = () => undefined;
    const hook = renderHook(() => {
      const [client, set] = useState<OpsClient>(first);
      setClient = set;
      return useRequests(client);
    });
    await waitFor(() => answers.length === 1);
    act(() => answers[0]!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ tickets: [{ id: 'first' }], cursor: null });

    act(() => setClient(second));
    expect(hook.current()).toMatchObject({ data: null, error: null, loading: true });
    await waitFor(() => answers.length === 2);
    expect(hook.current().data).toBeNull();
    act(() => answers[1]!());
    await waitFor(() => hook.current().data !== null);
    expect(hook.current().data).toEqual({ tickets: [{ id: 'second' }], cursor: null });
    hook.unmount();
  });
});

describe('the client (D39)', () => {
  it('joins a base and a path with one slash, whichever side carries it', () => {
    expect(joinPath('/api/v1/support', 'requests')).toBe('/api/v1/support/requests');
    expect(joinPath('/api/v1/support/', '/requests')).toBe('/api/v1/support/requests');
    expect(joinPath('/api/v1/support', '/requests')).toBe('/api/v1/support/requests');
    expect(joinPath('', '/requests')).toBe('/requests');
  });

  it("readJson keeps the caller's headers in every form, and a 2xx body that is not JSON answers failed", async () => {
    const seen: Headers[] = [];
    const fetchStub: typeof fetch = async (_input, init) => {
      seen.push(new Headers(init?.headers));
      return new Response('not json', { status: 200 });
    };
    const client: OpsClient = { fetch: fetchStub, base: '/api/v1/support' };
    expect(await readJson(client, '/x', { headers: new Headers({ 'X-Custom': '1' }) })).toEqual({ error: 'failed', status: 200 });
    expect(await readJson(client, '/x', { headers: [['X-Custom', '2']] })).toEqual({ error: 'failed', status: 200 });
    expect(await readJson(client, '/x', { headers: { 'X-Custom': '3', Accept: 'application/vnd.test+json' } })).toEqual({ error: 'failed', status: 200 });
    expect(seen.map((headers) => [headers.get('x-custom'), headers.get('accept')])).toEqual([
      ['1', 'application/json'],
      ['2', 'application/json'],
      ['3', 'application/vnd.test+json'],
    ]);
    const empty: typeof fetch = async () => new Response(null, { status: 204 });
    expect(await readJson({ fetch: empty, base: '' }, '/y')).toEqual({ data: null });
    const refused: typeof fetch = async () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    expect(await readJson({ fetch: refused, base: '' }, '/z')).toEqual({ error: 'not_found', status: 404 });
  });

  it('SseParser reads every line ending the format allows, a CRLF pair split across two chunks included, so no frame is merged into another or lost at a chunk boundary', () => {
    const parser = new SseParser();
    // A CRLF pair split between two pushes: the carriage return that ends the first push already ends the line, and the line feed that opens the next is no second line ending.
    expect(parser.push('id: m1\r\nevent: message\r\ndata: {"a":1}\r\n\r')).toEqual([{ id: 'm1', event: 'message', data: '{"a":1}' }]);
    expect(parser.push('\nid: m2\r\ndata: two\r\n\r\n')).toEqual([{ id: 'm2', event: 'message', data: 'two' }]);
    // Carriage returns alone end lines too.
    expect(parser.push(': open\r\r')).toEqual([{ comment: 'open' }]);
    expect(parser.push('id: m4\rdata: four\r')).toEqual([]);
    expect(parser.push('\r')).toEqual([{ id: 'm4', event: 'message', data: 'four' }]);
    // Line feeds alone, two data lines joined with one, and a frame that arrives in pieces.
    expect(parser.push('id: m5\ndata: five\ndata: more\n')).toEqual([]);
    expect(parser.push('\n')).toEqual([{ id: 'm5', event: 'message', data: 'five\nmore' }]);
  });
});

describe('useComposer (D19)', () => {
  const templates: OpsTemplate[] = [
    { id: 'refund', label: 'Refund processed', category: 'billing', body: 'Your refund is on its way.' },
    { id: 'more', label: 'Need more information', category: 'other', body: 'Could you share more?' },
    { id: 'fixed', label: 'Fixed', category: 'bug', body: 'This is fixed.' },
  ];

  it("filters templates by the request's category, appends a template to the body, swaps Write and Preview, holds pictures and counts the characters left", () => {
    const hook = renderHook(() => useComposer({ category: 'billing', templates }));
    expect(hook.current().templates.map((template) => template.id)).toEqual(['refund', 'more']);
    expect(hook.current().mode).toBe('write');
    expect(hook.current().canSend).toBe(false);
    act(() => hook.current().setBody('Hello'));
    act(() => hook.current().apply('refund'));
    expect(hook.current().body).toBe('Hello\n\nYour refund is on its way.');
    expect(hook.current().charsLeft).toBe(5_000 - 'Hello\n\nYour refund is on its way.'.length);
    expect(hook.current().canSend).toBe(true);
    act(() => hook.current().setMode('preview'));
    expect(hook.current().mode).toBe('preview');
    act(() => hook.current().addPicture('pic_1'));
    act(() => hook.current().addPicture('pic_2'));
    act(() => hook.current().addPicture('pic_3'));
    act(() => hook.current().addPicture('pic_4'));
    expect(hook.current().pictureIds).toEqual(['pic_1', 'pic_2', 'pic_3']);
    act(() => hook.current().removePicture('pic_2'));
    expect(hook.current().pictureIds).toEqual(['pic_1', 'pic_3']);
    act(() => hook.current().setBody('x'.repeat(5_001)));
    expect(hook.current().charsLeft).toBe(-1);
    expect(hook.current().canSend).toBe(false);
    act(() => hook.current().reset());
    expect([hook.current().body, hook.current().pictureIds, hook.current().mode]).toEqual(['', [], 'write']);
    hook.unmount();
  });
});

describe('Markdown (D19)', () => {
  it('renders no raw HTML, drops images and marks links rel noopener noreferrer nofollow ugc', () => {
    const body = 'Hi <script>alert(1)</script> **bold** ![pic](https://stranger.invalid/pixel.png) [docs](https://example.invalid/help) <img src="https://stranger.invalid/x.png" onerror="alert(2)">\n\n| a | b |\n|---|---|\n| 1 | 2 |';
    const html = renderToStaticMarkup(<Markdown body={body} />);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('stranger.invalid');
    expect(html).not.toContain('onerror');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.invalid\/help"[^>]*>docs<\/a>/);
    expect(html).toMatch(/<a [^>]*rel="noopener noreferrer nofollow ugc"/);
    expect(html).toMatch(/<a [^>]*target="_blank"/);
    expect(renderToStaticMarkup(<Markdown body="[bad](javascript:alert(1))" />)).not.toContain('javascript:');
  });

  it('keeps a link to http, https or mailto and drops the address of every other scheme, as the file says', () => {
    const html = renderToStaticMarkup(
      <Markdown body="[chat](irc://irc.example.invalid/room) [talk](xmpp:someone@example.invalid) [write](mailto:team@example.invalid) [site](https://example.invalid/)" />,
    );
    expect(html).not.toContain('irc:');
    expect(html).not.toContain('xmpp:');
    expect(html).toMatch(/<a [^>]*href="mailto:team@example\.invalid"[^>]*>write<\/a>/);
    expect(html).toMatch(/<a [^>]*href="https:\/\/example\.invalid\/"[^>]*>site<\/a>/);
    expect(html).toContain('>chat</a>');
    expect(html).toContain('>talk</a>');
  });
});
