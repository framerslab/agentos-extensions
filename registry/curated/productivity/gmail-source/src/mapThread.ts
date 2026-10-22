/**
 * @fileoverview Thread document mapping: one Gmail thread becomes one account-source document whose text holds each
 * retained message's sanitized header prefix and trimmed body, with message ids, body spans, labels, attachment
 * listings, omission counts and the earliest permitted cache expiry. The transient MIME objects are never returned or
 * persisted, and the account-source store's fences still decide what is committed.
 * @module agentos-ext-gmail-source/mapThread
 */
import { createHash } from 'node:crypto';
import {
  decideSourceCache, SourceSyncFault,
  type SourceCachePermission, type SourceCacheHeaders, type SourceCacheDecision, type SourceSyncJson,
  type SourceSyncMessageSpan, type SourceSyncReadResult,
} from '@framers/agentos-ext-account-sources';
import {
  GmailMappingFault, mappingBounds, mappingActive, gmailId, parseMimeThread,
  decodedHeaders, decodeMimeWords, redactMimeWords, mimeBody,
  type GmailMappingBounds, type GmailSkipReason, type MimeBudget, type MimeThread, type MimeMessage,
} from './mime.js';
import {
  GmailTextFault, sanitizeMailText, sanitizeMailHeaders, sanitizeMailMetadata,
  type GmailTextPolicy, type GmailSanitizedHeaders,
} from './mailSanitize.js';
import { messageText } from './messageText.js';

/** A Gmail inbox tab beside Primary, by its `category:` search name. */
export type GmailCategory = 'forums' | 'promotions' | 'social' | 'updates';
/** Every category a client or a mapper can leave out, in the order the scan query names them. */
export const GMAIL_CATEGORIES: readonly GmailCategory[] = Object.freeze(['forums', 'promotions', 'social', 'updates'] as const);
// The system label Gmail gives a message of each category.
const CATEGORY_LABELS: Readonly<Record<GmailCategory, string>> = Object.freeze({
  forums: 'CATEGORY_FORUMS', promotions: 'CATEGORY_PROMOTIONS', social: 'CATEGORY_SOCIAL', updates: 'CATEGORY_UPDATES',
});
/**
 * The categories an `excludedCategories` option names, deduplicated and in `GMAIL_CATEGORIES` order: none for an
 * undefined option, null when the value is not an array of category names.
 */
export function gmailCategories(value: unknown): readonly GmailCategory[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const entries: readonly unknown[] = value;
  if (entries.some((entry) => !(GMAIL_CATEGORIES as readonly unknown[]).includes(entry))) return null;
  return GMAIL_CATEGORIES.filter((category) => entries.includes(category));
}
/** The system labels of the given categories. */
export const categoryLabels = (categories: readonly GmailCategory[]): ReadonlySet<string> =>
  new Set(categories.map((category) => CATEGORY_LABELS[category]));
/** The per-read values of one `map` call. The host supplies every value; none comes from a browser request. */
export interface GmailMapThreadOptions {
  /** The requested thread id; the response must carry the same id. */
  readonly sourceId: string;
  /**
   * The host's authenticated source-detail path, used as `SourceRef.url`: a relative path of segments made of letters,
   * digits, `_` and `-`, with no query, fragment or origin, at most 512 characters. Never a Gmail link.
   */
  readonly sourceDetailUrl: string;
  /** The selection cutoff, epoch milliseconds, no later than `receivedAt`: a message received after it is left out. */
  readonly cutoff: number;
  /**
   * The message window in milliseconds, 1 to 90 days. A message received at or before `cutoff - windowMs`, or whose
   * window has ended by `receivedAt`, is left out.
   */
  readonly windowMs: number;
  /** When the thread request started, epoch milliseconds. */
  readonly readStartedAt: number;
  /** When the thread response was complete, epoch milliseconds; it becomes `SourceRef.readAt`. */
  readonly receivedAt: number;
  /** The host's evidenced cache permission; null refuses durable content. */
  readonly permission: SourceCachePermission | null;
  /** The thread response's own cache headers. */
  readonly cacheHeaders: SourceCacheHeaders;
  /**
   * Label names from the cycle's labels response, by label id. They are text from a JSON body, not MIME header values:
   * each is sanitized again and never decoded as RFC 2047 words, so a literal `=?` in a name stays as written. A run of
   * encoded words in a name is decoded only to look inside, and one whose text holds an address or a credential is
   * replaced by what the sanitizer leaves of it.
   */
  readonly labelNames: Readonly<Record<string, string>>;
  /** The labels response's own cache decision. Null, a refusal or an expired decision keeps ids without names. */
  readonly labelCache: SourceCacheDecision | null;
  /** Cancels the call between steps. */
  readonly signal?: AbortSignal;
  /**
   * The inbox tabs whose messages are left out of the copy, by their `category:` names; none by default. A message
   * carrying such a category's label (`CATEGORY_PROMOTIONS` for `promotions`, and so on) is omitted and counted under
   * `excluded_category`.
   */
  readonly excludedCategories?: readonly GmailCategory[];
}
interface NormalizedMessage {
  readonly message: MimeMessage;
  readonly headers: GmailSanitizedHeaders;
  readonly prefix: string;
  readonly body: string;
  readonly trimmedQuote: boolean;
  readonly trimmedSignature: boolean;
  readonly truncated: boolean;
  readonly attachments: readonly SourceSyncJson[];
  readonly labels: readonly SourceSyncJson[];
  readonly unsupportedParts: number;
}
interface RetainedMessage { readonly normalized: NormalizedMessage; readonly text: string; readonly bodyStart: number; readonly truncated: boolean }
// An epoch-millisecond value a Date can hold.
const validTime = (n: number) => Number.isSafeInteger(n) && n >= 0 && n <= 8_640_000_000_000_000;
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
// Newest first, ties broken by id, so the selection is stable.
const newest = (a: MimeMessage, b: MimeMessage) => b.receivedAt - a.receivedAt || compareId(a.id, b.id);
// Clips without leaving the high half of a surrogate pair at the end.
function clip(text: string, maximum: number): string {
  let end = Math.min(text.length, maximum);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return text.slice(0, end);
}
// Refuses options that would point attribution outside the host or leave the window or the clock unbounded.
function configuration(options: GmailMapThreadOptions): void {
  const url = options.sourceDetailUrl;
  if (!gmailId(options.sourceId) || typeof url !== 'string' || !/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url)
    || url.length > 512 || !validTime(options.cutoff) || !validTime(options.readStartedAt)
    || !validTime(options.receivedAt) || options.receivedAt < options.readStartedAt || options.cutoff > options.receivedAt
    || !Number.isSafeInteger(options.windowMs) || options.windowMs < 1 || options.windowMs > 90 * 86_400_000
    || gmailCategories(options.excludedCategories) === null) {
    throw new GmailMappingFault('configuration');
  }
}
// The skip reason a refusal stands for; every other error propagates.
function mappingReason(error: unknown): GmailSkipReason | null {
  if (error instanceof GmailMappingFault && error.reason !== 'configuration') return error.reason;
  if (error instanceof GmailTextFault && error.reason === 'input_too_large') return 'response_too_large';
  return null;
}
/**
 * Maps one parsed Gmail thread into a sanitized account-source document: one thread, one document, with each retained
 * message's id, dates, sanitized headers, labels, attachment listing and body span. It calls no endpoint, writes no log
 * and keeps no state between calls.
 */
export class GmailThreadMapper {
  private readonly bounds: GmailMappingBounds;
  /**
   * @param bounds Every operational ceiling; see `GmailMappingBounds`.
   * @throws {GmailMappingFault} `configuration` for an invalid bound.
   */
  constructor(bounds: GmailMappingBounds) { this.bounds = mappingBounds(bounds); }
  // The sanitizer policy for one output cap.
  private policy(maximum: number): GmailTextPolicy {
    return { maxInputCharacters: this.bounds.maxInputCharacters,
      maxLineCharacters: this.bounds.maxLineCharacters, maxOutputCharacters: Math.min(maximum, this.bounds.maxInputCharacters) };
  }
  // Decodes, sanitizes and trims one message; `map` counts its refusals against this message alone.
  private async normalize(message: MimeMessage, budget: MimeBudget, options: GmailMapThreadOptions): Promise<NormalizedMessage> {
    mappingActive(options.signal);
    const metadataPolicy = this.policy(1000);
    const headers = sanitizeMailHeaders(decodedHeaders(message.payload, budget), metadataPolicy);
    const body = await mimeBody(message.payload, budget, options.signal);
    mappingActive(options.signal);
    const clean = messageText(body.text, this.policy(this.bounds.maxMessageCharacters));
    const metadata = (input: string, maximum = 200): string =>
      sanitizeMailMetadata(decodeMimeWords(input, budget), this.policy(maximum)).text;
    const attachments: SourceSyncJson[] = body.attachments.map((attachment) => ({
      filename: metadata(attachment.filename), mediaType: metadata(attachment.mediaType, 128), size: attachment.size,
    }));
    // A label name is JSON text, never MIME encoded: decoding it as RFC 2047 words refused a literal `=?` and lost every
    // message carrying the label. It is sanitized as written, and a run of encoded words in it is decoded only to look
    // inside: one whose text holds an address or a credential gives way to what the sanitizer leaves of it, so nothing
    // a reader could decode back is stored.
    const labelText = (raw: string): string => redactMimeWords(raw, budget, (decoded) => {
      const inspected = sanitizeMailText(decoded, this.policy(this.bounds.maxInputCharacters));
      return inspected.addressRedactions + inspected.secretRedactions + inspected.suppressedLines > 0 ? inspected.text : null;
    });
    const labels: SourceSyncJson[] = message.labels.map((id) => {
      const permitted = options.labelCache?.kind === 'cache' && validTime(options.labelCache.expiresAt) && options.labelCache.expiresAt > options.receivedAt && options.labelCache.evidenceId.length > 0; const raw = permitted && Object.hasOwn(options.labelNames, id) ? options.labelNames[id] : id;
      if (typeof raw !== 'string') throw new SourceSyncFault('invalid_response');
      return { id, name: sanitizeMailMetadata(labelText(raw), this.policy(200)).text };
    });
    const lines = (['subject', 'date', 'from', 'to', 'cc'] as const)
      .filter((key) => headers[key] !== '').map((key) => key[0]!.toUpperCase() + key.slice(1) + ': ' + headers[key]);
    const prefix = lines.length > 0 ? lines.join('\n') + '\n\n' : '';
    if (!prefix && !clean.text) throw new GmailMappingFault('no_eligible_content');
    return { message, headers, prefix, body: clean.text,
      trimmedQuote: clean.trimmedQuote, trimmedSignature: clean.trimmedSignature, truncated: clean.truncated,
      attachments, labels, unsupportedParts: body.unsupportedParts };
  }
  /**
   * Validates the whole response, filters each message by its internal date and by the spam, trash and draft labels,
   * keeps the newest eligible messages up to the cap with ties broken by id, spends the thread's character budget
   * newest first and renders the kept messages oldest first. A message's text is its sanitized header prefix followed
   * by its sanitized, trimmed body, cut to the message cap (or the thread cap when that is smaller) and never shorter:
   * the first message whose text does not fit in what the thread budget has left, and every older one, is counted
   * under `thread_limit` instead, so the text of a retained message never depends on the rest of its thread. Its span
   * covers the body alone. A message that cannot be read is counted under `metadata.omitted` by a fixed reason. The
   * cache expiry is the earliest of the permission's retention, the read start plus `maximumCacheMs`, the response's
   * cache headers, every kept message's window end and the label names' expiry. The version is the history id and
   * `contentHash`, the SHA-256 of the normalized text, metadata and spans: a release that normalizes text differently
   * changes it for exactly the threads whose normalized text, metadata or spans change, so the store writes those
   * copies again at their next read and keeps the rest.
   *
   * @param input The parsed `threads.get` response in the `full` format, from a transport that capped its bytes.
   * @param options The per-read values.
   * @returns A document, or a skip with a fixed reason: a thread-wide bound was exceeded, no message survived, or the
   * cache policy refused durable content.
   * @throws {GmailMappingFault} `configuration` for invalid options.
   * @throws {SourceSyncFault} `invalid_response` for an invalid response, never an empty success; `cancelled` once the
   * signal is aborted.
   */
  async map(input: unknown, options: GmailMapThreadOptions): Promise<SourceSyncReadResult> {
    configuration(options); mappingActive(options.signal);
    const skipped = (reason: GmailSkipReason): SourceSyncReadResult => ({ kind: 'skipped', id: options.sourceId, reason });
    const budget: MimeBudget = { bounds: this.bounds, rawBytes: 0, decodedBytes: 0, parts: 0 };
    const excludedLabels = categoryLabels(gmailCategories(options.excludedCategories) ?? []);
    let thread: MimeThread;
    try { thread = parseMimeThread(input, options.sourceId, budget, options.signal); }
    catch (error) { const reason = mappingReason(error); if (reason) return skipped(reason); throw error; }
    const omitted: Record<string, number> = {};
    const omit = (reason: string, count = 1) => { if (count > 0) omitted[reason] = (omitted[reason] ?? 0) + count; };
    const eligible: MimeMessage[] = [];
    for (const message of thread.messages) {
      if (message.receivedAt > options.cutoff || message.receivedAt <= options.cutoff - options.windowMs
        || !validTime(message.receivedAt + options.windowMs) || message.receivedAt + options.windowMs <= options.receivedAt) {
        omit('out_of_window'); continue;
      }
      if (message.labels.some((label) => ['SPAM', 'TRASH', 'DRAFT'].includes(label))) { omit('excluded_label'); continue; }
      if (message.labels.some((label) => excludedLabels.has(label))) { omit('excluded_category'); continue; }
      eligible.push(message);
    }
    eligible.sort(newest);
    const selected = eligible.slice(0, this.bounds.maxMessages);
    omit('message_limit', eligible.length - selected.length);
    // Each message keeps its own cut, whatever else the thread holds: cutting the oldest kept message to what the newer
    // ones left would change its text at every reply near the cap, and the account-source store charges a message its
    // copy holds nothing only when its text hash, cut and length are unchanged. The first message that does not fit
    // whole in what is left reaches the cap: it and every older message are omitted under `thread_limit`, unread, as
    // they were once a cut message had filled the budget.
    const cut = Math.min(this.bounds.maxMessageCharacters, this.bounds.maxThreadCharacters);
    const retained: RetainedMessage[] = []; let used = 0; let full = false;
    let lastReason: GmailSkipReason = 'no_eligible_content';
    for (const message of selected) {
      mappingActive(options.signal);
      const remaining = this.bounds.maxThreadCharacters - used - (retained.length ? 2 : 0);
      if (full || remaining <= 0) { omit('thread_limit'); continue; }
      let normalized: NormalizedMessage;
      try { normalized = await this.normalize(message, budget, options); }
      catch (error) {
        const reason = mappingReason(error);
        if (!reason) throw error;
        lastReason = reason; omit(reason); continue;
      }
      mappingActive(options.signal);
      if (normalized.prefix.length > cut) { lastReason = 'structure_limit'; omit('thread_limit'); continue; }
      const body = clip(normalized.body, cut - normalized.prefix.length);
      const text = normalized.prefix + body;
      if (!text) { lastReason = 'no_eligible_content'; omit(lastReason); continue; }
      if (text.length > remaining) { full = true; omit('thread_limit'); continue; }
      retained.push({ normalized, text, bodyStart: normalized.prefix.length,
        truncated: normalized.truncated || body.length < normalized.body.length });
      used += text.length + (retained.length > 1 ? 2 : 0);
    }
    if (retained.length === 0) {
      if (eligible.length === 0) {
        lastReason = omitted.excluded_label || omitted.excluded_category ? 'excluded_label'
          : omitted.out_of_window ? 'out_of_window' : lastReason;
      }
      return skipped(lastReason);
    }
    retained.sort((a, b) => a.normalized.message.receivedAt - b.normalized.message.receivedAt
      || compareId(a.normalized.message.id, b.normalized.message.id));
    const messages: SourceSyncMessageSpan[] = []; const metadataMessages: SourceSyncJson[] = [];
    const texts: string[] = []; let offset = 0;
    for (const kept of retained) {
      const { normalized } = kept; const { message, headers } = normalized;
      if (texts.length) offset += 2;
      messages.push({ messageId: message.id, start: offset + kept.bodyStart, end: offset + kept.text.length,
        receivedAt: message.receivedAt, windowExpiresAt: message.receivedAt + options.windowMs, truncated: kept.truncated });
      metadataMessages.push({ messageId: message.id, headers: { ...headers }, labels: normalized.labels,
        attachments: normalized.attachments, trimmedQuote: normalized.trimmedQuote,
        trimmedSignature: normalized.trimmedSignature, unsupportedParts: normalized.unsupportedParts });
      texts.push(kept.text); offset += kept.text.length;
    }
    const metadata: Record<string, SourceSyncJson> = { messages: metadataMessages,
      omitted: Object.fromEntries(Object.entries(omitted).sort(([a], [b]) => compareId(a, b))),
      attachmentsRead: false };
    const metadataJson = JSON.stringify(metadata);
    if (metadataJson.length > this.bounds.maxMetadataCharacters) return skipped('structure_limit');
    const cache = decideSourceCache({ permission: options.permission, maximumCacheMs: this.bounds.maximumCacheMs,
      readStartedAt: options.readStartedAt, receivedAt: options.receivedAt,
      windowExpiresAt: Math.min(...messages.map((m) => m.windowExpiresAt)), headers: options.cacheHeaders });
    if (cache.kind === 'skip') return skipped(cache.reason);
    const labelExpiry = options.labelCache?.kind === 'cache' && options.labelCache.expiresAt > options.receivedAt ? options.labelCache.expiresAt : cache.expiresAt; const allowedCache = { ...cache, expiresAt: Math.min(cache.expiresAt, labelExpiry) }; const text = texts.join('\n\n');
    const contentHash = createHash('sha256').update(JSON.stringify({ text, metadata, messages })).digest('hex');
    const version = thread.historyId + ':' + contentHash;
    const mostRecent = [...retained].sort((a, b) => newest(a.normalized.message, b.normalized.message));
    const title = mostRecent.find((m) => m.normalized.headers.subject)?.normalized.headers.subject || 'Mail thread';
    mappingActive(options.signal);
    return { kind: 'document', document: {
      read: { item: { id: thread.id, title, size: text.length, version }, content: { text },
        ref: { kind: 'gmail', title, url: options.sourceDetailUrl, version, readAt: new Date(options.receivedAt).toISOString() } },
      messages, metadata, activityAt: Math.max(...messages.map((m) => m.receivedAt)), contentHash, cache: allowedCache,
    } };
  }
}
