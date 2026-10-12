import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import { LimiterRefused as PublicLimiterRefused, retryAfterMs as publicRetryAfterMs, SourceLimiter as PublicSourceLimiter } from '@framers/agentos-ext-public-sources';
import {
  LimiterRefused, readThroughLimiter, retryAfterMs, SourceLimiter,
  type AccountSourceConnector, type SourceChanges, type SourceGone,
  type SourceItem, type SourceRead, type SourceSelection,
} from '../src/index.js';

/** An account whose selected documents and versions live in a map. */
class MapConnector implements AccountSourceConnector {
  readonly kind = 'example';

  /** Keeps the map used for reads and change comparisons. */
  constructor(private readonly documents: Map<string, SourceRead>) {}

  /** Lists selected documents and reports those no longer present. */
  async list(selection: SourceSelection, signal?: AbortSignal): Promise<{ items: SourceItem[]; gone: SourceGone[] }> {
    signal?.throwIfAborted();
    const items: SourceItem[] = [];
    const gone: SourceGone[] = [];
    for (const id of selection.ids) {
      const document = this.documents.get(id);
      if (document === undefined) gone.push({ id, reason: 'removed' });
      else items.push(document.item);
    }
    return { items, gone };
  }

  /** Reads a document with its attribution or reports its removal. */
  async read(item: SourceItem, signal?: AbortSignal): Promise<SourceRead | SourceGone> {
    signal?.throwIfAborted();
    return this.documents.get(item.id) ?? { id: item.id, reason: 'removed' };
  }

  /** Compares selected item versions with the previous serialized listing. */
  async changesSince(cursor: string | null, selection: SourceSelection, signal?: AbortSignal): Promise<SourceChanges> {
    const { items, gone } = await this.list(selection, signal);
    const previous = new Map<string, string | null>();
    if (cursor !== null) {
      const parsed: unknown = JSON.parse(cursor);
      if (!Array.isArray(parsed)) throw new Error('invalid cursor');
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || (entry[1] !== null && typeof entry[1] !== 'string')) throw new Error('invalid cursor');
        previous.set(entry[0], entry[1]);
      }
    }
    const changed: SourceItem[] = [];
    const versions: Array<[string, string | null]> = [];
    for (const item of items) {
      if (!previous.has(item.id) || previous.get(item.id) !== item.version) changed.push(item);
      versions.push([item.id, item.version]);
    }
    return { changed, gone, cursor: JSON.stringify(versions) };
  }

  /** Ends access to all documents held by the connector. */
  async revoke(): Promise<void> {
    this.documents.clear();
  }
}

/** Makes a plainly fictional document with its recorded attribution. */
function document(id: string, text: string, version: string): SourceRead {
  return {
    item: { id, title: id, size: text.length, version },
    content: { text },
    ref: { kind: 'example', title: id, url: null, version, readAt: '2026-10-08T12:00:00Z' },
  };
}

/** Exercises an implementation through the connector interface. */
describe('AccountSourceConnector', () => {
  /** Lists, reads, follows a cursor through edits and removals, and revokes access. */
  it('carries selected documents through their lifecycle', async () => {
    const first = document('fake-guide', 'First text', '1');
    const second = document('fake-notes', 'Other text', '1');
    const documents = new Map([[first.item.id, first], [second.item.id, second]]);
    const connector: AccountSourceConnector = new MapConnector(documents);
    const selection = { ids: ['fake-guide', 'fake-notes'] };
    expect(connector.kind).toBe('example');
    expect(await connector.list({ ids: ['fake-guide'] })).toEqual({ items: [first.item], gone: [] });
    expect(await connector.read(first.item)).toEqual(first);
    const initial = await connector.changesSince(null, selection);
    expect(initial.changed).toEqual([first.item, second.item]);
    expect(initial.gone).toEqual([]);
    expect(initial.cursor).toBe('[["fake-guide","1"],["fake-notes","1"]]');
    expect(await connector.changesSince(initial.cursor, selection)).toEqual({ changed: [], gone: [], cursor: initial.cursor });
    const updated = document('fake-guide', 'Updated text', '2');
    documents.set('fake-guide', updated);
    documents.delete('fake-notes');
    expect(await connector.changesSince(initial.cursor, selection)).toEqual({
      changed: [updated.item], gone: [{ id: 'fake-notes', reason: 'removed' }], cursor: '[["fake-guide","2"]]',
    });
    expect(await connector.read(first.item)).toEqual(updated);
    expect(await connector.read(second.item)).toEqual({ id: 'fake-notes', reason: 'removed' });
    await connector.revoke();
    expect(await connector.list(selection)).toEqual({ items: [], gone: [{ id: 'fake-guide', reason: 'removed' }, { id: 'fake-notes', reason: 'removed' }] });
  });
});

/** Exercises real limiter admission and the responses that block it. */
describe('readThroughLimiter', () => {
  /** Keeps the public source limiter's constructors and header parser intact. */
  it('re-exports the shared limiter unchanged', () => {
    expect(SourceLimiter).toBe(PublicSourceLimiter);
    expect(LimiterRefused).toBe(PublicLimiterRefused);
    expect(retryAfterMs).toBe(publicRetryAfterMs);
  });

  /** Blocks further calls until the response's Retry-After expires. */
  it.each([429, 503])('blocks subsequent calls after a %i response', async (status) => {
    let now = 1_000;
    /** Supplies the limiter's controllable clock without scheduling waits. */
    const clock = (): number => now;
    const limiter = new SourceLimiter({ spacingMs: 0, now: clock });
    let calls = 0;
    /** Returns one refusal followed by successful responses. */
    const call = async (): Promise<Response> => {
      calls += 1;
      return calls === 1
        ? new Response('slow down', { status, headers: { 'retry-after': '7' } })
        : new Response('ready');
    };
    await expect(readThroughLimiter(limiter, call)).rejects.toThrow();
    now = 7_999;
    await expect(readThroughLimiter(limiter, call)).rejects.toBeInstanceOf(LimiterRefused);
    expect(calls).toBe(1);
    now = 8_000;
    const response = await readThroughLimiter(limiter, call);
    expect(await response.text()).toBe('ready');
    expect(calls).toBe(2);
  });

  /** Preserves the limiter refusal when cancelling a rejected response fails. */
  it.each([429, 503])('preserves the refusal when a %i body fails to cancel', async (status) => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      /** Records cancellation and rejects the cleanup operation. */
      async cancel(): Promise<void> {
        cancelled = true;
        throw new Error('cancellation failed');
      },
    }, { highWaterMark: 0 });
    /** Returns a refusal with a body whose cancellation rejects. */
    const call = async (): Promise<Response> => new Response(body, { status });
    const reading = readThroughLimiter(new SourceLimiter(), call);
    await expect(reading).rejects.toBeInstanceOf(LimiterRefused);
    await expect(reading).rejects.toMatchObject({ reason: 'blocked' });
    expect(cancelled).toBe(true);
  });

  /** Passes cancellation into the limiter before the call starts. */
  it('refuses an aborted call without invoking it', async () => {
    let called = false;
    /** Records whether the cancelled operation was admitted. */
    const call = async (): Promise<Response> => {
      called = true;
      return new Response('unexpected');
    };
    const reason = new Error('cancelled by test');
    await expect(readThroughLimiter(new SourceLimiter(), call, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(called).toBe(false);
  });
});
