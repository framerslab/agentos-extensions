/**
 * @fileoverview Deterministic pre-storage sanitization of mail text: once percent and character references are decoded
 * and padding collapsed, address tokens, credential assignments, known credential shapes, private-key blocks and long
 * mixed tokens are replaced with fixed marks, and a final gate suppresses any line that still carries a credential
 * cue, with the value after a line that introduces one. Every mark keeps its line's quote markers. Every count is a
 * number; no matched value, offset or reverse mapping is kept, nothing is logged and no model or network is called.
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
  /** How many credential lines, shapes, one-time codes, long mixed tokens and private-key blocks became `[secret removed]`. */
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
// How a line the final gate suppresses ends when it introduces a value on the lines after it ("Your password is:",
// "Your new password is", "changed to", "is below."): with `:` or `=`, or with one of these words after its cue, `below`
// and `follows` also with a full stop. A line ending any other way, such as "was changed.", introduces nothing.
const introduction = /(?:[:=]|(?<![a-z0-9])(?:is|are|was|were|be|(?:below|follows)\.?|(?:set|reset|changed|updated)[ \t]+to))$/i;
// A gated line that ends with its cue, or with its cue and a full stop, as a label above its value does ("Temporary
// password", "Here is your new password.").
const labelled = new RegExp(`(?:${residual.source})\\.?$`, 'i');
// A one-time code is a credential. Its digits: four to eight as one run, or equal groups of two, three or four joined
// by one space or hyphen (`482 913`, `482-913`, `48 29 13`); a longer run, such as a telephone number, is not a code,
// so the match ends where the digits do. The words that name one: a sign-in, login, verification, security,
// authentication, confirmation, one-time or two-factor code or passcode, a one-time password or PIN, `passcode`, `OTP`,
// and `your ... code` with up to two words between (`Your Apple ID Code`, `Your WhatsApp code`), a ZIP, postal, area,
// country or dialling code excepted. No cue continues into a letter or digit.
const codeDigits = String.raw`(?<![0-9])(?:[0-9]{4,8}|[0-9]{3}[ -][0-9]{3}|[0-9]{4}[ -][0-9]{4}|[0-9]{2}(?:[ -][0-9]{2}){1,3})(?![ -]?[0-9])`;
const codeWords = String.raw`(?<![a-z0-9])(?:(?:sign[ -]?in|log[ -]?in|verification|security|authentication|confirmation|one[ -]?time|two[ -]?factor|2fa)[ -](?:pass)?code|one[ -]?time[ -](?:password|pin)|passcode|otp|your(?:[ -](?!(?:zip|postal|post|area|country|diall?ing)(?![a-z0-9]))[a-z0-9]+){0,2}[ -]code)(?![a-z0-9])`;
const codeCue = new RegExp(codeWords, 'i');
// The code after its words on one line, past `is`, a colon, an equals sign, a dash and an opening quote or bracket
// (`Your verification code is 482913`, `Security code: 4821`), and before them (`482913 is your Instagram code`, `Use
// 482913 as your sign-in code`). The words stay; the digits become the mark.
const codeAfterWords = new RegExp(String.raw`(${codeWords}(?:\s+is)?\s*[:=\-–—]?\s*["'“‘(\[]?\s*)${codeDigits}`, 'gi');
const codeBeforeWords = new RegExp(String.raw`${codeDigits}(\s+(?:is|as)\s+(?:your|the)\s+(?:[a-z0-9-]+\s+){0,2}(?:code|passcode|otp|pin)(?![a-z0-9]))`, 'gi');
// A line holding the digits alone, as an HTML mail's code box becomes once its tags are stripped.
const codeAlone = new RegExp(String.raw`^([\s"'“‘(\[]*)${codeDigits}([\s"'”’)\].]*)$`, 'i');
// How many lines holding text after one that names a code may be the code alone, at that line's quote depth: an HTML
// mail's heading, the sentence under it and its code box are three.
const codeLines = 6;
// A line's quote prefix: its `>` markers and the spaces and tabs around them.
const quotePrefix = /^[ \t]*(?:>[ \t]*)+/;
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
// The prefix a mark keeps: the quote's `>` markers, each run of spaces and tabs among them shortened to its first
// character, so a mark keeps its line's depth and none of the padding of the line it replaces.
function markPrefix(quote: string): string {
  return quote.replace(/[ \t]+/g, (run) => run.charAt(0));
}
// The number of `>` markers in a quote prefix.
function quoteDepth(quote: string): number {
  let depth = 0;
  for (let i = 0; i < quote.length; i++) if (quote.charCodeAt(i) === 0x3e) depth++;
  return depth;
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
 * blocks, credential assignments and authenticated URLs are replaced, credential shapes, one-time codes and long mixed
 * tokens become `[secret removed]`, address tokens become `[address removed]`, and a line with unresolved encoded bytes
 * or character references, above the line cap or still carrying a credential cue becomes
 * `[line removed by the secret gate]`. A one-time code is four to eight digits, as one run or in equal groups of two,
 * three or four joined by a space or a hyphen, beside the words that name a sign-in, login, verification, security,
 * authentication, confirmation, one-time or two-factor code or passcode, a one-time password or PIN, `passcode`, `OTP`
 * or `your ... code` with up to two words between (a ZIP, postal, area, country or dialling code is none): after them,
 * past `is`, a colon, an equals sign, a dash or an opening quote or bracket, or before them (`482913 is your Instagram
 * code`), and the words stay; digits alone on a line, as an HTML mail's code box becomes, are a code within six lines
 * holding text after a line that names one, at that line's quote depth. A longer run of digits is not a code, and
 * digits beside other words stay. Padding is a run of spaces and invisible characters that holds anything other
 * than ASCII spaces and tabs, such as the no-break spaces and zero-width non-joiners mail templates repeat after a
 * preheader: it becomes one space, or nothing when it holds no space at all, so zero-width characters between letters
 * join them, and nothing when it holds an invisible character and ends a line. A run of ASCII spaces and tabs alone
 * stays as written. An assignment with an empty value, a block scalar or an unclosed quote also suppresses the rest of
 * the text. A line the final gate suppresses that introduces a value, ending with `:` or `=`, or with `is`, `are`,
 * `was`, `were`, `be`, `below`, `follows` or `set`, `reset`, `changed` or `updated` followed by `to` (`below` and
 * `follows` also with a full stop), also suppresses the value: the next line that holds text at the introduction's
 * quote depth, past any blank lines, and the lines after it in its paragraph, which a blank line or a change of quote
 * depth ends. One that ends with its cue, or with its cue and a full stop, as a label above its value does, also
 * suppresses the next line that holds text when that line is one word at the label's quote depth. A line that holds
 * text at another depth ends either and stays. A gated line that ends any other way, such as `Reset your password from
 * Settings.` or `Your password was changed.`, leaves the next line alone. Every mark keeps its line's quote markers
 * (`>`), each run of spaces and tabs among them shortened to one character, so trimming still reads removed history
 * as quoted and a mark holds none of the padding of the line it replaces. The complete input is checked before the
 * output cap clips the result.
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
  // After a gated line that introduces a value: `value` until the next line that holds text at the introduction's quote
  // depth, which is the value, then `paragraph` while the lines after it hold text at that depth. After a gated line
  // that ends with its cue: `label` until the next line that holds text, which is its value when it is one word at the
  // label's depth. Blank lines before the value are passed over; a line that holds text at another depth ends either.
  let introduced: 'none' | 'value' | 'paragraph' | 'label' = 'none'; let valueDepth = 0;
  // After a line that names a one-time code: how many lines holding text at its quote depth may still be the code
  // alone. A line holding text at another depth ends the count; a line naming a code starts it again.
  let codeLinesLeft = 0; let codeDepth = 0;
  const lines: string[] = [];
  for (const raw of normalized.split('\n')) {
    // Read before any branch: every mark keeps the line's quote markers, so removal cannot turn quoted history into
    // fresh text and trimming still finds it.
    const quote = raw.match(quotePrefix)?.[0] ?? '';
    const marked = markPrefix(quote);
    const depth = quoteDepth(quote);
    let line = raw.slice(quote.length);
    const holdsText = line.trim() !== '';
    if (holdsText && depth !== codeDepth) codeLinesLeft = 0;
    const codeExpected = holdsText && codeLinesLeft > 0;
    if (codeExpected) codeLinesLeft--;
    if (codeCue.test(line)) { codeLinesLeft = codeLines; codeDepth = depth; }
    let withinValue = false;
    if (introduced !== 'none') {
      const held = line.trim();
      if (held === '') { if (introduced === 'paragraph') introduced = 'none'; }
      else if (depth !== valueDepth) introduced = 'none';
      else if (introduced === 'label') { introduced = 'none'; withinValue = !/\s/.test(held); }
      else { introduced = 'paragraph'; withinValue = true; }
    }
    if (credentialTail) { suppressedLines++; lines.push(marked + lineMark); continue; }
    if (insideKey || beginKey.test(raw)) {
      if (!insideKey) secretRedactions++;
      insideKey = !endKey.test(raw);
      lines.push(marked + secretMark); continue;
    }
    if (raw.length > policy.maxLineCharacters || unresolved.test(raw) || holdsNamedReference(raw)) {
      suppressedLines++; lines.push(marked + lineMark); continue;
    }
    if (assignment.test(line) || containsAuthenticatedUrl(line) || /\bsshpass\s+-p\b/i.test(line)) {
      const found = assignment.exec(line); const value = found ? line.slice(found.index + found[0].length).trim() : null; credentialTail = value !== null && (value === '' || /^[|>][+-]?$/.test(value) || ((value[0] === '"' || value[0] === "'") && value.lastIndexOf(value[0]) === 0)); secretRedactions++; lines.push(marked + secretMark); continue;
    }
    for (const source of shapeSources) {
      line = line.replace(new RegExp(source, 'g'), () => { secretRedactions++; return secretMark; });
    }
    line = line.replace(codeAfterWords, (_match, words: string) => { secretRedactions++; return words + secretMark; });
    line = line.replace(codeBeforeWords, (_match, words: string) => { secretRedactions++; return secretMark + words; });
    if (codeExpected) {
      line = line.replace(codeAlone, (_match, before: string, after: string) => { secretRedactions++; return before + secretMark + after; });
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
      // "Your password is:" names no assignment, so the value it introduces is on a later line. A label inside a value's
      // paragraph leaves the paragraph's removal in place; one that is the word a label above it took ("Password" under
      // "Your Wi-Fi password") is a label of its own.
      const end = line.trimEnd();
      if (introduction.test(end)) { introduced = 'value'; valueDepth = depth; }
      else if (introduced !== 'paragraph' && labelled.test(end)) { introduced = 'label'; valueDepth = depth; }
      suppressedLines++; lines.push(marked + lineMark); continue;
    }
    if (withinValue) { suppressedLines++; lines.push(marked + lineMark); continue; }
    lines.push(quote + line);
  }
  const complete = lines.join('\n');
  const text = clipped(complete, policy.maxOutputCharacters);
  return { text, addressRedactions, secretRedactions, suppressedLines, truncated: text.length < complete.length };
}
/**
 * Whether decoded text holds nothing but whitespace once its percent and character references are decoded, its
 * padding collapsed and its format and control characters removed, the steps `sanitizeMailText` takes before any
 * other. A MIME reader uses it to pass over an alternative whose text would sanitize away, such as a plain part of
 * `&nbsp;` and `&#8203;` beside the HTML that holds the message.
 *
 * @param input Decoded text: one MIME part's body.
 * @param maxInputCharacters The sanitizer's input cap. Text above it, before or after decoding, is not blank: the
 * sanitizer refuses it rather than emptying it.
 * @returns True when nothing but whitespace is left.
 */
export function blankMailText(input: string, maxInputCharacters: number): boolean {
  try { return canonical(input, maxInputCharacters).trim().length === 0; }
  catch (error) { if (error instanceof GmailTextFault) return false; throw error; }
}
/**
 * Use for every filename, label name and display field: a header value or filename after MIME decoding, and a label
 * name as the labels response gives it, since that JSON text is never MIME encoded. Applies the same rules as
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
