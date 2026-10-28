import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTION_LIMITS, NOTION_VERSION, NotionFault, createNotionPage, notionPageLink, planNotionPage, type NotionTextBlock } from '../src/index.js';

const TOKEN = 'fake-access';
const PAGES = 'https://api.notion.com/v1/pages';
const PAGE_ID = '59833787-2cf9-4fdf-8782-e53db20768a5';
const PAGE_LINK = 'https://app.notion.com/p/598337872cf94fdf8782e53db20768a5';

/** The append address of a block's children. */
function children(id: string): string {
  return `https://api.notion.com/v1/blocks/${id}/children`;
}

/** One request the stand-in received. */
interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** One queued answer: a status, a JSON body and headers, or an error the fetch throws. */
type Queued = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

/** Notion's API as a fetch stand-in: answers in the order queued, each request kept. */
function api(queued: Queued[]) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const text = typeof init?.body === 'string' ? init.body : '{}';
    seen.push({ url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(text) as Record<string, unknown> });
    const next = queued.shift();
    if (next === undefined) throw new Error('no answer queued');
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', ...next.headers } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

/** Notion's error answer in its common shape. */
function failure(status: number, code: string, additional?: Record<string, unknown>): Record<string, unknown> {
  return { object: 'error', status, code, message: 'fake message', ...(additional === undefined ? {} : { additional_data: additional }) };
}

/** A rich text array of one plain text. */
function plain(content: string): unknown[] {
  return [{ type: 'text', text: { content } }];
}

/** The blocks of a request body. */
function blocksOf(body: Record<string, unknown>): Array<Record<string, any>> {
  return body.children as Array<Record<string, any>>;
}

/** Every block of a request, its children included. */
function countBlocks(body: Record<string, unknown>): number {
  return blocksOf(body).reduce((sum, block) => sum + 1 + ((block[block.type]?.children as unknown[] | undefined)?.length ?? 0), 0);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createNotionPage', () => {
  it("makes a private page at the workspace level: no parent, the title and the blocks as typed plain text, under Notion's version", async () => {
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID, url: 'https://app.notion.com/p/Planning-call-598337872cf94fdf8782e53db20768a5', in_trash: false } }]);
    const blocks: NotionTextBlock[] = [
      { kind: 'heading_2', text: 'Summary' },
      { kind: 'paragraph', text: 'We moved the launch.' },
      { kind: 'bulleted_list_item', text: 'Ship on Friday', children: [{ kind: 'quote', text: '"Friday works for me."' }] },
      { kind: 'to_do', text: 'Book the room', checked: false },
      { kind: 'heading_3', text: 'Open questions' },
      { kind: 'numbered_list_item', text: 'Who signs off?' },
    ];
    const page = await createNotionPage({ accessToken: TOKEN, title: 'Planning call, 27 October', blocks }, { fetchImpl: stand.fetchImpl });
    expect(page).toEqual({ id: PAGE_ID, url: 'https://app.notion.com/p/Planning-call-598337872cf94fdf8782e53db20768a5' });
    expect(stand.seen).toHaveLength(1);
    const sent = stand.seen[0]!;
    expect(sent).toMatchObject({ url: PAGES, method: 'POST' });
    expect(sent.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'notion-version': NOTION_VERSION, 'content-type': 'application/json' });
    expect(sent.body).toEqual({
      properties: { title: { title: plain('Planning call, 27 October') } },
      children: [
        { object: 'block', type: 'heading_2', heading_2: { rich_text: plain('Summary') } },
        { object: 'block', type: 'paragraph', paragraph: { rich_text: plain('We moved the launch.') } },
        {
          object: 'block',
          type: 'bulleted_list_item',
          bulleted_list_item: { rich_text: plain('Ship on Friday'), children: [{ object: 'block', type: 'quote', quote: { rich_text: plain('"Friday works for me."') } }] },
        },
        { object: 'block', type: 'to_do', to_do: { rich_text: plain('Book the room'), checked: false } },
        { object: 'block', type: 'heading_3', heading_3: { rich_text: plain('Open questions') } },
        { object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: plain('Who signs off?') } },
      ],
    });
  });

  it('puts the page under a page it is given', async () => {
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID } }]);
    await createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [], parentPageId: '0c8f6c8e-8d4c-4b2e-9a51-3f1f2f6a7b90' }, { fetchImpl: stand.fetchImpl });
    expect(stand.seen[0]?.body).toEqual({ parent: { page_id: '0c8f6c8e-8d4c-4b2e-9a51-3f1f2f6a7b90' }, properties: { title: { title: plain('Notes') } }, children: [] });
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [], parentPageId: 'not an id' }, { fetchImpl: stand.fetchImpl })).rejects.toMatchObject({ reason: 'configuration' });
  });

  it("links a page by its id when Notion's answer carries no address, as an Insert-only connection's partial page does, or one off Notion's hosts", async () => {
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID } }, { status: 200, body: { object: 'page', id: PAGE_ID, url: 'https://pages.example.test/p/elsewhere' } }]);
    expect(await createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl })).toEqual({ id: PAGE_ID, url: PAGE_LINK });
    expect(await createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl })).toEqual({ id: PAGE_ID, url: PAGE_LINK });
    expect(notionPageLink(PAGE_ID)).toBe(PAGE_LINK);
    expect(() => notionPageLink('not an id')).toThrow(NotionFault);
  });

  it('splits a text past 2,000 characters into rich text items, never inside a surrogate pair, and cleans control characters and lone surrogates', () => {
    const long = `${'a'.repeat(1999)}\u{1F600}${'b'.repeat(2500)}`;
    const plan = planNotionPage('Notes', [{ kind: 'paragraph', text: long }, { kind: 'paragraph', text: 'a\u0000b\u0007c\r\nd\te\uD800f' }]);
    const [first, second] = blocksOf(plan.create);
    const items = first?.paragraph.rich_text as Array<{ text: { content: string } }>;
    expect(items.map((item) => item.text.content.length)).toEqual([1999, 2000, 502]);
    expect(items.map((item) => item.text.content).join('')).toBe(long);
    expect(second?.paragraph.rich_text).toEqual(plain('abc\nd\te�f'));
    expect(plan.appends).toEqual([]);
  });

  it('writes more than 100 blocks as the page and then appends the rest in order, 100 at a time, at the end', async () => {
    const blocks: NotionTextBlock[] = Array.from({ length: 250 }, (_, i) => ({ kind: 'paragraph', text: `line ${i}` }));
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID } }, { status: 200, body: { object: 'list', results: [] } }, { status: 200, body: { object: 'list', results: [] } }]);
    expect(await createNotionPage({ accessToken: TOKEN, title: 'Long', blocks }, { fetchImpl: stand.fetchImpl })).toEqual({ id: PAGE_ID, url: PAGE_LINK });
    expect(stand.seen.map((request) => [request.method, request.url])).toEqual([['POST', PAGES], ['PATCH', children(PAGE_ID)], ['PATCH', children(PAGE_ID)]]);
    expect(stand.seen.map((request) => blocksOf(request.body).length)).toEqual([100, 100, 50]);
    expect(blocksOf(stand.seen[1]!.body)[0]?.paragraph.rich_text).toEqual(plain('line 100'));
    expect(blocksOf(stand.seen[2]!.body)[49]?.paragraph.rich_text).toEqual(plain('line 249'));
    for (const request of stand.seen.slice(1)) {
      expect(Object.keys(request.body)).toEqual(['children']);
      expect(request.headers).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'notion-version': NOTION_VERSION });
    }
  });

  it("keeps every request inside Notion's limits of 100 blocks an array, 1,000 blocks and the byte cap", () => {
    const nested: NotionTextBlock[] = Array.from({ length: 100 }, (_, i) => ({
      kind: 'bulleted_list_item',
      text: `item ${i}`,
      children: Array.from({ length: 100 }, (_, j) => ({ kind: 'paragraph' as const, text: `detail ${i}.${j}` })),
    }));
    const plan = planNotionPage('Nested', nested);
    const requests = [plan.create, ...plan.appends];
    expect(requests.map((request) => blocksOf(request).length)).toEqual([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 1]);
    for (const request of requests) {
      expect(blocksOf(request).length).toBeLessThanOrEqual(NOTION_LIMITS.blocksPerArray);
      expect(countBlocks(request)).toBeLessThanOrEqual(NOTION_LIMITS.blocksPerRequest);
      expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(NOTION_LIMITS.requestBytes);
    }
    const wide: NotionTextBlock[] = Array.from({ length: 300 }, () => ({ kind: 'paragraph', text: 'x'.repeat(4000) }));
    const widePlan = planNotionPage('Wide', wide);
    for (const request of [widePlan.create, ...widePlan.appends]) expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThanOrEqual(NOTION_LIMITS.requestBytes);
    expect([widePlan.create, ...widePlan.appends].reduce((sum, request) => sum + blocksOf(request).length, 0)).toBe(300);
  });

  it('refuses before any call what Notion cannot take or the library does not write', async () => {
    const stand = api([]);
    const write = (title: string, blocks: unknown, accessToken = TOKEN) => createNotionPage({ accessToken, title, blocks: blocks as NotionTextBlock[] }, { fetchImpl: stand.fetchImpl });
    await expect(write('Notes', [{ kind: 'paragraph', text: 'x'.repeat(NOTION_LIMITS.textChars * NOTION_LIMITS.richTextItems + 1) }])).rejects.toMatchObject({ reason: 'too_large' });
    await expect(write('Notes', [{ kind: 'paragraph', text: 'x', children: Array.from({ length: 101 }, () => ({ kind: 'paragraph', text: 'y' })) }])).rejects.toMatchObject({ reason: 'too_large' });
    await expect(write('Notes', [{ kind: 'bulleted_list_item', text: 'x', children: Array.from({ length: 100 }, () => ({ kind: 'paragraph', text: 'y'.repeat(100 * 2000) })) }])).rejects.toMatchObject({ reason: 'too_large' });
    await expect(write('Notes', [{ kind: 'paragraph', text: 'x', children: [{ kind: 'paragraph', text: 'y', children: [{ kind: 'paragraph', text: 'z' }] }] }])).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('Notes', [{ kind: 'heading_2', text: 'x', children: [{ kind: 'paragraph', text: 'y' }] }])).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('Notes', [{ kind: 'image', text: 'x' }])).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('Notes', [{ kind: 'paragraph', text: 7 }])).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('Notes', 'not blocks')).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('', [])).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('x'.repeat(NOTION_LIMITS.titleChars + 1), [])).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('Notes', [], '')).rejects.toMatchObject({ reason: 'configuration' });
    await expect(write('Notes', [], 'has space')).rejects.toMatchObject({ reason: 'configuration' });
    expect(stand.seen).toHaveLength(0);
  });

  it("answers Notion's refusals of the page with fixed reasons, once each, never retried", async () => {
    const cases: Array<[number, Record<string, unknown>, Record<string, string>, Record<string, unknown>]> = [
      [401, failure(401, 'unauthorized'), {}, { reason: 'unauthorized', status: 401, code: 'unauthorized' }],
      [403, failure(403, 'restricted_resource'), {}, { reason: 'restricted', status: 403, code: 'restricted_resource' }],
      [404, failure(404, 'object_not_found'), {}, { reason: 'restricted', status: 404 }],
      [400, failure(400, 'validation_error'), {}, { reason: 'refused', status: 400, code: 'validation_error' }],
      [409, failure(409, 'conflict_error'), {}, { reason: 'unavailable', status: 409 }],
      [429, failure(429, 'rate_limited'), { 'retry-after': '7' }, { reason: 'rate_limited', status: 429, retryAfterMs: 7000 }],
      [429, failure(429, 'rate_limited', { rate_limit_reason: 'public_api_request_blocked' }), { 'retry-after': '7' }, { reason: 'restricted', status: 429 }],
      [529, failure(529, 'service_overload'), { 'retry-after': '3' }, { reason: 'rate_limited', status: 529, retryAfterMs: 3000 }],
      [500, failure(500, 'internal_server_error'), {}, { reason: 'unknown_outcome', status: 500 }],
      [502, failure(502, 'bad_gateway'), {}, { reason: 'unknown_outcome', status: 502 }],
      [503, failure(503, 'service_unavailable'), {}, { reason: 'unknown_outcome', status: 503 }],
      [504, failure(504, 'gateway_timeout'), {}, { reason: 'unknown_outcome', status: 504 }],
    ];
    for (const [status, body, headers, expected] of cases) {
      const stand = api([{ status, body, headers }]);
      const refused = await createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(NotionFault);
      expect(refused).toMatchObject(expected);
      expect((refused as NotionFault).pageId).toBeUndefined();
      expect(stand.seen).toHaveLength(1);
    }
  });

  it('takes a 503 whose answer names the page it committed as the page made, and a lost answer as an unknown outcome', async () => {
    const committed = api([{ status: 503, body: failure(503, 'service_unavailable', { committed_resource_id: PAGE_ID }) }]);
    expect(await createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: committed.fetchImpl })).toEqual({ id: PAGE_ID, url: PAGE_LINK });
    const lost = api([new TypeError('fetch failed')]);
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: lost.fetchImpl })).rejects.toMatchObject({ reason: 'unknown_outcome' });
    const empty = api([{ status: 200, body: { object: 'page' } }]);
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: empty.fetchImpl })).rejects.toMatchObject({ reason: 'invalid_response' });
  });

  it('names the page it made when an append fails, and stops there', async () => {
    const blocks: NotionTextBlock[] = Array.from({ length: 250 }, (_, i) => ({ kind: 'paragraph', text: `line ${i}` }));
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID } }, { status: 200, body: { object: 'list', results: [] } }, { status: 429, body: failure(429, 'rate_limited'), headers: { 'retry-after': '2' } }]);
    const refused = await createNotionPage({ accessToken: TOKEN, title: 'Long', blocks }, { fetchImpl: stand.fetchImpl }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotionFault);
    expect(refused).toMatchObject({ reason: 'rate_limited', pageId: PAGE_ID, retryAfterMs: 2000 });
    expect(stand.seen).toHaveLength(3);
  });

  it('starts nothing once the caller has cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID } }]);
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl, signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled' });
    expect(stand.seen).toHaveLength(0);
  });

  it("takes a stand-in's API address only on CI, at a loopback or .invalid host", async () => {
    vi.stubEnv('CI', 'true');
    const stand = api([{ status: 200, body: { object: 'page', id: PAGE_ID } }]);
    await createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl, apiBase: 'http://127.0.0.1:9440' });
    expect(stand.seen[0]?.url).toBe('http://127.0.0.1:9440/v1/pages');
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl, apiBase: 'https://notion.example.com' })).rejects.toMatchObject({ reason: 'configuration' });
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl, apiBase: 'http://127.0.0.1:9440/v1' })).rejects.toMatchObject({ reason: 'configuration' });
    vi.stubEnv('CI', 'false');
    await expect(createNotionPage({ accessToken: TOKEN, title: 'Notes', blocks: [] }, { fetchImpl: stand.fetchImpl, apiBase: 'http://127.0.0.1:9440' })).rejects.toMatchObject({ reason: 'configuration' });
    expect(stand.seen).toHaveLength(1);
  });
});
