/**
 * @file types.ts
 * @description What the citation check reads and writes: a cited claim as the parser finds it, the verdict on it with
 * the passage it rests on, how each page fared, and the report with its summary.
 *
 * @module agentos/extensions/research/citation-check/types
 */

import type { ClaimVerdictKind } from '@framers/agentos';

/** A claim and the address it cites, as a document gives them. */
export interface CitedClaim {
  /** The line of the document the claim starts on, counted from 1. */
  line: number;
  /** The claim: the quoted words, or a JSON entry's `claim`, white space collapsed. */
  claim: string;
  /** The address it cites, as written; null when it cites none. */
  url: string | null;
  /** Whether the claim gives itself as the page's own words: true for a quotation, a JSON entry's `exact` otherwise. */
  exact: boolean;
}

/**
 * The verdict on one claim:
 * - `exact`: its words stand on the page, read with typographic quotes, dashes, case and white space set aside;
 * - `supported`, `weak`, `unverifiable`, `contradicted`: AgentOS's `CitationVerifier` graded a claim whose words do not
 *   stand on the page against the page's sentences, through the embedding function given;
 * - `not_found`: its words do not stand on the page and no embedding function graded it;
 * - `unreachable`: the page could not be fetched;
 * - `unreadable`: the page came but holds no text this check reads (a PDF, another binary, a page past the size cap, a
 *   page with no text);
 * - `uncited`: the claim cites no address.
 */
export type CitationVerdict = 'exact' | ClaimVerdictKind | 'not_found' | 'unreachable' | 'unreadable' | 'uncited';

/** Every verdict, in the order a summary lists them. */
export const CITATION_VERDICTS: readonly CitationVerdict[] = [
  'exact',
  'supported',
  'weak',
  'unverifiable',
  'contradicted',
  'not_found',
  'unreachable',
  'unreadable',
  'uncited',
];

/** How a verdict was reached: the words on the page, AgentOS's `CitationVerifier`, or shared words alone. */
export type CitationGrader = 'exact' | 'embedding' | 'lexical';

/** A sentence of a page and how near it is to a claim. */
export interface CitationPassage {
  /** The sentence as the page shows it, white space collapsed. */
  text: string;
  /** The share of content words and numbers the sentence and the claim have in common (Jaccard), from 0 to 1. */
  score: number;
}

/** The verdict on one claim, with the passage it rests on. */
export interface CitationCheck {
  /** The claim's line in the document. */
  line: number;
  /** The claim, as parsed. */
  claim: string;
  /** The address it cites, as written; null for an uncited claim. */
  url: string | null;
  /** Whether the claim gives itself as the page's own words (see {@link CitedClaim.exact}). */
  exact: boolean;
  /** The verdict on the claim; see {@link CitationVerdict}. */
  verdict: CitationVerdict;
  /** How the verdict was reached; null for an unreachable, unreadable or uncited claim. */
  grader: CitationGrader | null;
  /**
   * 1 for `exact`; the cosine similarity of the best passage for an embedding verdict; the {@link CitationPassage.score}
   * of the nearest passage for `not_found`, 0 when no passage shares a word; null otherwise.
   */
  score: number | null;
  /** The sentence the verdict rests on: where the words stand, the passage graded best, or the nearest one; null when none. */
  passage: string | null;
  /** For `not_found`, the passages nearest the claim by shared words, nearest first; empty otherwise. */
  nearest: CitationPassage[];
  /** Why an embedding function that was given did not grade the claim, when it failed; null otherwise. */
  note: string | null;
  /**
   * The status of the page the claim cites (whether its text was read, its HTTP status, why it was not read), the
   * same as its entry in {@link CitationReport.pages}; null for an uncited claim.
   */
  page: PageStatus | null;
}

/**
 * Why a page was not read. A page is unreachable for `timeout` (no answer by the deadline), `network` (no connection,
 * or a name that does not resolve), `status` (an answer that is not 2xx), `refused` (the egress policy refused the
 * address) or `redirects` (too many redirects); it is unreadable for `too_large` (past the size cap), `pdf`, `binary`
 * (another type that is not text) or `no_text` (no text a reader sees).
 */
export type PageFailure = 'timeout' | 'network' | 'status' | 'refused' | 'redirects' | 'too_large' | 'pdf' | 'binary' | 'no_text';

/** How one page fared. */
export interface PageStatus {
  /** The address fetched: a claim's address without its fragment. */
  url: string;
  /** Whether its text was read, or why not. */
  outcome: 'read' | 'unreachable' | 'unreadable';
  /** The address the answer came from, after redirects; null when no answer came. */
  finalUrl: string | null;
  /** The answer's HTTP status; null when none came. */
  status: number | null;
  /** Why it was not read; null when it was. */
  failure: PageFailure | null;
  /** More about the failure: the content type of a binary answer, the egress policy's reason; null otherwise. */
  detail: string | null;
  /** How its text was read: the plain request, or the web scraper's fallback; null when it was not read. */
  via: 'fetch' | 'fallback' | null;
  /** How many sentences it gave. */
  passages: number;
}

/** The counts and the lists a reader needs first. */
export interface CitationSummary {
  /** How many claims were checked. */
  claims: number;
  /** How many distinct pages were fetched. */
  pages: number;
  /** How many claims have each verdict; every verdict is present. */
  counts: Record<CitationVerdict, number>;
  /** The claims that cite no address. */
  uncited: Array<{ line: number; claim: string }>;
  /** The pages that were not read: unreachable or unreadable. */
  unreachable: PageStatus[];
}

/** What a check found. */
export interface CitationReport {
  /** When the check started, as an ISO 8601 time. */
  checkedAt: string;
  /** `embedding` when an embedding function was given, `lexical` otherwise. */
  grading: 'lexical' | 'embedding';
  /** One verdict for each claim, in the document's order. */
  checks: CitationCheck[];
  /** One status for each distinct page, in the order the claims first cite them. */
  pages: PageStatus[];
  /** The count of each verdict, the uncited claims and the pages that were not read. */
  summary: CitationSummary;
}

/**
 * The structured logger the check writes its events to: AgentOS's `ILogger`, such as its `PinoLogger`, or any logger
 * with the same methods. Each event is a name and its fields; a page appears by its origin alone, a claim never.
 */
export interface CitationLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}

/** A batch embedding function: texts in, one vector each, in order (`CitationVerifierConfig.embedFn`). */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** A natural language inference function, premise first (`CitationVerifierConfig.nliFn`). */
export type NliFn = (premise: string, hypothesis: string) => Promise<{ label: 'entailment' | 'contradiction' | 'neutral'; score: number }>;
