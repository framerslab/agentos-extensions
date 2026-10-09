import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { VerificationSource } from '@framers/agentos';
import { describe, expect, it, vi } from 'vitest';
import { citationSources, LimiterRefused, SourceLimiter, WikipediaSourceProvider, WIKIPEDIA_LICENCE } from '../src/index';

const LEAD = readFileSync(path.join(__dirname, 'fixtures/treaty-of-versailles-lead.html'), 'utf8');
const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

interface Seen {
  url: string;
  headers: Headers;
  redirect: RequestRedirect | undefined;
}

/** A fetch that answers from a list of responses in order and records what it was asked. */
function scripted(...answers: Array<() => Response>) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), headers: new Headers(init?.headers), redirect: init?.redirect });
    const next = answers.shift();
    if (next === undefined) throw new Error('no answer scripted');
    return next();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen, calls: fetch };
}

const json = (body: unknown, init: ResponseInit = {}) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
const html = (body: string, headers: Record<string, string> = {}) => () =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8; profile="https://www.mediawiki.org/wiki/Specs/HTML/2.8.0"', 'content-revision-id': '1378834026', ...headers } });

function provider(fetch: typeof globalThis.fetch, now = () => 1_791_460_800_000) {
  return new WikipediaSourceProvider({ client: CLIENT, fetch, now, limiter: new SourceLimiter({ spacingMs: 0 }) });
}

describe('WikipediaSourceProvider.search', () => {
  it("asks the REST search for the phrase, with the policy's User-Agent and gzip, and keeps hits with a key and a title", async () => {
    const onSend = vi.fn();
    const { fetch, seen } = scripted(json({ pages: [
      { id: 30030, key: 'Treaty_of_Versailles', title: 'Treaty of Versailles', excerpt: 'x' },
      { id: 1, title: 'No key' },
      { id: 19362662, key: 'Treaty_of_Versailles_(1768)', title: 'Treaty of Versailles (1768)' },
      { id: 2, key: 'Third', title: 'Third' },
    ] }));
    const outcome = await provider(fetch).search('Treaty of Versailles', { limit: 2, onSend });
    expect(outcome).toEqual({ kind: 'hits', hits: [
      { key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' },
      { key: 'Treaty_of_Versailles_(1768)', title: 'Treaty of Versailles (1768)' },
    ] });
    expect(seen[0]?.url).toBe('https://en.wikipedia.org/w/rest.php/v1/search/page?q=Treaty%20of%20Versailles&limit=2');
    expect(seen[0]?.headers.get('user-agent')).toBe('TestClient/1.0 (https://example.org/contact)');
    expect(seen[0]?.headers.get('accept-encoding')).toBe('gzip');
    expect(seen[0]?.headers.get('accept')).toBe('application/json');
    expect(seen[0]?.headers.has('cookie')).toBe(false);
    expect(seen[0]?.redirect).toBe('error');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('answers failed with the status for an error, blocks the limiter on a 429, and then refuses without a request', async () => {
    const onSend = vi.fn();
    const { fetch, calls } = scripted(() => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }));
    const wiki = provider(fetch);
    expect(await wiki.search('Treaty of Versailles', { onSend })).toEqual({ kind: 'failed', status: 429 });
    expect(await wiki.search('Treaty of Versailles', { onSend })).toEqual({ kind: 'limited' });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("answers limited with nothing sent when the caller's onSend refuses the search (a quota of its own)", async () => {
    const { fetch, calls } = scripted(() => new Response('{"pages":[]}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const refusing = () => {
      throw new LimiterRefused('caller');
    };
    expect(await provider(fetch).search('Treaty of Versailles', { onSend: refusing })).toEqual({ kind: 'limited' });
    expect(calls).not.toHaveBeenCalled();
  });

  it('answers failed for a body that is not the expected JSON, one over 65,536 bytes, and a transport failure such as a redirect', async () => {
    const big = JSON.stringify({ pages: [{ key: 'a', title: 'x'.repeat(70_000) }] });
    const { fetch } = scripted(
      () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }),
      () => { throw new TypeError('fetch failed: redirect mode is set to error'); },
    );
    const wiki = provider(fetch);
    expect(await wiki.search('a')).toEqual({ kind: 'failed', status: 200 });
    expect(await wiki.search('a')).toEqual({ kind: 'failed', status: 200 });
    expect(await wiki.search('a')).toEqual({ kind: 'failed', status: null });
  });

  it('answers no hits as an empty list', async () => {
    const { fetch } = scripted(json({ pages: [] }));
    expect(await provider(fetch).search('Nothing here')).toEqual({ kind: 'hits', hits: [] });
  });
});

describe('WikipediaSourceProvider.read', () => {
  const hit = { key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' };

  it("fetches the article's HTML by its key and answers its blocks with the revision, the address, the read time and the licence", async () => {
    const { fetch, seen } = scripted(html(LEAD));
    const outcome = await provider(fetch).read(hit);
    expect(seen[0]?.url).toBe('https://en.wikipedia.org/api/rest_v1/page/html/Treaty_of_Versailles');
    expect(seen[0]?.headers.get('accept')).toBe('text/html');
    expect(outcome.kind).toBe('document');
    if (outcome.kind !== 'document') return;
    expect(outcome.document).toMatchObject({
      site: 'Wikipedia',
      key: 'Treaty_of_Versailles',
      title: 'Treaty of Versailles',
      url: 'https://en.wikipedia.org/wiki/Treaty_of_Versailles',
      revision: '1378834026',
      readAt: 1_791_460_800_000,
      licence: WIKIPEDIA_LICENCE,
    });
    expect(outcome.document.blocks[0]).toMatch(/^The Treaty of Versailles was a peace treaty signed on 28 June 1919\./);
  });

  it("reads the revision from the ETag when the header is missing, and keeps a title's brackets in the address", async () => {
    const { fetch, seen } = scripted(html('<p>The Treaty of Versailles was a treaty concluded on 15 May 1768.</p>', { 'content-revision-id': '', etag: 'W/"1366357557/abc/view"' }));
    const outcome = await provider(fetch).read({ key: 'Treaty_of_Versailles_(1768)', title: 'Treaty of Versailles (1768)' });
    expect(seen[0]?.url).toBe('https://en.wikipedia.org/api/rest_v1/page/html/Treaty_of_Versailles_(1768)');
    expect(outcome).toMatchObject({ kind: 'document', document: { revision: '1366357557', url: 'https://en.wikipedia.org/wiki/Treaty_of_Versailles_(1768)' } });
  });

  it('skips an article that is not 200 HTML, declares more than it may send, or unpacks past the cap', async () => {
    const { fetch } = scripted(
      () => new Response('missing', { status: 404 }),
      () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      html('<p>x</p>', { 'content-length': '1500001' }),
      html(`<p>${'a'.repeat(1_200_000)}</p>`),
    );
    const wiki = new WikipediaSourceProvider({ client: CLIENT, fetch, limiter: new SourceLimiter({ spacingMs: 0 }), pageMaxBytes: 1_000_000 });
    expect(await wiki.read(hit)).toEqual({ kind: 'skipped', status: 404 });
    expect(await wiki.read(hit)).toEqual({ kind: 'skipped', status: 200 });
    expect(await wiki.read(hit)).toEqual({ kind: 'skipped', status: 200 });
    expect(await wiki.read(hit)).toEqual({ kind: 'skipped', status: 200 });
  });
});

describe('citationSources', () => {
  it("turns each sentence the caller's cut finds into a source with the article's attribution and its place", async () => {
    const { fetch } = scripted(html(LEAD));
    const outcome = await provider(fetch).read({ key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' });
    if (outcome.kind !== 'document') throw new Error('no document');
    const cut = (text: string) => [...text.matchAll(/[^.]+\./gu)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
    const sources = citationSources(outcome.document, cut);
    const first: VerificationSource = sources[0]!;
    expect(first.content.trim()).toBe('The Treaty of Versailles was a peace treaty signed on 28 June 1919.');
    expect(sources[0]).toMatchObject({ title: 'Treaty of Versailles', url: 'https://en.wikipedia.org/wiki/Treaty_of_Versailles', revision: '1378834026', block: 0, start: 0, site: 'Wikipedia' });
    expect(outcome.document.blocks[0]!.slice(sources[1]!.start, sources[1]!.end)).toBe(sources[1]!.content);
  });
});
