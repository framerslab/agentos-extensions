/**
 * @fileoverview What a message's header fields say beside its envelope, as `EmailService`'s reads give it: the
 * Delivered-To addresses, the threading ids, the fields that mark a message a machine sent, and the
 * Authentication-Results field (RFC 8601) parsed to the DKIM, SPF and DMARC results, the domain the DMARC result speaks
 * for, and the domain a DKIM signature aligns with the From address. A host that reads a message's header another way,
 * such as through Gmail's API, reads the same fields with `readHeaderFields`.
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
  /**
   * The DMARC result (RFC 7489), in lowercase, such as `pass` or `fail`; `none` when the field names none. It is the
   * receiving host's verdict for the domain `dmarcFrom` names, the From domain that host read; this result does not
   * compare that domain with the From address a read gives, so a host that trusts it compares `dmarcFrom` with that
   * address's domain.
   */
  dmarc: string;
  /**
   * The domain the DMARC result names as `header.from`, the domain of the From field the receiving host read (RFC 7489
   * section 11.1), in lowercase without a closing dot: the domain its DMARC result speaks for. `none` when the field
   * names no DMARC result, or one that names no domain.
   */
  dmarcFrom: string;
  /**
   * The From address's domain, in lowercase, when a DKIM signature that passed was made for that domain or for a domain
   * it ends in after a dot: the signature's `header.d`, or the domain of its `header.i` where it names no `header.d`.
   * `none` otherwise, and when the From address given names no domain, as a group's or an absent From's does. A
   * signature made for a domain below the From domain, which RFC 7489 section 3.1.1's relaxed alignment also counts,
   * does not count here: finding a domain's organizational domain needs the public suffix list.
   */
  alignedDomain: string;
}

/** What `readHeaderFields` and `parseAuthenticationResults` read a header block against. */
export interface HeaderFieldOptions {
  /**
   * The message's From address, whose domain a DKIM signature must align with; a From that names no domain, such as the
   * empty string, aligns with none. When `from` is not given at all, the `header.from` of the DMARC result names the
   * domain.
   */
  from?: string;
  /**
   * The authserv-id of the host that takes mail into the mailbox, such as `mx.google.com`, compared ignoring case. Only
   * the topmost Authentication-Results field is read, since each host that checks a message adds its field at the top
   * (RFC 8601 sections 2.1 and 4), and given `authServId` it counts only when it names that host: a mail whose topmost
   * field names another host, or none, reads `none` throughout, and a field below the topmost never counts, whatever
   * host it names. Without it the topmost field counts whatever host it names. The topmost field is the receiving
   * host's only when that host writes one on every message it takes in: on a host that writes none, it is one the
   * sender wrote, and `authServId` cannot tell the two apart. A host that writes one field per test, as RFC 8601
   * section 4 allows, gives its topmost field's results alone. Give it for any decision that trusts the results. A
   * value that is not text, holds a control character or is white space alone throws an `Error`; `null` and the empty
   * string count as not given.
   */
  authServId?: string;
}

/** What `readHeaderFields` reads from a header block. */
export interface HeaderFields {
  /** The address of each Delivered-To field, in lowercase, as `addressOf` gives it, in the header's order. */
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

/** A control character, which no host's name holds. */
const CONTROL = /[\x00-\x1f\x7f]/;

/**
 * The receiving host's authserv-id in lowercase, or `undefined` when none is given: `undefined`, `null` or the empty
 * string. A value that is not text, that holds a control character or that is white space alone, which would let the
 * topmost field of any host count, throws an `Error` that holds none of it.
 *
 * @param authServId The authserv-id as a caller gave it.
 */
export function requireAuthServId(authServId: unknown): string | undefined {
  if (authServId === undefined || authServId === null || authServId === '') return undefined;
  if (typeof authServId === 'string' && !CONTROL.test(authServId) && authServId.trim() !== '') return authServId.trim().toLowerCase();
  throw new Error('The authServId was refused: give it as the name of the host that received the mail');
}

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

/**
 * One Authentication-Results field's authserv-id, in lowercase, and each result it records (RFC 8601 section 2.2). An
 * authserv-id is a token or a quoted string (RFC 2045 section 5.1), and a bare `=` is part of neither, so a field whose
 * text before its first semicolon holds one names no authserv-id, as Outlook writes the field: that text is its first
 * result, and its authserv-id reads as the empty string, which names no host.
 */
function resultsOf(value: string): { authServId: string; results: MethodResult[] } {
  const [head = '', ...rest] = segmentsOf(withoutComments(value));
  const headTokens = tokensOf(head);
  const namesHost = !headTokens.includes(null);
  const id = namesHost ? headTokens[0] : undefined;
  const results: MethodResult[] = [];
  for (const segment of namesHost ? rest : [head, ...rest]) {
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

/**
 * The results of a header block's topmost Authentication-Results field: the receiving host's, since each host that
 * checks a message adds its field at the top (RFC 8601 sections 2.1 and 4), so a field a sender wrote sits below it.
 * Given `authServId`, that field counts only when it names that host, and no field below it ever counts, so a field a
 * sender wrote naming that host is never read in place of a topmost field that names another host or none.
 */
function authenticationOf(fields: Array<[string, string]>, options: HeaderFieldOptions): EmailAuthentication {
  const wanted = requireAuthServId(options.authServId);
  const topmost = fields.find(([name]) => name.toLowerCase() === 'authentication-results');
  const field = topmost === undefined ? undefined : resultsOf(topmost[1]);
  const results: MethodResult[] = field !== undefined && (wanted === undefined || field.authServId === wanted) ? field.results : [];
  const dkim = results.filter((entry) => entry.method === 'dkim');
  const spf = results.find((entry) => entry.method === 'spf');
  const dmarc = results.find((entry) => entry.method === 'dmarc');
  const passing = dkim.filter((entry) => entry.result === 'pass');
  const dmarcFrom = domainOf(dmarc?.properties.get('header.from'));
  // A From given that names no domain aligns with none; the DMARC result's domain stands in only for a From not given.
  const fromDomain = options.from === undefined ? dmarcFrom : domainOf(options.from);
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
    dmarcFrom: dmarcFrom ?? 'none',
    alignedDomain: aligned && fromDomain !== undefined ? fromDomain : 'none',
  };
}

/** The keyword a field such as Auto-Submitted gives, in lowercase: its text before any parameter, comments left out. */
function keywordOf(value: string): string {
  const [keyword = ''] = withoutComments(value).split(';');
  return keyword.trim().toLowerCase();
}

/** A character a local part holds only in quotes (RFC 5322 section 3.2.3): white space or a special other than the dot. */
const QUOTED_ONLY = /[\s"(),:;<>@[\]\\]/;

/** A local part written in quotes: a double quote, text and quoted pairs, a double quote. */
const QUOTED_LOCAL = /^"(?:[^"\\]|\\.)*"$/;

/**
 * An address as a read gives it, in lowercase, or `undefined` when it names no local part or a domain with white space
 * in it: its local part in quotes, as RFC 5322 writes it, only when it holds white space, a double quote or another
 * special but the dot, and else bare. A server gives an envelope's local part with its quoting removed (RFC 3501 section
 * 9, `addr-mailbox`), and a Delivered-To field keeps it as written, so `support team@example.com` from an envelope and
 * `"Support Team"@example.com` from a field both read `"support team"@example.com`, and `"bob"@example.com` reads
 * `bob@example.com`.
 *
 * @param text An address, alone.
 */
export function addressOf(text: string): string | undefined {
  const address = text.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return undefined;
  const written = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (/\s/.test(domain)) return undefined;
  // A quoted local part is read as the text it quotes, so that each address has one form whichever way it came.
  const local = QUOTED_LOCAL.test(written) ? written.slice(1, -1).replace(/\\(.)/g, '$1') : written;
  if (local !== '' && !QUOTED_ONLY.test(local)) return `${local}@${domain}`;
  return `"${local.replace(/["\\]/g, (character) => `\\${character}`)}"@${domain}`;
}

/** The address a Delivered-To field names, as `addressOf` gives it, or `undefined` when it names none. */
function addressIn(value: string): string | undefined {
  const text = withoutComments(value);
  const angle = /<([^<>]*)>/.exec(text);
  return addressOf(angle === null ? text : (angle[1] ?? ''));
}

/**
 * The DKIM, SPF and DMARC results, the domain the DMARC result names and the aligned domain a header block's topmost
 * Authentication-Results field records, the receiving host's: given `authServId`, that field counts only when it names
 * that host, and no field below it ever counts. A field that names no authserv-id, as Outlook writes it, is read from
 * its first result and names no host. A result the field does not record, and a header with no field that counts, reads
 * `none`. Comments are left out, so a semicolon inside one splits nothing, and a folded field is read whole. An
 * `authServId` that is not text, holds a control character or is white space alone throws an `Error`.
 *
 * @param headerBlock The message's header block, or the fields of it a read fetched, in the header's order.
 * @param options The From address to align with and the receiving host's authserv-id.
 */
export function parseAuthenticationResults(headerBlock: string, options: HeaderFieldOptions = {}): EmailAuthentication {
  return authenticationOf(unfoldedFields(headerBlock), options);
}

/**
 * What a header block says beside the envelope: its Delivered-To addresses, its threading ids, the fields that mark a
 * message a machine sent, and its Authentication-Results as `parseAuthenticationResults` reads them.
 *
 * @param headerBlock The message's header block, or the fields of it a read fetched, in the header's order.
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
