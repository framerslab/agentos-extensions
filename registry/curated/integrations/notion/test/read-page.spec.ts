import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotionReadConnector, type NotionReadOptions } from '../src/index.js';
import { NotionStandIn, notionId, page, type StandInBlock, type StandInPage } from './standin.js';

const TOKEN = 'fake-access';
const READ_AT = new Date('2026-11-20T06:00:00.000Z');
const standIn = new NotionStandIn();

/** A connector on the stand-in with room for thousands of calls a minute, so a long page is never paced. */
function connector(overrides: Partial<NotionReadOptions> = {}): NotionReadConnector {
  return new NotionReadConnector({
    accessToken: TOKEN, maxPages: 100, maxDepth: 8, maxBlocks: 2_000, maxChars: 1_000_000, requestsPerMinute: 100_000,
    apiBase: standIn.apiBase, now: () => READ_AT, ...overrides,
  });
}

/** The item a host holds for a page. */
function item(p: StandInPage) {
  return { id: p.id, title: p.title, size: null, version: p.lastEdited };
}

let next = 0;

/** A block with its own id. */
function block(type: string, body: Record<string, unknown>, children?: StandInBlock[]): StandInBlock {
  next += 1;
  return { id: notionId(next, 'b'), type, body, ...(children === undefined ? {} : { children }) };
}

/** A block of plain text. */
function said(type: string, text: string, children?: StandInBlock[]): StandInBlock {
  return block(type, { rich_text: [{ type: 'text', text: { content: text, link: null }, plain_text: text, href: null }] }, children);
}

// A page whose blocks nest three deep, with 150 blocks at its top level: two pages of the page's children, one call
// for the list item's children and one for its child's.
const nested = page(10, 'Planning call');
const mid = said('bulleted_list_item', 'Mid', [said('paragraph', 'Deep')]);
const nestedBlocks = [said('bulleted_list_item', 'Top', [mid]), ...Array.from({ length: 149 }, (_, i) => said('paragraph', `Line ${i + 1}`))];
const nestedMarkdown = ['- Top', '  - Mid', '    Deep', ...Array.from({ length: 149 }, (_, i) => `Line ${i + 1}`)].join('\n');

// The edge of the bounds: 250 chains of 8 paragraphs, 2,000 blocks over 8 levels.
const edge = page(20, 'Edge');
function chain(i: number, level: number): StandInBlock {
  return said('paragraph', `c${i}.${level}`, level < 8 ? [chain(i, level + 1)] : undefined);
}
const edgeBlocks = Array.from({ length: 250 }, (_, i) => chain(i + 1, 1));
const edgeMarkdown = Array.from({ length: 250 }, (_, i) => Array.from({ length: 8 }, (_, l) => `c${i + 1}.${l + 1}`)).flat().join('\n');

// Past every bound at once: 62 blocks, three levels, more than 100 characters.
const big = page(30, 'Big');
const bigBlocks = [said('paragraph', 'Row 0', [said('paragraph', 'Row 0.1', [said('paragraph', 'Row 0.2')])]), ...Array.from({ length: 59 }, (_, i) => said('paragraph', `Row ${i + 1}`))];

beforeAll(async () => {
  await standIn.start();
});

afterAll(async () => {
  await standIn.stop();
});

beforeEach(() => {
  vi.stubEnv('CI', 'true');
  standIn.reset();
  standIn.share([nested, edge, big]);
  standIn.children(nested.id, nestedBlocks);
  standIn.children(edge.id, edgeBlocks);
  standIn.children(big.id, bigBlocks);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('NotionReadConnector read', () => {
  it('reads a page whose blocks nest three deep across two pages of children as one item with its attribution', async () => {
    const read = await connector().read(item(nested));
    expect(read).toMatchObject({
      item: { id: nested.id, title: nested.title, size: null, version: nested.lastEdited },
      content: { text: nestedMarkdown },
      ref: { kind: 'notion', title: nested.title, url: nested.url, version: nested.lastEdited, readAt: READ_AT.toISOString() },
    });
    expect(standIn.calls()).toBe(1 + 4);
    expect(standIn.seen('GET /v1/blocks/:id/children').map((call) => call.page_size)).toEqual(Array(4).fill('100'));
  });

  it('reads a page at the edge of its bounds, 250 chains of 8 blocks, in one retrieve and 1,753 children calls', async () => {
    const read = await connector({ maxBlocks: 2_000, maxDepth: 8 }).read(item(edge));
    expect(read).toMatchObject({ content: { text: edgeMarkdown } });
    expect(standIn.calls()).toBe(1 + 3 + 250 * 7);
  });

  it('reads the edge page with `concurrency` 3 to the same text in the same 1,754 calls, never more than 3 in flight', async () => {
    standIn.delayEach(2);
    const read = await connector({ maxBlocks: 2_000, maxDepth: 8, concurrency: 3 }).read(item(edge));
    expect(read).toMatchObject({ content: { text: edgeMarkdown } });
    expect(standIn.calls()).toBe(1 + 3 + 250 * 7);
    expect(standIn.mostInFlight()).toBe(3);
  }, 30_000);

  it('starts no call after a fault with `concurrency` 3, and throws it once the calls in flight have settled', async () => {
    standIn.delayEach(5);
    standIn.rateLimitCall(50, 7);
    await expect(connector({ concurrency: 3 }).read(item(edge))).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 7_000 });
    const made = standIn.calls();
    expect(made).toBeLessThanOrEqual(52);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(standIn.calls()).toBe(made);
  });

  it.each([['maxBlocks', { maxBlocks: 50 }], ['maxDepth', { maxDepth: 2 }], ['maxChars', { maxChars: 100 }]] as const)(
    'answers a page past %s too_large, with no text', async (_name, bound) => {
      expect(await connector(bound).read(item(big))).toEqual({ id: big.id, reason: 'too_large' });
    });

  it('answers too_large once the text read so far passes maxChars, and reads no further', async () => {
    const long = page(50, 'Long');
    standIn.share([long]);
    standIn.children(long.id, [said('paragraph', 'x'.repeat(300)), ...Array.from({ length: 249 }, (_, i) => said('paragraph', `Line ${i + 1}`))]);
    expect(await connector({ maxChars: 100 }).read(item(long))).toEqual({ id: long.id, reason: 'too_large' });
    expect(standIn.calls()).toBe(2);
  });

  it('counts only the text a page writes toward maxChars: a block it leaves out, and its children, count for nothing', async () => {
    const quiet = page(51, 'Quiet');
    standIn.share([quiet]);
    standIn.children(quiet.id, [
      block('template', { rich_text: [{ type: 'text', plain_text: 'y'.repeat(300) }] }, [said('paragraph', 'z'.repeat(300))]),
      block('embed', { url: 'https://example.invalid/embed', caption: [] }, [said('paragraph', 'w'.repeat(300))]),
      said('paragraph', 'Kept'),
    ]);
    expect(await connector({ maxChars: 100 }).read(item(quiet))).toMatchObject({ content: { text: 'Kept' } });
  });

  it('throws rate_limited when a 429 answers after another call found a block gone, and sends nothing after it', async () => {
    const two = page(53, 'Two');
    const x = said('toggle', 'X', [said('paragraph', 'x1')]);
    const y = said('toggle', 'Y', [said('paragraph', 'y1')]);
    standIn.share([two]);
    standIn.children(two.id, [x, y]);
    standIn.vanish(x.id, false);
    standIn.rateLimitCall(4, 9);
    standIn.slowCall(4, 30);
    await expect(connector({ concurrency: 3 }).read(item(two))).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 9_000 });
    expect(standIn.calls()).toBe(4);
  });

  it("throws rate_limited when a 429 sent through the host's budget answers after another call found a block gone", async () => {
    const two = page(54, 'Two by budget');
    const x = said('toggle', 'X', [said('paragraph', 'x1')]);
    const y = said('toggle', 'Y', [said('paragraph', 'y1')]);
    standIn.share([two]);
    standIn.children(two.id, [x, y]);
    standIn.vanish(x.id, false);
    standIn.rateLimitCall(4, 9);
    standIn.slowCall(4, 30);
    const send: NotionReadOptions['send'] = (_method, call) => call(new AbortController().signal);
    await expect(connector({ concurrency: 3, send }).read(item(two))).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 9_000 });
    expect(standIn.calls()).toBe(4);
  });

  it("never answers part of a page when the operation is stopped while the host's budget holds a 429", async () => {
    const half = page(56, 'Half read');
    standIn.share([half]);
    standIn.children(half.id, [said('toggle', 'Holder', [said('paragraph', 'Inside')])]);
    standIn.rateLimitCall(3, 9);
    const stop = new AbortController();
    let listings = 0;
    const send: NotionReadOptions['send'] = async (method, call) => {
      const answered = await call(new AbortController().signal);
      if (method === 'children') listings += 1;
      if (listings === 2) stop.abort(); // the budget has the 429 in hand and has yet to pass it back
      return answered;
    };
    await expect(connector({ send }).read(item(half), stop.signal)).rejects.toMatchObject({ name: 'NotionFault', reason: 'cancelled' });
    expect(standIn.calls()).toBe(3);
  });

  it('throws invalid_response for a children cursor that cannot be sent, and reads no further', async () => {
    const odd = page(55, 'Odd cursor');
    const holder = said('toggle', 'Holder', [said('paragraph', 'Never')]);
    standIn.share([odd]);
    standIn.children(odd.id, [holder]);
    standIn.unsendableCursor(holder.id);
    await expect(connector().read(item(odd))).rejects.toMatchObject({ name: 'NotionFault', reason: 'invalid_response' });
    expect(standIn.calls()).toBe(3);
  });

  it('throws invalid_response for a children listing that repeats its cursor, and reads no further', async () => {
    const looping = page(52, 'Looping');
    const holder = said('toggle', 'Holder', [said('paragraph', 'Never')]);
    standIn.share([looping]);
    standIn.children(looping.id, [holder]);
    standIn.repeatCursor(holder.id);
    await expect(connector().read(item(looping))).rejects.toMatchObject({ name: 'NotionFault', reason: 'invalid_response' });
    expect(standIn.calls()).toBe(4);
  });

  it('answers an unshared page removed, one in the trash removed and one the grant cannot reach no_access, at its retrieve', async () => {
    standIn.unshare(nested);
    expect(await connector().read(item(nested))).toEqual({ id: nested.id, reason: 'removed' });
    standIn.trash(edge);
    expect(await connector().read(item(edge))).toEqual({ id: edge.id, reason: 'removed' });
    standIn.forbid(big);
    expect(await connector().read(item(big))).toEqual({ id: big.id, reason: 'no_access' });
    expect(standIn.seen('GET /v1/blocks/:id/children')).toEqual([]);
  });

  it('answers a page unshared between its retrieve and its first block read removed, and one forbidden then no_access', async () => {
    standIn.changeAfterRetrieve(nested, 'unshare');
    expect(await connector().read(item(nested))).toEqual({ id: nested.id, reason: 'removed' });
    standIn.changeAfterRetrieve(big, 'forbid');
    expect(await connector().read(item(big))).toEqual({ id: big.id, reason: 'no_access' });
  });

  it('retrieves the page again when a nested block vanishes mid-read: gone answers removed, still there throws unavailable', async () => {
    standIn.vanish(mid.id, true);
    expect(await connector().read(item(nested))).toEqual({ id: nested.id, reason: 'removed' });
    expect(standIn.seen('GET /v1/pages/:id').map((call) => call.id)).toEqual([nested.id, nested.id]);
    standIn.reset();
    standIn.share([nested]);
    standIn.children(nested.id, nestedBlocks);
    standIn.vanish(mid.id, false);
    await expect(connector().read(item(nested))).rejects.toMatchObject({ name: 'NotionFault', reason: 'unavailable' });
  });

  it('throws rate_limited on a 429 mid-page and answers nothing of the page', async () => {
    standIn.rateLimitCall(3, 30);
    await expect(connector().read(item(nested))).rejects.toMatchObject({ name: 'NotionFault', reason: 'rate_limited', retryAfterMs: 30_000 });
    expect(standIn.calls()).toBe(3);
  });

  it('writes no address of an image, an embed or a bookmark into a page read', async () => {
    const withFiles = page(40, 'With files');
    standIn.share([withFiles]);
    standIn.children(withFiles.id, [
      block('image', { type: 'external', external: { url: 'https://evil.example/x.png' }, caption: [{ type: 'text', plain_text: 'Q3 chart' }] }),
      block('embed', { url: 'https://evil.example/embed', caption: [] }),
      block('bookmark', { url: 'https://evil.example/bookmark', caption: [{ type: 'text', plain_text: 'Reading' }] }),
      said('paragraph', 'Body'),
    ]);
    const read = await connector().read(item(withFiles));
    expect(read).toMatchObject({ content: { text: 'Q3 chart\nReading\nBody' } });
    expect(JSON.stringify(read)).not.toContain('evil.example');
  });
});
