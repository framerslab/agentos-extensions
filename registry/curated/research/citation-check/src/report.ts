/**
 * @file report.ts
 * @description What a reader does with a report: whether it fails, and the markdown a document's "Citation check log"
 * section holds: a line on how the claims were checked, the counts and the result, a table of the claims with what
 * each page says, and the nearest sentences for each claim not found.
 *
 * @module agentos/extensions/research/citation-check/report
 */

import { CITATION_VERDICTS, type CitationCheck, type CitationReport, type CitationVerdict, type PageStatus } from './types.js';

/** The verdicts that fail a check: a claim the page contradicts, does not hold, or does not come near, and a page not read. */
export const FAILING_VERDICTS: readonly CitationVerdict[] = ['contradicted', 'not_found', 'unverifiable', 'unreachable', 'unreadable'];

/** The verdicts of a page that was not read, which `allowUnreachable` does not count. */
const PAGE_VERDICTS: ReadonlySet<CitationVerdict> = new Set(['unreachable', 'unreadable']);

/** What a reader asks of a report. */
export interface CitationReportOptions {
  /** Count a claim whose page could not be fetched or read as no failure. */
  allowUnreachable?: boolean;
}

/**
 * Whether a report fails: a claim is `contradicted`, `not_found` or `unverifiable`, or, unless `allowUnreachable`, its
 * page was `unreachable` or `unreadable`. `exact`, `supported`, `weak` and `uncited` claims never fail it.
 */
export function citationReportFails(report: CitationReport, options: CitationReportOptions = {}): boolean {
  return report.checks.some((check) => FAILING_VERDICTS.includes(check.verdict) && !(options.allowUnreachable === true && PAGE_VERDICTS.has(check.verdict)));
}

/** The longest a cell of the table runs, in characters. */
const CELL_MAX = 240;

/** Text for a table cell: one line, its pipes escaped, held to {@link CELL_MAX} characters. */
function cell(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  const held = line.length <= CELL_MAX ? line : `${line.slice(0, CELL_MAX - 1).trimEnd()}…`;
  return held.replace(/\|/gu, '\\|');
}

/** An address as a markdown autolink, with the characters that would end it encoded. */
function link(url: string): string {
  return `<${url.replace(/\|/gu, '%7C').replace(/>/gu, '%3E').replace(/\s/gu, '%20')}>`;
}

/** A verdict as the log writes it. */
function label(verdict: CitationVerdict): string {
  return verdict === 'not_found' ? 'not found' : verdict;
}

/** A score with two decimals. */
function score(value: number): string {
  return value.toFixed(2);
}

/** Why a page was not read, in words. */
function problem(page: PageStatus | null): string {
  if (!page) return '';
  switch (page.failure) {
    case 'status':
      return `HTTP ${page.status ?? ''}`.trim();
    case 'timeout':
      return 'no answer by the deadline';
    case 'network':
      return page.detail === null ? 'no connection' : `no connection (${page.detail})`;
    case 'refused':
      return `refused by the egress policy (${page.detail ?? 'refused'})`;
    case 'redirects':
      return 'too many redirects';
    case 'too_large':
      return 'larger than the size cap';
    case 'pdf':
      return 'a PDF, which this check does not read';
    case 'binary':
      return page.detail === null ? 'not text' : `not text (${page.detail})`;
    case 'no_text':
      return 'no text on the page';
    default:
      return '';
  }
}

/** What the page says for a check: the passage, its score, or why the page was not read. */
function evidence(check: CitationCheck): string {
  switch (check.verdict) {
    case 'exact':
      return check.passage ?? '';
    case 'supported':
    case 'weak':
    case 'unverifiable':
    case 'contradicted':
      return check.passage === null ? `(${score(check.score ?? 0)}) no sentence near it` : `(${score(check.score ?? 0)}) ${check.passage}`;
    case 'not_found':
      return check.passage === null ? 'no sentence shares a word with it' : `nearest (${score(check.score ?? 0)}): ${check.passage}`;
    case 'unreachable':
    case 'unreadable':
      return problem(check.page);
    default:
      return '';
  }
}

/** A count with its noun, singular or plural. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The markdown for a document's "Citation check log" section: the date and how the claims were checked, the counts and
 * whether the check passes, a table with each claim's line, verdict, address and what its page says, and the nearest
 * sentences for each claim not found. It carries no heading, so it goes under the section's own.
 */
export function renderCitationLog(report: CitationReport, options: CitationReportOptions = {}): string {
  const { summary } = report;
  const how =
    report.grading === 'embedding'
      ? "each claim's words were looked for on its page, and AgentOS's CitationVerifier graded the claims not found there against the page's sentences by embedding similarity"
      : "each claim's words were looked for on its page, and each claim not found there is shown with the page's sentences nearest it by shared words";
  const verdicts = CITATION_VERDICTS.filter((verdict) => summary.counts[verdict] > 0).map((verdict) => `${summary.counts[verdict]} ${label(verdict)}`);
  const lines = [
    `Checked ${counted(summary.claims, 'claim')} against ${counted(summary.pages, 'page')} on ${report.checkedAt}: ${how}.`,
    `Verdicts: ${verdicts.length === 0 ? 'none' : verdicts.join(', ')}. Result: ${citationReportFails(report, options) ? 'fails' : 'passes'}.`,
  ];
  if (report.checks.length > 0) {
    lines.push('', '| Line | Verdict | Claim | Source | What the page says |', '| --- | --- | --- | --- | --- |');
    for (const check of report.checks) {
      lines.push(`| ${check.line} | ${label(check.verdict)} | ${cell(check.claim)} | ${check.url === null ? 'none' : link(check.url)} | ${cell(evidence(check))} |`);
    }
  }
  const notFound = report.checks.filter((check) => check.verdict === 'not_found' && check.nearest.length > 0);
  if (notFound.length > 0) {
    lines.push('', 'Nearest passages for the claims not found:', '');
    for (const check of notFound) {
      lines.push(`- Line ${check.line}, "${cell(check.claim)}":`);
      check.nearest.forEach((passage, index) => lines.push(`  ${index + 1}. (${score(passage.score)}) ${cell(passage.text)}`));
    }
  }
  const notes = report.checks.filter((check) => check.note !== null);
  if (notes.length > 0) {
    lines.push('', 'Notes:', '');
    for (const check of notes) lines.push(`- Line ${check.line}: ${cell(check.note ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}
