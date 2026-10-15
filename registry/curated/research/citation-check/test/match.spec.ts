import { describe, expect, it } from 'vitest';
import { lexicalNearest, locateQuote, normalizeForMatch, quoteFragments } from '../src/index';

describe('normalizeForMatch', () => {
  it('folds typographic quotes and dashes, case, white space, soft hyphens and compatibility forms', () => {
    expect(normalizeForMatch('The KEEPER’S “Log” — 1902–1903\u00A0\uFB01ne\u00ADtuned  «here»')).toBe(`the keeper's "log"-1902-1903 finetuned "here"`);
  });
});

describe('quoteFragments and locateQuote', () => {
  it('cuts a quotation at its ellipses and bracketed insertions, trims the punctuation at the ends of each piece, and finds the pieces in order', () => {
    const page = normalizeForMatch('The keeper’s log calls it the brightest light on the coast — a claim repeated in 1902–1903.');
    expect(quoteFragments('“The keeper’s log … repeated in 1902–1903,”')).toEqual(["the keeper's log", 'repeated in 1902-1903']);
    expect(quoteFragments('[It] calls it the brightest light [...] on the coast.')).toEqual(['calls it the brightest light', 'on the coast']);
    expect(locateQuote(page, quoteFragments('The keeper’s log … repeated in 1902–1903'))).toEqual({ start: 0, end: page.indexOf('1903') + 4 });
    expect(locateQuote(page, quoteFragments('repeated in 1902 … the keeper’s log'))).toBeNull();
  });

  it('never takes a match that cuts a word or a number', () => {
    const page = normalizeForMatch('The rate rose to 50 percent in the eastern districts.');
    expect(locateQuote(page, quoteFragments('rose to 5'))).toBeNull();
    expect(locateQuote(page, quoteFragments('east'))).toBeNull();
    expect(locateQuote(page, quoteFragments('rose to 50 percent'))).not.toBeNull();
    expect(locateQuote(page, quoteFragments('...'))).toBeNull();
  });
});

describe('lexicalNearest', () => {
  it('ranks passages by the share of content words and numbers they have in common with the claim, ties in page order, at most the count asked', () => {
    const passages = [
      'The harbour handled many ships.',
      'Ships arrived in the first year.',
      'The harbour is old.',
      'Fishing boats leave before dawn.',
      'Its first year was busy.',
      'The harbour handled many ships.',
    ];
    const nearest = lexicalNearest('The harbour handled 4,200 ships in its first year.', passages, 3);
    expect(nearest.map((passage) => passage.text)).toEqual(['The harbour handled many ships.', 'Ships arrived in the first year.', 'Its first year was busy.']);
    // The claim's terms: harbour, handled, 4, 200, ships, first, year. The first sentence shares three of the eight terms
    // the two hold between them.
    expect(nearest.map((passage) => passage.score)).toEqual([3 / 8, 3 / 8, 2 / 8]);
    expect(lexicalNearest('It stands 40 metres tall', ['It stands 31 metres tall.'], 1)[0]?.score).toBe(3 / 5);
    expect(lexicalNearest('Nothing in common here', passages, 3)).toEqual([]);
  });
});
