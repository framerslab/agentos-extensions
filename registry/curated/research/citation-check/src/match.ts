/**
 * @file match.ts
 * @description The classical checks, run before any model: whether a quotation's words stand on a page once both are
 * read the same way (compatibility forms, typographic quotation marks, dashes, case, white space and invisible
 * characters set aside, an ellipsis or a bracketed insertion read as a gap), never taking a match that cuts a word or a
 * number; and which of a page's sentences share the most content words with a claim.
 *
 * @module agentos/extensions/research/citation-check/match
 */

import { collapse, contentWords, exactSpan, fold, words } from '@framers/agentos-ext-grounding-guard/values';
import type { CitationPassage } from './types.js';

/** Characters a reader never sees: soft hyphens, zero-width spaces and joiners, word joiners, byte order marks. */
const INVISIBLE = /[­​-‍⁠﻿]/gu;
/** Dashes and minus signs, with the white space around them, read as one hyphen-minus. */
const DASHES = /\s*[‐-―−﹘﹣－-]+\s*/gu;
/** Where a quotation leaves words out or puts its own in: an ellipsis, or words in square brackets. */
const GAP = /\s*(?:\.{3,}|\[[^\]]*\])\s*/u;
/** Punctuation and quotation marks at the ends of a quotation's piece, which the page may set differently. */
const EDGES = /^[\s"',.;:!?]+|[\s"',.;:!?]+$/gu;

/** A text without the characters a reader never sees. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '');
}

/**
 * A text as the checks read it: NFKC, the invisible characters removed, typographic and angle quotation marks plain,
 * every dash a hyphen-minus with no space around it, lower case, white space collapsed.
 */
export function normalizeForMatch(text: string): string {
  const folded = fold(withoutInvisible(text.normalize('NFKC')))
    .replace(/[«»]/gu, '"')
    .replace(/[‹›]/gu, "'");
  return collapse(folded.replace(DASHES, '-').toLowerCase());
}

/**
 * A quotation's pieces as {@link normalizeForMatch} reads them: the words between its gaps (an ellipsis, a bracketed
 * insertion), each without the punctuation and quotation marks at its ends; pieces with no word are left out.
 */
export function quoteFragments(quotation: string): string[] {
  return normalizeForMatch(quotation)
    .split(GAP)
    .map((piece) => piece.replace(EDGES, ''))
    .filter((piece) => words(piece).length > 0);
}

/**
 * Where a quotation's pieces stand in a normalized text, each after the one before and none cutting a word or a number:
 * the offsets from the first piece's start to the last piece's end, or null when a piece does not stand there.
 *
 * @param text - The page's text, read with {@link normalizeForMatch}.
 * @param fragments - The quotation's pieces, from {@link quoteFragments}.
 */
export function locateQuote(text: string, fragments: readonly string[]): { start: number; end: number } | null {
  let offset = 0;
  let start = -1;
  let end = -1;
  for (const fragment of fragments) {
    // The rest of the text starts after the last match and its space, so the offsets `exactSpan` gives (into its own
    // collapsed copy) are offsets into this slice.
    while (text[offset] === ' ') offset += 1;
    const span = exactSpan(text.slice(offset), fragment);
    if (span === null) return null;
    if (start === -1) start = offset + span.start;
    end = offset + span.end;
    offset = end;
  }
  return start === -1 ? null : { start, end };
}

/**
 * The words a passage is compared by: its content words (three letters or more, no stop word) and every number, so "40
 * metres" and "31 metres" differ.
 */
function overlapTerms(text: string): Set<string> {
  const normalized = normalizeForMatch(text);
  return new Set([...contentWords(normalized), ...words(normalized).filter((word) => /\p{N}/u.test(word))]);
}

/**
 * The passages nearest a claim by shared words: each passage's Jaccard index over the content words and numbers of the
 * two (read with {@link normalizeForMatch}), the passages that share none left out and repeated passages counted once,
 * nearest first, ties in the passages' order.
 *
 * @param claim - The claim.
 * @param passages - The page's sentences, in page order.
 * @param count - The most passages answered.
 */
export function lexicalNearest(claim: string, passages: readonly string[], count: number): CitationPassage[] {
  const wanted = overlapTerms(claim);
  if (wanted.size === 0) return [];
  const seen = new Set<string>();
  const scored: Array<CitationPassage & { order: number }> = [];
  passages.forEach((text, order) => {
    if (seen.has(text)) return;
    seen.add(text);
    const have = overlapTerms(text);
    let shared = 0;
    for (const word of wanted) if (have.has(word)) shared += 1;
    if (shared === 0) return;
    scored.push({ text, score: shared / (wanted.size + have.size - shared), order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, Math.max(0, count)).map(({ text, score }) => ({ text, score }));
}
