/**
 * @fileoverview Deterministic pre-storage sanitization of mail text: once percent and character references are decoded
 * and padding collapsed, address tokens, credential assignments, known credential shapes, private-key blocks and long
 * mixed tokens are replaced with fixed marks, and a final gate suppresses any line that still carries a credential
 * cue. Every count is a number; no matched value, offset or reverse mapping is kept, nothing is logged and no model or
 * network is called.
 * @module agentos-ext-gmail-source/mailSanitize
 */

import { collapsePadding, decodeCharacterReferences, holdsNamedReference } from './characters.js';

/**
 * The bounds of one sanitization call, as positive safe integer UTF-16 code-unit counts. The input ceiling is
 * 2,097,152, the line ceiling 65,536, and the output cap cannot exceed the input cap.
 */
export interface GmailTextPolicy {
  /** The largest input accepted, before and after decoding; larger input throws `GmailTextFault('input_too_large')`. */
  readonly maxInputCharacters: number;
  /** The longest line inspected; a longer line is suppressed whole before any token matching. */
  readonly maxLineCharacters: number;
  /** The longest text returned; the complete input is checked before this cap clips the result. */
  readonly maxOutputCharacters: number;
}
/** Sanitized text and content-free counts of what was removed. The counts are not permission to log the text. */
export interface GmailSanitizedText {
  /** The sanitized text, clipped to the output cap without splitting a surrogate pair. */
  readonly text: string;
  /** How many address tokens became `[address removed]`. */
  readonly addressRedactions: number;
  /** How many credential lines, shapes, long mixed tokens and private-key blocks became `[secret removed]`. */
  readonly secretRedactions: number;
  /** How many lines became `[line removed by the secret gate]`. */
  readonly suppressedLines: number;
  /** Whether the output cap removed text. */
  readonly truncated: boolean;
}
/** One message header after bounded MIME header decoding: its name and its decoded value. */
export interface GmailHeaderInput { readonly name: string; readonly value: string }
/** The retained headers, each sanitized; Bcc and every other header are never returned. */
export interface GmailSanitizedHeaders {
  /** The first Subject, at most 200 characters. */
  readonly subject: string;
  /** The first Date, at most 1,000 characters. */
  readonly date: string;
  /** Every From value, joined with commas, at most 4,000 characters. */
  readonly from: string;
  /** Every To value, joined with commas, at most 4,000 characters. */
  readonly to: string;
  /** Every Cc value, joined with commas, at most 4,000 characters. */
  readonly cc: string;
}
/** Why a text helper refused its input, as a fixed word: an invalid policy or input above its cap. */
export type GmailTextFailure = 'configuration' | 'input_too_large';
/** A text helper's fixed refusal; its message is `gmail_text_<reason>` and never carries source text. */
export class GmailTextFault extends Error {
  /** @param reason Why the helper refused its input. */
  constructor(readonly reason: GmailTextFailure) {
    super(`gmail_text_${reason}`); this.name = 'GmailTextFault';
  }
}

const addressMark = '[address removed]';
const secretMark = '[secret removed]';
const lineMark = '[line removed by the secret gate]';
// Credential shapes replaced in place. They are a conservative policy, not a claim about every provider's format. A
// prefix right after a letter or digit is part of a word (`risk-adjusted`), not a credential. A JWT is matched only
// from the start of its run of token characters, so a long `-` joined run cannot make the scan quadratic.
const shapeSources: readonly string[] = [
  String.raw`(?<![A-Za-z0-9])(?:GOCSPX-|ya29\.|1//0|ghp_|github_pat_|xox[bpas]-|sk-ant-|sk-proj-|sk-|tvly-|whsec_)[A-Za-z0-9._~+/=-]{6,}`,
  String.raw`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`,
  String.raw`\bfc-[0-9a-f]{32}\b`,
  String.raw`\bAIza[A-Za-z0-9_-]{20,}`,
  String.raw`\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9_]{10,}`,
  String.raw`\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}`,
  String.raw`(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b`,
];
// A credential label followed by `:` or `=`: the whole line is replaced. The password words (also plural), `token`,
// `secret`, `secret key` and the compound labels count at the end of any identifier (`DB_PASSWORD=`, `PGPASSWORD=`,
// `GITHUB_TOKEN=`, `authToken:`, `SECRET_KEY=`, `Passwords:`). The short or common labels count only after a character
// other than a letter or digit, so `Compass:` and `Preauthorization:` stay.
const assignment = /(?:(?<![a-z0-9])(?:pass|pwd|pw|authorization|cookie|set-cookie|database[ _-]?url|signing[ _-]?key|one[ _-]?time[ _-]?code)|pass(?:word|wd|code|phrase)s?|api[ _-]?key|access[ _-]?(?:key|token)|refresh[ _-]?token|client[ _-]?secret|secret(?:[ _-]?key)?|token|auth[ _-]?key|provisioning[ _-]?key|verification[ _-]?code)["']?\s*[:=]\s*/i;
// The final gate's cues: a line still carrying one after replacement is suppressed whole. The password words (also
// plural) and the compound cues count at the end of any identifier (`DB_PASSWORD`, `rsaPrivateKey`); `bearer` and the
// SSH cues need a character other than a letter or digit before them. No cue continues into a letter or digit.
const residual = /(?:(?<![a-z0-9])(?:bearer|ssh-(?:rsa|ed25519)|sshpass)|pass(?:word|wd|phrase)s?|api[ _-]?(?:key|token)|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|private[ _-]?key)(?![a-z0-9])/i;
const beginKey = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const endKey = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
// Encoded bytes still present after the bounded decoding passes. A named reference the decoder knows, still present
// after them, means the text was nested deeper than four levels; `holdsNamedReference` finds it.
const unresolved = /%[0-9a-f]{2}|&#(?:x[0-9a-f]+|[0-9]+);?/i;

function validate(policy: GmailTextPolicy): void {
  for (const value of [policy.maxInputCharacters, policy.maxLineCharacters, policy.maxOutputCharacters]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new GmailTextFault('configuration');
  }
  if (policy.maxInputCharacters > 2_097_152 || policy.maxLineCharacters > 65_536
    || policy.maxOutputCharacters > policy.maxInputCharacters) throw new GmailTextFault('configuration');
}
// At most four passes of percent and character-reference decoding (every named reference of the HTML standard), the
// collapse of padding runs, Unicode compatibility normalization, line-break unification and removal of format and
// control characters and the combining grapheme joiner. Padding collapses before normalization, which would turn a
// no-break space into an ASCII one. The cap is checked before decoding and again after each pass, since normalization
// can lengthen text.
function canonical(input: string, limit: number): string {
  if (input.length > limit) throw new GmailTextFault('input_too_large');
  let text = input;
  for (let pass = 0; pass < 4; pass++) {
    const previous = text;
    text = decodeCharacterReferences(text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try { return decodeURIComponent(run); } catch { return run; }
    }));
    text = collapsePadding(text).normalize('NFKC').replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n')
      .replace(/[\p{Cf}\u034f]/gu, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
    if (text.length > limit) throw new GmailTextFault('input_too_large');
    if (text === previous) break;
  }
  return text;
}
// Clips without leaving the high half of a surrogate pair at the end.
function clipped(text: string, maximum: number): string {
  let end = Math.min(text.length, maximum);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)
    && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return text.slice(0, end);
}
// Whether the line holds a URL with a user name or password, or an unparsable URL with an `@`. The scheme is at most
// 64 characters, so a long run of scheme characters cannot make the scan quadratic; a longer one still leaves the `@`
// for the address rule.
function containsAuthenticatedUrl(line: string): boolean {
  for (const match of line.matchAll(/\b[a-z][a-z0-9+.-]{0,63}:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0]);
      if (url.username || url.password) return true;
    } catch {
      if (match[0].includes('@')) return true;
    }
  }
  return false;
}
/**
 * Pure pre-storage transformation. It never records matched values or invokes a model.
 *
 * Decodes repeated percent and character-reference encoding (at most four passes, every named reference of the HTML
 * standard among them), collapses padding, normalizes Unicode and line breaks, then works line by line: private-key
 * blocks, credential assignments and authenticated URLs are replaced, credential shapes and long mixed tokens become
 * `[secret removed]`, address tokens become `[address removed]`, and a line with unresolved encoded bytes or
 * character references, above the line cap or still carrying a credential cue becomes
 * `[line removed by the secret gate]`. Padding is a run of spaces and invisible characters that holds anything other
 * than ASCII spaces and tabs, such as the no-break spaces and zero-width non-joiners mail templates repeat after a
 * preheader: it becomes one space, or nothing when it holds no space at all, so zero-width characters between letters
 * join them. A run of ASCII spaces and tabs alone stays as written. An assignment with an empty value, a block scalar
 * or an unclosed quote also suppresses the rest of the text. A replaced assignment and a line the final gate
 * suppresses keep their quote markers (`>`). The complete input is checked before the output cap clips the result.
 *
 * @param input Decoded text: a body or one display field.
 * @param policy The input, line and output bounds.
 * @returns The sanitized text and content-free counts.
 * @throws {GmailTextFault} `configuration` for an invalid policy, `input_too_large` above the input cap.
 */
export function sanitizeMailText(input: string, policy: GmailTextPolicy): GmailSanitizedText {
  validate(policy);
  const normalized = canonical(input, policy.maxInputCharacters);
  let addressRedactions = 0; let secretRedactions = 0; let suppressedLines = 0;
  let insideKey = false; let credentialTail = false;
  const lines: string[] = [];
  for (const raw of normalized.split('\n')) { if (credentialTail) { suppressedLines++; lines.push(lineMark); continue; }
    if (insideKey || beginKey.test(raw)) {
      if (!insideKey) secretRedactions++;
      insideKey = !endKey.test(raw);
      lines.push(secretMark); continue;
    }
    if (raw.length > policy.maxLineCharacters || unresolved.test(raw) || holdsNamedReference(raw)) {
      suppressedLines++; lines.push(lineMark); continue;
    }
    // Preserve quote depth so removal cannot turn quoted history into fresh text.
    const quote = raw.match(/^([ \t]*(?:>[ \t]*)+)/)?.[0] ?? '';
    let line = raw.slice(quote.length);
    if (assignment.test(line) || containsAuthenticatedUrl(line) || /\bsshpass\s+-p\b/i.test(line)) {
      const found = assignment.exec(line); const value = found ? line.slice(found.index + found[0].length).trim() : null; credentialTail = value !== null && (value === '' || /^[|>][+-]?$/.test(value) || ((value[0] === '"' || value[0] === "'") && value.lastIndexOf(value[0]) === 0)); secretRedactions++; lines.push(quote + secretMark); continue;
    }
    for (const source of shapeSources) {
      line = line.replace(new RegExp(source, 'g'), () => { secretRedactions++; return secretMark; });
    }
    line = line.replace(/[A-Za-z0-9_+/=-]{32,}/g, (token) => {
      if ((/[a-z]/i.test(token) && /[0-9]/.test(token)) || /^[0-9a-f]{40,}$/i.test(token)) {
        secretRedactions++; return secretMark;
      }
      return token;
    });
    line = line.replace(/"[^"\n]{1,512}"\s*@[^\s<>;,"']+/gu,
      () => { addressRedactions++; return addressMark; });
    line = line.replace(/[^\s<>;,"'()\[\]]+/gu,
      (token) => { if (!token.includes('@')) return token; addressRedactions++; return addressMark; });
    const inspected = line.split(secretMark).join('').split(lineMark).join('');
    if (residual.test(inspected) || endKey.test(inspected)) {
      suppressedLines++; lines.push(quote + lineMark); continue;
    }
    lines.push(quote + line);
  }
  const complete = lines.join('\n');
  const text = clipped(complete, policy.maxOutputCharacters);
  return { text, addressRedactions, secretRedactions, suppressedLines, truncated: text.length < complete.length };
}
/**
 * Use for every filename, label name and display field, after MIME decoding. Applies the same rules as
 * `sanitizeMailText` to the complete value, folds each whitespace run to one space and trims, then applies the
 * output cap.
 *
 * @param input One decoded metadata value.
 * @param policy The input, line and output bounds.
 * @returns The sanitized one-line value and content-free counts.
 * @throws {GmailTextFault} `configuration` for an invalid policy, `input_too_large` above the input cap.
 */
export function sanitizeMailMetadata(input: string, policy: GmailTextPolicy): GmailSanitizedText {
  validate(policy);
  const safe = sanitizeMailText(input, { ...policy, maxOutputCharacters: policy.maxInputCharacters });
  const complete = safe.text.replace(/\s+/gu, ' ').trim();
  const text = clipped(complete, policy.maxOutputCharacters);
  return { ...safe, text, truncated: safe.truncated || text.length < complete.length };
}
/**
 * Input values must already have passed bounded MIME header decoding. Retains only Subject, Date, From, To and Cc,
 * matched without regard to case, and sanitizes each as metadata: the first Subject (at most 200 characters) and Date
 * (at most 1,000), and every From, To and Cc value joined with commas (at most 4,000 each), each also within the
 * policy's output cap.
 *
 * @param headers At most 1,000 decoded headers, whose names and values together fit the input cap.
 * @param policy The input, line and output bounds.
 * @returns The five retained fields; a missing header is an empty string.
 * @throws {GmailTextFault} `configuration` for an invalid policy, `input_too_large` for more than 1,000 headers or
 * text above the input cap.
 */
export function sanitizeMailHeaders(headers: readonly GmailHeaderInput[], policy: GmailTextPolicy): GmailSanitizedHeaders {
  validate(policy);
  if (headers.length > 1000) throw new GmailTextFault('input_too_large');
  let characters = 0;
  const retained = new Map<string, string[]>();
  for (const header of headers) {
    characters += header.name.length + header.value.length;
    if (characters > policy.maxInputCharacters) throw new GmailTextFault('input_too_large');
    const name = header.name.toLowerCase();
    if (!['subject', 'date', 'from', 'to', 'cc'].includes(name)) continue;
    const values = retained.get(name) ?? [];
    values.push(header.value); retained.set(name, values);
  }
  const field = (name: string, single: boolean, maximum: number): string => {
    const values = retained.get(name) ?? [];
    const raw = single ? values[0] ?? '' : values.join(', ');
    return sanitizeMailMetadata(raw, { ...policy, maxOutputCharacters: Math.min(maximum, policy.maxOutputCharacters) }).text;
  };
  return {
    subject: field('subject', true, 200), date: field('date', true, 1000),
    from: field('from', false, 4000), to: field('to', false, 4000), cc: field('cc', false, 4000),
  };
}
