// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { Markdown, useComposer, useStream, type OpsClient, type OpsTemplate } from '../src/react/index.js';

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
    const calls: Array<{ url: string; headers: Record<string, string>; method: string }> = [];
    const message = { id: 'msg_1', ticketId: 'tkt_1', sender: 'staff', body: 'hello', systemKey: null, systemParams: null, pictures: [], createdAt: 1 };
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url, headers, method: init?.method ?? 'GET' });
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
    expect(hook.current().lastEventId).toBe('msg_1');
    expect(hook.current().mode).toBe('stream');
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
});
