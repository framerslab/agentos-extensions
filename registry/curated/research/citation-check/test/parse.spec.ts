import { describe, expect, it } from 'vitest';
import { CitationInputError, parseCitedClaims } from '../src/index';

describe('parseCitedClaims on markdown', () => {
  it('pairs each quoted sentence with the address in the parenthesis after it, keeping its line', () => {
    const text = [
      '# Notes',
      '',
      'The report says "The harbour opened in 1887 and handled 4,200 ships in its first year." (https://example.org/harbour, read 1 Mar 2026)',
      '',
      '- A guide notes that “the lighthouse stands 31 metres tall” (<https://example.org/light>).',
    ].join('\n');
    expect(parseCitedClaims(text)).toEqual([
      { line: 3, claim: 'The harbour opened in 1887 and handled 4,200 ships in its first year.', url: 'https://example.org/harbour', exact: true },
      { line: 5, claim: 'the lighthouse stands 31 metres tall', url: 'https://example.org/light', exact: true },
    ]);
  });

  it('binds every quote waiting in the sentence to the next address, trims the prose around the address and keeps its own brackets', () => {
    const text = [
      'The page lists "Five berths", and "Two cranes lift the containers" (https://example.org/port, read 2 Mar 2026).',
      'An encyclopedia says "the river floods each spring" (https://example.org/wiki/River_(Delta)).',
      'Another says "the bridge carries two lanes" (https://example.org/bridge).',
    ].join('\n');
    expect(parseCitedClaims(text)).toEqual([
      { line: 1, claim: 'Five berths', url: 'https://example.org/port', exact: true },
      { line: 1, claim: 'Two cranes lift the containers', url: 'https://example.org/port', exact: true },
      { line: 2, claim: 'the river floods each spring', url: 'https://example.org/wiki/River_(Delta)', exact: true },
      { line: 3, claim: 'the bridge carries two lanes', url: 'https://example.org/bridge', exact: true },
    ]);
  });

  it('takes a bare address or a markdown link later in the sentence, on the same line or the next line of the paragraph', () => {
    const text = [
      'Its table reads "Twelve berths serve cargo ships" and the page is https://example.org/berths.',
      '',
      'The keeper wrote "the brightest light on the coast", see',
      '[the log](https://example.org/log "Log").',
      '',
      '"A quote that spans',
      'two lines of the paragraph" (https://example.org/span)',
    ].join('\n');
    expect(parseCitedClaims(text)).toEqual([
      { line: 1, claim: 'Twelve berths serve cargo ships', url: 'https://example.org/berths', exact: true },
      { line: 3, claim: 'the brightest light on the coast', url: 'https://example.org/log', exact: true },
      { line: 6, claim: 'A quote that spans two lines of the paragraph', url: 'https://example.org/span', exact: true },
    ]);
  });

  it('reports a quote of four words or more that no address follows in its sentence as uncited, and passes over shorter ones', () => {
    const text = [
      'The so-called "short quote" stays out. The page claims "the tide rises twice each day". It is sourced later (https://example.org/later).',
      '',
      '> "A quoted line in a block quotation without any source"',
    ].join('\n');
    expect(parseCitedClaims(text)).toEqual([
      { line: 1, claim: 'the tide rises twice each day', url: null, exact: true },
      { line: 3, claim: 'A quoted line in a block quotation without any source', url: null, exact: true },
    ]);
  });

  it('ignores quotes inside fenced code and code spans, escaped quote marks, and a sentence end inside parentheses or after an abbreviation', () => {
    const text = [
      '```',
      'say "this is code, not a claim at all" (https://example.org/code)',
      '```',
      'Use `"not a claim either"` with \\"escaped marks\\" here.',
      'Smith et al. wrote "the dock was rebuilt in 1990" (Annual review, vol. 2. https://example.org/dock).',
    ].join('\n');
    expect(parseCitedClaims(text)).toEqual([
      { line: 5, claim: 'the dock was rebuilt in 1990', url: 'https://example.org/dock', exact: true },
    ]);
  });
});

describe('parseCitedClaims on JSON', () => {
  it('reads an array of claims with the line each starts on, an absent exact as true, and no address as uncited', () => {
    const text = [
      '[',
      '  { "claim": "The harbour opened in 1887", "url": "https://example.org/harbour", "exact": true },',
      '  {',
      '    "claim": "Roughly four thousand vessels called in the first year",',
      '    "url": "https://example.org/harbour#history",',
      '    "exact": false',
      '  },',
      '  { "claim": "Twelve berths serve cargo ships", "url": "http://example.org/berths" },',
      '  { "claim": "The tide rises twice each day", "url": "" }',
      ']',
    ].join('\n');
    expect(parseCitedClaims(text)).toEqual([
      { line: 2, claim: 'The harbour opened in 1887', url: 'https://example.org/harbour', exact: true },
      { line: 3, claim: 'Roughly four thousand vessels called in the first year', url: 'https://example.org/harbour#history', exact: false },
      { line: 8, claim: 'Twelve berths serve cargo ships', url: 'http://example.org/berths', exact: true },
      { line: 9, claim: 'The tide rises twice each day', url: null, exact: true },
    ]);
  });

  it('reads JSON only when asked or when the document is a JSON array, and markdown otherwise', () => {
    expect(parseCitedClaims('[A link](https://example.org/a) then "a quoted claim of five words" (https://example.org/b)')).toEqual([
      { line: 1, claim: 'a quoted claim of five words', url: 'https://example.org/b', exact: true },
    ]);
    expect(parseCitedClaims('"a quoted claim of five words" (https://example.org/b)', { format: 'markdown' })).toHaveLength(1);
    expect(() => parseCitedClaims('"a quoted claim" (https://example.org/b)', { format: 'json' })).toThrow(CitationInputError);
  });

  it('refuses an entry with no claim, an address that is not http or https, an exact that is not a boolean, and a document that is not an array', () => {
    expect(() => parseCitedClaims('[{ "url": "https://example.org/a" }]')).toThrow(/entry 1 \(line 1\) has no claim/u);
    expect(() => parseCitedClaims('[\n{ "claim": "x y z", "url": "ftp://example.org/a" }\n]')).toThrow(/entry 1 \(line 2\).*http or https/u);
    expect(() => parseCitedClaims('[{ "claim": "x y z", "exact": "yes" }]')).toThrow(/exact/u);
    expect(() => parseCitedClaims('{ "claim": "x y z" }', { format: 'json' })).toThrow(/array/u);
    expect(() => parseCitedClaims('[1]')).toThrow(CitationInputError);
  });
});
