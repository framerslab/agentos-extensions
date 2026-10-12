/**
 * @file types.ts
 * @description What a public source gives a citation pipeline: hits for a topic phrase, the article fetched for a hit
 * as blocks of plain text with its attribution, and passages as `VerificationSource`s carrying that attribution.
 *
 * @module agentos/extensions/research/public-sources/types
 */

/** A licence a source's text is reused under. */
export interface SourceLicence {
  /** Its short name, as a notice shows it. */
  name: string;
  /** The licence's text, which a notice links to. */
  url: string;
}

/** One search hit: the key the article is fetched by, and its title. */
export interface SourceHit {
  key: string;
  title: string;
}

/** One article as fetched: its attribution and its text as blocks (paragraphs, list items, headings). */
export interface SourceDocument {
  /** The source's name as a reader sees it, such as `Wikipedia`. */
  site: string;
  key: string;
  title: string;
  /** The article's address, which an attribution links to. */
  url: string;
  /** The revision fetched, when the source names one. */
  revision: string | null;
  /** When it was fetched, in milliseconds since 1970. */
  readAt: number;
  licence: SourceLicence;
  /** The text, block by block: white space collapsed, NFC, the markup and the reference markers gone. */
  blocks: string[];
}

/** One passage: a sentence of an article, shaped as AgentOS's `VerificationSource`, with its attribution and its place. */
export interface CitationSource {
  /** The sentence, its own characters. */
  content: string;
  title: string;
  url: string;
  site: string;
  key: string;
  revision: string | null;
  readAt: number;
  licence: SourceLicence;
  /** The block it stands in, and its offsets there (UTF-16 code units). */
  block: number;
  start: number;
  end: number;
}

/** A search's outcome: hits, the limiter's refusal (nothing was sent), or a failure with the status when one came. */
export type SearchOutcome = { kind: 'hits'; hits: SourceHit[] } | { kind: 'limited' } | { kind: 'failed'; status: number | null };

/** A read's outcome: the document, the limiter's refusal, or a skip with the status when one came. */
export type ReadOutcome = { kind: 'document'; document: SourceDocument } | { kind: 'limited' } | { kind: 'skipped'; status: number | null };

/**
 * What a call may carry: the caller's cancellation, and for a search a callback run once the request is granted and
 * before it is sent; a `LimiterRefused('caller')` it throws ends the search as `limited`, with nothing sent and none of
 * the limiter's starts spent. A search can still end as `limited` after the callback has run, with nothing sent: when a
 * 429 or a 503 blocked the limiter meanwhile, or when the spacing would take its wait past the limiter's `waitMs`.
 */
export interface CallOptions {
  signal?: AbortSignal;
  onSend?: () => void | Promise<void>;
}

/** A public source: a search by topic phrase and a read of one hit. */
export interface PublicSourceProvider {
  /** The source's name as a reader sees it, such as `Wikipedia`. */
  readonly site: string;
  /** Searches the source for a short topic phrase and answers at most `limit` hits. */
  search(phrase: string, options?: CallOptions & { limit?: number }): Promise<SearchOutcome>;
  /** Fetches one hit's article as text blocks with its attribution. */
  read(hit: SourceHit, options?: Omit<CallOptions, 'onSend'>): Promise<ReadOutcome>;
}
