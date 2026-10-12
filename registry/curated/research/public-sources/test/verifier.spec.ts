import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CitationVerifier } from '@framers/agentos';
import { describe, expect, it } from 'vitest';
import { citationSources, SourceLimiter, WikipediaSourceProvider } from '../src/index';

const LEAD = readFileSync(path.join(__dirname, 'fixtures/treaty-of-versailles-lead.html'), 'utf8');

/** Word counts over the words of all the texts at once: a stand-in embedding under which equal texts score 1. */
function wordCounts(texts: string[]): number[][] {
  const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const vocabulary = [...new Set(texts.flatMap(words))];
  return texts.map((text) => {
    const counts = new Array<number>(vocabulary.length).fill(0);
    for (const word of words(text)) counts[vocabulary.indexOf(word)] += 1;
    return counts;
  });
}

describe("citationSources with AgentOS's CitationVerifier", () => {
  it("grades a claim against the article's sentences and points the verdict at the article", async () => {
    const fetch = async (): Promise<Response> =>
      new Response(LEAD, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-revision-id': '1378834026' } });
    const wikipedia = new WikipediaSourceProvider({
      client: { name: 'TestClient', version: '1.0', contact: 'https://example.org/contact' },
      fetch,
      limiter: new SourceLimiter({ spacingMs: 0 }),
    });
    const page = await wikipedia.read({ key: 'Treaty_of_Versailles', title: 'Treaty of Versailles' });
    if (page.kind !== 'document') throw new Error('no document');
    const cut = (text: string) => [...text.matchAll(/[^.]+\./gu)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
    const verifier = new CitationVerifier({ embedFn: async (texts) => wordCounts(texts) });
    const result = await verifier.verify(['The Treaty of Versailles was a peace treaty signed on 28 June 1919.'], citationSources(page.document, cut));
    expect(result.claims[0]).toMatchObject({
      verdict: 'supported',
      sourceIndex: 0,
      sourceRef: 'https://en.wikipedia.org/wiki/Treaty_of_Versailles',
      sourceSnippet: 'The Treaty of Versailles was a peace treaty signed on 28 June 1919.',
    });
    expect(result.claims[0]?.confidence).toBeCloseTo(1, 6);
  });
});
