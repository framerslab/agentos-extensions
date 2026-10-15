import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { checkCitations, CitationInputError, parseCitedClaims, type CitationCheckOptions } from '../src/index';
import { guardNetwork, outsideAttempts, startFixtureServer, type FixtureServer } from './support';

// The runner over Node's own fetch against pages a server on the loopback address serves: each verdict the classical
// path gives, the page outcomes, and that no request leaves the machine.

let server: FixtureServer;
let restore: () => void;

beforeAll(async () => {
  restore = guardNetwork();
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
  restore();
});

afterEach(() => {
  expect(outsideAttempts.splice(0)).toEqual([]);
  server.received.length = 0;
});

/** The tests' options: no browser fallback and a short deadline. */
const QUIET: CitationCheckOptions = { fallback: false, timeoutMs: 400 };

function claim(line: number, text: string, path: string | null) {
  return { line, claim: text, url: path === null ? null : `${server.origin}${path}`, exact: true };
}

describe('checkCitations against pages on the loopback address', () => {
  it('finds a quote that stands on the page word for word, a table cell included, and names the sentence it stands in', async () => {
    const report = await checkCitations(
      [claim(1, 'The harbour opened in 1887 and handled 4,200 ships in its first year.', '/verbatim'), claim(2, 'Twelve berths serve cargo ships', '/verbatim')],
      QUIET,
    );
    expect(report.checks).toEqual([
      expect.objectContaining({ line: 1, verdict: 'exact', grader: 'exact', score: 1, passage: 'The harbour opened in 1887 and handled 4,200 ships in its first year.', nearest: [] }),
      expect.objectContaining({ line: 2, verdict: 'exact', grader: 'exact', score: 1, passage: 'Twelve berths serve cargo ships.' }),
    ]);
    expect(report.pages).toEqual([
      expect.objectContaining({ url: `${server.origin}/verbatim`, outcome: 'read', status: 200, failure: null, via: 'fetch' }),
    ]);
    expect(report.grading).toBe('lexical');
    expect(server.received.filter((request) => request.path === '/verbatim')).toHaveLength(1);
  });

  it('matches across typographic quotes, dashes, capitals, a non-breaking space, a soft hyphen and an ellipsis', async () => {
    const report = await checkCitations(
      [
        claim(1, "the keeper's log calls it the brightest light on the coast - a claim repeated in 1902-1903", '/typographic'),
        claim(2, 'The keeper’s log … repeated in 1902–1903.', '/typographic'),
      ],
      QUIET,
    );
    expect(report.checks.map((check) => check.verdict)).toEqual(['exact', 'exact']);
    expect(report.checks[0]?.passage).toBe('The KEEPER’S log calls it the brightest light on the coast — a claim repeated in 1902–1903.');
  });

  it('answers a paraphrase with no embedding function as not found, with the three passages nearest by shared words', async () => {
    const report = await checkCitations([claim(4, 'The harbour handled 4,200 ships in its first year.', '/paraphrase')], QUIET);
    const [check] = report.checks;
    expect(check).toMatchObject({ verdict: 'not_found', grader: 'lexical', passage: 'The harbour handled many ships.' });
    expect(check?.nearest.map((passage) => passage.text)).toEqual(['The harbour handled many ships.', 'Ships arrived in the first year.', 'Its first year was busy.']);
    expect(check?.score).toBeCloseTo(3 / 7, 6);
  });

  it('answers a page with no text as unreadable, a 404 as unreachable with its status, a page past the deadline as unreachable, and a PDF as unreadable', async () => {
    const started = Date.now();
    const report = await checkCitations(
      [
        claim(1, 'Anything at all on this page', '/empty'),
        claim(2, 'Anything at all on this page', '/missing'),
        claim(3, 'Anything at all on this page', '/slow'),
        claim(4, 'Anything at all on this page', '/report.pdf'),
      ],
      QUIET,
    );
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(report.checks.map((check) => [check.verdict, check.grader, check.score])).toEqual([
      ['unreadable', null, null],
      ['unreachable', null, null],
      ['unreachable', null, null],
      ['unreadable', null, null],
    ]);
    const outcome = (path: string) => report.pages.find((page) => page.url === `${server.origin}${path}`);
    expect(outcome('/empty')).toMatchObject({ outcome: 'unreadable', status: 200, failure: 'no_text' });
    expect(outcome('/missing')).toMatchObject({ outcome: 'unreachable', status: 404, failure: 'status' });
    expect(outcome('/slow')).toMatchObject({ outcome: 'unreachable', status: null, failure: 'timeout' });
    expect(outcome('/report.pdf')).toMatchObject({ outcome: 'unreadable', status: 200, failure: 'pdf' });
    expect(report.summary.counts).toMatchObject({ unreachable: 2, unreadable: 2, exact: 0 });
    expect(report.summary.unreachable.map((page) => page.failure).sort()).toEqual(['no_text', 'pdf', 'status', 'timeout']);
  });

  it('fetches each page once whatever its fragment, follows a redirect, reads a declared charset and plain text, and sends a browser-like User-Agent', async () => {
    const report = await checkCitations(
      [
        claim(1, 'The harbour opened in 1887', '/verbatim#history'),
        claim(2, 'Its lighthouse stands 31 metres tall', '/verbatim'),
        claim(3, 'Twelve berths serve cargo ships', '/moved'),
        claim(4, 'Café crème served daily', '/latin1'),
        claim(5, 'The archive keeps letters from 1850 onward', '/notes.txt'),
      ],
      QUIET,
    );
    expect(report.checks.map((check) => check.verdict)).toEqual(['exact', 'exact', 'exact', 'exact', 'exact']);
    expect(server.received.filter((request) => request.path === '/verbatim')).toHaveLength(2);
    expect(report.pages).toHaveLength(4);
    expect(report.pages.find((page) => page.url === `${server.origin}/moved`)).toMatchObject({ outcome: 'read', finalUrl: `${server.origin}/verbatim` });
    for (const request of server.received) expect(request.headers['user-agent']).toMatch(/^Mozilla\/5\.0 /u);
  });

  it('retries a page with no text through the fallback scraper and grades what it returns', async () => {
    const asked: string[] = [];
    const scraper = {
      scrape: async (input: { url: string }) => {
        asked.push(input.url);
        return { success: true, url: input.url, tier: 4 as const, statusCode: 200, html: '<p>Rendered by a browser: the harbour opened in 1887.</p>' };
      },
    };
    const report = await checkCitations([claim(1, 'the harbour opened in 1887', '/empty')], { ...QUIET, fallback: scraper });
    expect(asked).toEqual([`${server.origin}/empty`]);
    expect(report.checks[0]).toMatchObject({ verdict: 'exact', passage: 'Rendered by a browser: the harbour opened in 1887.' });
    expect(report.pages[0]).toMatchObject({ outcome: 'read', via: 'fallback' });
  });

  it('keeps an uncited claim off the network and lists it in the summary', async () => {
    const report = await checkCitations([claim(9, 'A claim that names no source at all', null)], QUIET);
    expect(report.checks).toEqual([
      { line: 9, claim: 'A claim that names no source at all', url: null, exact: true, verdict: 'uncited', grader: null, score: null, passage: null, nearest: [], note: null },
    ]);
    expect(report.pages).toEqual([]);
    expect(report.summary).toMatchObject({ claims: 1, pages: 0, uncited: [{ line: 9, claim: 'A claim that names no source at all' }] });
    expect(server.received).toHaveLength(0);
  });

  it('never reaches a host other than the fixture server: the guard refuses it and the claim is unreachable', async () => {
    const report = await checkCitations(parseCitedClaims('He wrote "a claim about another host entirely" (https://page.example.invalid/a).'), QUIET);
    expect(report.checks[0]).toMatchObject({ verdict: 'unreachable' });
    expect(report.pages[0]).toMatchObject({ outcome: 'unreachable', failure: 'network' });
    expect(outsideAttempts.splice(0)).toEqual(['fetch https://page.example.invalid']);
  });

  it('refuses more distinct pages than maxPages before it fetches any', async () => {
    const claims = ['/verbatim', '/typographic', '/paraphrase'].map((path, index) => claim(index + 1, 'Any claim of five words', path));
    await expect(checkCitations(claims, { ...QUIET, maxPages: 2 })).rejects.toThrow(CitationInputError);
    expect(server.received).toHaveLength(0);
  });
});
