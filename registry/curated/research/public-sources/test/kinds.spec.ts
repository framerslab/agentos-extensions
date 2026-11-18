import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { citationSources, isSourceWord, kindOfHost, SOURCE_KINDS, SourceLimiter, WikipediaSourceProvider, type SourceDocument } from '../src/index';

// A source's label: the kind of source a host is, read from the host alone; the words a provider or a kind may be; and
// the provider, the finders, the kind and the icon a document carries into each of its passages.

const LEAD = readFileSync(path.join(__dirname, 'fixtures/treaty-of-versailles-lead.html'), 'utf8');
const CLIENT = { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' };

/** A fetch that answers every request with the article's HTML. */
function articleFetch(): typeof globalThis.fetch {
  return vi.fn(async () => new Response(LEAD, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-revision-id': '1378834026' } })) as unknown as typeof globalThis.fetch;
}

/** Each sentence ending in a full stop, as offsets. */
const cut = (text: string) => [...text.matchAll(/[^.]+\./gu)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));

describe('kindOfHost', () => {
  it('reads the Wikimedia hosts and the reference works as encyclopedias', () => {
    expect(kindOfHost('en.wikipedia.org')).toBe('encyclopedia');
    expect(kindOfHost('commons.wikimedia.org')).toBe('encyclopedia');
    expect(kindOfHost('www.britannica.com')).toBe('encyclopedia');
    expect(kindOfHost('plato.stanford.edu')).toBe('encyclopedia');
  });

  it('reads government, university, international and military hosts as official', () => {
    expect(kindOfHost('www.cdc.gov')).toBe('official');
    expect(kindOfHost('data.gov.uk')).toBe('official');
    expect(kindOfHost('web.mit.edu')).toBe('official');
    expect(kindOfHost('www.who.int')).toBe('official');
    expect(kindOfHost('www.army.mil')).toBe('official');
    expect(kindOfHost('www.un.org')).toBe('official');
    expect(kindOfHost('ec.europa.eu')).toBe('official');
  });

  it('reads identifier, journal and preprint hosts as papers, a government journal host included', () => {
    expect(kindOfHost('doi.org')).toBe('paper');
    expect(kindOfHost('arxiv.org')).toBe('paper');
    expect(kindOfHost('export.arxiv.org')).toBe('paper');
    expect(kindOfHost('pubmed.ncbi.nlm.nih.gov')).toBe('paper');
    expect(kindOfHost('www.nature.com')).toBe('paper');
  });

  it('reads news hosts as news, and forums and question sites as forums', () => {
    expect(kindOfHost('apnews.com')).toBe('news');
    expect(kindOfHost('www.bbc.co.uk')).toBe('news');
    expect(kindOfHost('old.reddit.com')).toBe('forum');
    expect(kindOfHost('stackoverflow.com')).toBe('forum');
  });

  it('answers page for a host it does not list, and reads a host whatever its case, its trailing dot and its "www."', () => {
    expect(kindOfHost('harbour.example.org')).toBe('page');
    expect(kindOfHost('notgov.example')).toBe('page');
    expect(kindOfHost('WWW.CDC.GOV.')).toBe('official');
    expect(kindOfHost('')).toBe('page');
  });

  it("puts the host's overrides first, for a host and every name under it, the longest name first", () => {
    const overrides = { 'example.org': 'news', 'blog.example.org': 'forum', 'cdc.gov': 'paper' };
    expect(kindOfHost('example.org', overrides)).toBe('news');
    expect(kindOfHost('www.example.org', overrides)).toBe('news');
    expect(kindOfHost('a.blog.example.org', overrides)).toBe('forum');
    expect(kindOfHost('www.cdc.gov', overrides)).toBe('paper');
    expect(kindOfHost('other.example', overrides)).toBe('page');
  });

  it('refuses an override whose kind is not a source word', () => {
    expect(() => kindOfHost('example.org', { 'example.org': 'Local News' })).toThrow(RangeError);
  });
});

describe('isSourceWord and SOURCE_KINDS', () => {
  it('holds a word to a lower-case letter, then up to 31 lower-case letters, digits, "_" or "-"', () => {
    expect(isSourceWord('brave')).toBe(true);
    expect(isSourceWord('news_wire-2')).toBe(true);
    expect(isSourceWord(`a${'b'.repeat(31)}`)).toBe(true);
    expect(isSourceWord(`a${'b'.repeat(32)}`)).toBe(false);
    expect(isSourceWord('Brave.Search')).toBe(false);
    expect(isSourceWord('2nd')).toBe(false);
    expect(isSourceWord('')).toBe(false);
    expect(isSourceWord('über')).toBe(false);
  });

  it('names the known kinds, each a source word', () => {
    expect(SOURCE_KINDS).toEqual(['encyclopedia', 'official', 'paper', 'news', 'page', 'forum']);
    expect(SOURCE_KINDS.every((kind) => isSourceWord(kind))).toBe(true);
  });
});

describe('the label on a document and its passages', () => {
  it("Wikipedia's provider answers a document with its provider and kind, and citationSources copies both", async () => {
    const wiki = new WikipediaSourceProvider({ client: CLIENT, fetch: articleFetch(), now: () => 1_791_460_800_000, limiter: new SourceLimiter({ spacingMs: 0 }) });
    const outcome = await wiki.read({ key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' });
    if (outcome.kind !== 'document') throw new Error('expected a document');
    expect(outcome.document.provider).toBe('wikipedia');
    expect(outcome.document.kind).toBe('encyclopedia');
    const [first] = citationSources(outcome.document, cut);
    expect(first).toMatchObject({ provider: 'wikipedia', kind: 'encyclopedia' });
    expect(first).not.toHaveProperty('foundThrough');
    expect(first).not.toHaveProperty('icon');
  });

  it('citationSources copies the finders and the icon, each passage its own list, and leaves out what the document lacks', () => {
    const document: SourceDocument = {
      site: 'harbour.example.org',
      key: 'https://harbour.example.org/history',
      title: 'Port history',
      url: 'https://harbour.example.org/history',
      revision: null,
      readAt: 0,
      licence: { name: 'not read', url: '' },
      blocks: ['The harbour opened in 1887. Its lighthouse stands 31 metres tall.'],
      provider: 'serper',
      foundThrough: ['serper', 'tavily'],
      kind: 'page',
      icon: 'data:image/png;base64,iVBORw0KGgo=',
    };
    const [first, second] = citationSources(document, cut);
    expect(first).toMatchObject({ provider: 'serper', foundThrough: ['serper', 'tavily'], kind: 'page', icon: 'data:image/png;base64,iVBORw0KGgo=' });
    first?.foundThrough?.push('brave');
    expect(second?.foundThrough).toEqual(['serper', 'tavily']);
    expect(document.foundThrough).toEqual(['serper', 'tavily']);
    const { provider: _provider, foundThrough: _found, kind: _kind, icon: _icon, ...bare } = document;
    const [plain] = citationSources(bare, cut);
    for (const field of ['provider', 'foundThrough', 'kind', 'icon']) expect(plain).not.toHaveProperty(field);
  });
});
