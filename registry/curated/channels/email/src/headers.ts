/**
 * @fileoverview What a message's header fields say beside its envelope, as `EmailService`'s reads give it: the
 * Delivered-To addresses, the threading ids, the fields that mark a message a machine sent, and the
 * Authentication-Results field (RFC 8601) parsed to the DKIM, SPF and DMARC results and the domain a DKIM signature
 * aligns with the From address. A host that reads a message's header another way, such as through Gmail's API, reads
 * the same fields with `readHeaderFields`.
 */

import { idsOf, unfoldedFields } from './messageHeaders.js';

/** The results the receiving host recorded in its Authentication-Results field (RFC 8601). */
export interface EmailAuthentication {
  /**
   * The DKIM result (RFC 6376), in lowercase: `pass` when any signature passed, else the first signature's result, such
   * as `fail`; `none` when the field names no DKIM result.
   */
  dkim: string;
  /** The SPF result (RFC 7208), in lowercase, such as `pass` or `softfail`; `none` when the field names none. */
  spf: string;
  /** The DMARC result (RFC 7489), in lowercase, such as `pass` or `fail`; `none` when the field names none. */
  dmarc: string;
  /**
   * The From address's domain, in lowercase, when a DKIM signature that passed was made for that domain or for a domain
   * it ends in after a dot: the signature's `header.d`, or the domain of its `header.i` where it names no `header.d`
   * (RFC 7489 section 3.1.1 calls the parent case relaxed alignment). `none` otherwise, and when the From address names no
   * domain.
   */
  alignedDomain: string;
}

/** What `readHeaderFields` and `parseAuthenticationResults` read a header block against. */
export interface HeaderFieldOptions {
  /**
   * The message's From address, whose domain a DKIM signature must align with. Without one, the `header.from` of the
   * DMARC result names the domain.
   */
  from?: string;
  /**
   * The authserv-id of the host that received the message, such as `mx.google.com`, compared ignoring case: only an
   * Authentication-Results field that names it counts. Without it the first field counts, the one the host that took
   * the message in last wrote at the top of the header.
   */
  authServId?: string;
}

/** What `readHeaderFields` reads from a header block. */
export interface HeaderFields {
  /** The address of each Delivered-To field, in lowercase, in the header's order. */
  deliveredTo: string[];
  /** The first message id In-Reply-To lists, in angle brackets, or the empty string. */
  inReplyTo: string;
  /** The message ids References lists, each in angle brackets, in its order. */
  references: string[];
  /** The keyword of the first Auto-Submitted field (RFC 3834), in lowercase; `no` when the header has none. */
  autoSubmitted: string;
  /** The keyword of the first Precedence field, in lowercase, such as `bulk` or `list`; the empty string when none. */
  precedence: string;
  /** Whether the header holds an X-Autoreply or an X-Auto-Response-Suppress field, whatever its value. */
  autoreply: boolean;
  /** The receiving host's Authentication-Results, parsed. */
  authentication: EmailAuthentication;
}

/** One method's result in an Authentication-Results field: the method, its result and its properties by name. */
interface MethodResult {
  method: string;
  result: string;
  properties: Map<string, string>;
}

/** A token of a field's text: a word, a quoted string's content, or `null` for an `=`. */
type Token = string | null;

/** A quoted string, a lone `=`, or a run of characters that are neither white space, `=` nor a double quote. */
const TOKEN = /"(?:[^"\\]|\\.)*"?|=|[^\s="]+/g;

/** A domain: labels of characters other than white space, `@` and `.`, at least two, joined by dots. */
const DOMAIN = /^[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * `value` with each comment written as a space (RFC 5322 section 3.2.2): text in parentheses, which may nest and may
 * hold a quoted pair, outside quoted strings, where a parenthesis is text.
 */
function withoutComments(value: string): string {
  let out = '';
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (depth > 0) {
      if (character === '\\') index += 1;
      else if (character === '(') depth += 1;
      else if (character === ')') {
        depth -= 1;
        if (depth === 0) out += ' ';
      }
      continue;
    }
    if (quoted) {
      out += character;
      if (character === '\\' && index + 1 < value.length) {
        index += 1;
        out += value.charAt(index);
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '(') depth = 1;
    else {
      if (character === '"') quoted = true;
      out += character;
    }
  }
  return out;
}

/** `value` split at each semicolon outside a quoted string. */
function segmentsOf(value: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value.charAt(index);
    if (quoted) {
      current += character;
      if (character === '\\' && index + 1 < value.length) {
        index += 1;
        current += value.charAt(index);
      } else if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (character === '"') quoted = true;
    current += character;
  }
  segments.push(current);
  return segments;
}

/** The tokens of a segment, each quoted string given as its content with its quoted pairs read. */
function tokensOf(segment: string): Token[] {
  const tokens: Token[] = [];
  for (const [token] of segment.matchAll(TOKEN)) {
    if (token === '=') tokens.push(null);
    else if (token.startsWith('"')) tokens.push(token.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1'));
    else tokens.push(token);
  }
  return tokens;
}

/** Each `name=value` the tokens hold, in order; a stray `=` or a word with no value is passed over. */
function pairsOf(tokens: Token[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  let index = 0;
  while (index + 2 < tokens.length) {
    const name = tokens[index];
    const value = tokens[index + 2];
    if (typeof name === 'string' && tokens[index + 1] === null && typeof value === 'string') {
      pairs.push([name, value]);
      index += 3;
    } else {
      index += 1;
    }
  }
  return pairs;
}

/** One Authentication-Results field's authserv-id, in lowercase, and each result it records (RFC 8601 section 2.2). */
function resultsOf(value: string): { authServId: string; results: MethodResult[] } {
  const [head = '', ...rest] = segmentsOf(withoutComments(value));
  const [id] = tokensOf(head);
  const results: MethodResult[] = [];
  for (const segment of rest) {
    const [first, ...properties] = pairsOf(tokensOf(segment));
    if (first === undefined) continue;
    const named = new Map<string, string>();
    for (const [name, property] of properties) {
      const key = name.toLowerCase();
      if (!named.has(key)) named.set(key, property);
    }
    // A method may carry a version after a slash, such as dkim/1.
    results.push({ method: first[0].toLowerCase().replace(/\/.*$/, ''), result: first[1].toLowerCase(), properties: named });
  }
  return { authServId: typeof id === 'string' ? id.toLowerCase() : '', results };
}

/** The domain `text` names, in lowercase without a closing dot: all of it, or what follows its last `@`. */
function domainOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const domain = text
    .slice(text.lastIndexOf('@') + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  return DOMAIN.test(domain) ? domain : undefined;
}

/** The results of the Authentication-Results field the options pick from a header block's fields. */
function authenticationOf(fields: Array<[string, string]>, options: HeaderFieldOptions): EmailAuthentication {
  const wanted = options.authServId?.trim().toLowerCase();
  let results: MethodResult[] = [];
  for (const [name, value] of fields) {
    if (name.toLowerCase() !== 'authentication-results') continue;
    const field = resultsOf(value);
    if (wanted === undefined || wanted === '' || field.authServId === wanted) {
      results = field.results;
      break;
    }
  }
  const dkim = results.filter((entry) => entry.method === 'dkim');
  const spf = results.find((entry) => entry.method === 'spf');
  const dmarc = results.find((entry) => entry.method === 'dmarc');
  const passing = dkim.filter((entry) => entry.result === 'pass');
  const fromDomain = domainOf(options.from) ?? domainOf(dmarc?.properties.get('header.from'));
  const aligned =
    fromDomain !== undefined &&
    passing.some((entry) => {
      const signing = domainOf(entry.properties.get('header.d')) ?? domainOf(entry.properties.get('header.i'));
      return signing !== undefined && (signing === fromDomain || fromDomain.endsWith(`.${signing}`));
    });
  return {
    dkim: passing.length > 0 ? 'pass' : (dkim[0]?.result ?? 'none'),
    spf: spf?.result ?? 'none',
    dmarc: dmarc?.result ?? 'none',
    alignedDomain: aligned && fromDomain !== undefined ? fromDomain : 'none',
  };
}

/** The keyword a field such as Auto-Submitted gives, in lowercase: its text before any parameter, comments left out. */
function keywordOf(value: string): string {
  const [keyword = ''] = withoutComments(value).split(';');
  return keyword.trim().toLowerCase();
}

/** The address a Delivered-To field names, in lowercase, or `undefined` when it names none. */
function addressIn(value: string): string | undefined {
  const text = withoutComments(value);
  const angle = /<([^<>]*)>/.exec(text);
  const address = (angle === null ? text : (angle[1] ?? '')).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at > 0 && at < address.length - 1 && !/\s/.test(address) ? address : undefined;
}

/**
 * The DKIM, SPF and DMARC results and the aligned domain a header block's Authentication-Results field records: the
 * first such field, or, given `authServId`, the first that names that host. A result the field does not record, and a
 * header with no field that counts, reads `none`. Comments are left out, so a semicolon inside one splits nothing, and
 * a folded field is read whole.
 *
 * @param headerBlock The message's header block, or the fields of it a read fetched.
 * @param options The From address to align with and the receiving host's authserv-id.
 */
export function parseAuthenticationResults(headerBlock: string, options: HeaderFieldOptions = {}): EmailAuthentication {
  return authenticationOf(unfoldedFields(headerBlock), options);
}

/**
 * What a header block says beside the envelope: its Delivered-To addresses, its threading ids, the fields that mark a
 * message a machine sent, and its Authentication-Results as `parseAuthenticationResults` reads them.
 *
 * @param headerBlock The message's header block, or the fields of it a read fetched.
 * @param options The From address to align with and the receiving host's authserv-id.
 */
export function readHeaderFields(headerBlock: string, options: HeaderFieldOptions = {}): HeaderFields {
  const fields = unfoldedFields(headerBlock);
  const valuesOf = (name: string): string[] => fields.filter(([field]) => field.toLowerCase() === name).map(([, value]) => value);
  const [autoSubmitted] = valuesOf('auto-submitted');
  const [precedence] = valuesOf('precedence');
  return {
    deliveredTo: valuesOf('delivered-to')
      .map((value) => addressIn(value))
      .filter((address): address is string => address !== undefined),
    inReplyTo: idsOf(fields, 'in-reply-to')[0] ?? '',
    references: idsOf(fields, 'references'),
    autoSubmitted: autoSubmitted === undefined ? 'no' : keywordOf(autoSubmitted),
    precedence: precedence === undefined ? '' : keywordOf(precedence),
    autoreply: fields.some(([field]) => ['x-autoreply', 'x-auto-response-suppress'].includes(field.toLowerCase())),
    authentication: authenticationOf(fields, options),
  };
}
