/**
 * @fileoverview Conservative trimming of a sanitized mail body: recognized reply history, a trailing quote block after
 * a blank line and a short signature after its exact separator are removed; explicit forwards, inline answers and
 * ambiguous prose stay. Nothing is summarized or rewritten, so a quote span refers to the returned text.
 * @module agentos-ext-gmail-source/messageText
 */
import { sanitizeMailText, type GmailSanitizedText, type GmailTextPolicy } from './mailSanitize.js';

/** A sanitized, trimmed message body, its content-free counts and what trimming removed. */
export interface GmailMessageText extends GmailSanitizedText {
  /** Whether recognized reply history or a trailing quote block was removed. */
  readonly trimmedQuote: boolean;
  /** Whether a short signature after its exact separator, or a final known mobile signature line, was removed. */
  readonly trimmedSignature: boolean;
}
// Explicit forward markers, after any quote prefix: they protect the whole body from trimming.
const forward = /^(?:-{2,}[ \t]*)?(?:forwarded message|begin forwarded message:|转发邮件|转寄邮件)(?:[ \t:-]|$)/i;
// An original-message separator; it counts only when structured headers follow it.
const original = /^[ \t]*-{2,}[ \t]*(?:Original Message|Replied Message)[ \t]*-{2,}[ \t]*$/i;
// A known mobile signature, recognized only as the final line after a blank line.
const mobile = /^(?:Sent from my iPhone|Sent from my iPad|Sent from my Android)$/i;
const blank = (line: string) => line.trim().length === 0;
const quoted = (line: string) => /^[ \t]*>/.test(line);
function trimBlank(lines: readonly string[]): string[] {
  let start = 0; let end = lines.length;
  while (start < end && blank(lines[start]!)) start++;
  while (end > start && blank(lines[end - 1]!)) end--;
  return lines.slice(start, end);
}
// Whether From, Sent or Date, and To or Subject header lines follow the separator before the first blank line.
function structuredHeaders(lines: readonly string[], start: number): boolean {
  const found = new Set<string>();
  for (let i = start; i < Math.min(start + 8, lines.length); i++) {
    const line = lines[i]!;
    if (blank(line)) { if (found.size > 0) break; else continue; }
    const header = line.match(/^[ \t]*(From|Sent|Date|To|Subject):[ \t]*\S/i);
    if (!header) return false;
    found.add(header[1]!.toLowerCase());
  }
  return found.has('from') && (found.has('sent') || found.has('date'))
    && (found.has('to') || found.has('subject'));
}
// The index after a reply introducer at `index`: "On ... wrote:" on one line or wrapped over two short lines.
function replyEnd(lines: readonly string[], index: number): number | null {
  const first = lines[index]!;
  if (first.length <= 300 && /^[ \t]*On .+ wrote:[ \t]*$/i.test(first)) return index + 1;
  const second = lines[index + 1];
  if (second !== undefined && first.length <= 220 && second.length <= 220
    && /^[ \t]*On .+/i.test(first) && /.+ wrote:[ \t]*$/i.test(second)) return index + 2;
  return null;
}
// Removes reply history only when every nonblank line after its introducer is quoted, or a structured original
// message, then a trailing quote block that follows a blank line; a body that is only quotes stays.
function cutQuotes(input: readonly string[]): { lines: string[]; changed: boolean } {
  let lines = [...input]; let changed = false; let lastUnquoted = -1; let lastNonblank = -1;
  for (let j = 0; j < lines.length; j++) { if (!blank(lines[j]!)) { lastNonblank = j; if (!quoted(lines[j]!)) lastUnquoted = j; } } for (let i = 1; i < lines.length; i++) {
    if (!blank(lines[i - 1]!)) continue;
    const end = replyEnd(lines, i);
    if (end !== null) {
      const tailIsQuoted = end > lastUnquoted && end <= lastNonblank;
      if (tailIsQuoted) {
        lines = trimBlank(lines.slice(0, i)); changed = true; break;
      }
    }
    if (original.test(lines[i]!) && structuredHeaders(lines, i + 1)) {
      lines = trimBlank(lines.slice(0, i)); changed = true; break;
    }
  }
  let cursor = lines.length; let count = 0;
  while (cursor > 0 && (blank(lines[cursor - 1]!) || quoted(lines[cursor - 1]!))) {
    if (quoted(lines[cursor - 1]!)) count++;
    cursor--;
  }
  if (count > 0 && cursor > 0 && cursor < lines.length && blank(lines[cursor]!)) {
    lines = trimBlank(lines.slice(0, cursor)); changed = true;
  }
  return { lines, changed };
}
// Removes at most 12 short unquoted lines after an exact "-- " line that follows a blank line, or a final known
// mobile signature line.
function cutSignature(input: readonly string[]): { lines: string[]; changed: boolean } {
  const lines = [...input];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] !== '-- ' || !blank(lines[i - 1]!) || lines.length - i - 1 > 12) continue;
    const suffix = lines.slice(i + 1);
    if (suffix.length <= 12 && suffix.join('\n').length <= 1000 && !suffix.some(quoted)) {
      return { lines: trimBlank(lines.slice(0, i)), changed: true };
    }
  }
  const last = lines.length - 1;
  if (last >= 2 && mobile.test(lines[last]!.trim()) && blank(lines[last - 1]!)
    && lines.slice(0, last - 1).some((line) => !blank(line))) {
    return { lines: trimBlank(lines.slice(0, last - 1)), changed: true };
  }
  return { lines, changed: false };
}
/**
 * Sanitizes a decoded body with `sanitizeMailText`, then trims recognized reply history and short signatures, then
 * applies the output cap without splitting a surrogate pair. A body with an explicit forward marker is not trimmed.
 * Ambiguous prose, sign-offs, unmarked header-looking paragraphs and inline answers stay; nothing is summarized or
 * rewritten, so quote offsets refer to the returned text.
 *
 * @param input A decoded plain-text body, or the inert text of an HTML body.
 * @param policy The input, line and output bounds.
 * @returns The retained text, the sanitizer counts and what trimming and the cap removed.
 * @throws {GmailTextFault} `configuration` for an invalid policy, `input_too_large` above the input cap.
 */
export function messageText(input: string, policy: GmailTextPolicy): GmailMessageText {
  // Validate the caller's output cap before temporarily widening it for trimming.
  sanitizeMailText('', policy);
  const safe = sanitizeMailText(input, { ...policy, maxOutputCharacters: policy.maxInputCharacters });
  let lines = trimBlank(safe.text.split('\n'));
  let trimmedQuote = false; let trimmedSignature = false;
  if (!lines.some((line) => forward.test(line.replace(/^[ \t>]*/, '')))) {
    const quotes = cutQuotes(lines); lines = quotes.lines; trimmedQuote = quotes.changed;
    const signature = cutSignature(lines); lines = signature.lines; trimmedSignature = signature.changed;
  }
  const complete = lines.join('\n');
  let end = Math.min(complete.length, policy.maxOutputCharacters);
  if (end > 0 && end < complete.length && /[\uD800-\uDBFF]/.test(complete[end - 1]!)
    && /[\uDC00-\uDFFF]/.test(complete[end]!)) end--;
  const text = complete.slice(0, end);
  return { ...safe, text, truncated: safe.truncated || text.length < complete.length, trimmedQuote, trimmedSignature };
}
