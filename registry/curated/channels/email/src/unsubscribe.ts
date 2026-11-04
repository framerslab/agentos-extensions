/**
 * @fileoverview An unsubscribe link on every mail the service sends once its configuration names `unsubscribe`: the
 * suppression record read before the send, an opaque token drawn for the recipient's address and the kind of mail, RFC
 * 8058's `List-Unsubscribe` and `List-Unsubscribe-Post` fields, and a visible link at the foot of each part with the
 * sender's postal address. The token names the address's hash and the list its link writes to, nothing else, so a link
 * can only ever stop mail. `createUnsubscribeHandler` (`./unsubscribeHandler`) answers the link.
 */
import { createHash, randomUUID } from 'node:crypto';
import { types } from 'node:util';
import type { RecipientCapability } from './preferences/RecipientCapability.js';
import { DEFAULT_SUPPRESSION_SCOPE } from './preferences/SuppressionStore.js';
import type { SuppressionStore } from './preferences/SuppressionStore.js';

/**
 * The list every send reads, required mail and replies included: an address on it gets no mail at all. An operator
 * writes it, such as for a person who asked never to be written to again.
 */
export const DO_NOT_CONTACT_SCOPE = 'do-not-contact';

/** The list of the addresses that turned off every optional mail: a required mail's link, and the page's second button, write it. */
export const OPTIONAL_MAIL_SCOPE = 'optional';

/** What a part may hold where its link goes: the service writes the link there and adds no footer to that part. */
export const UNSUBSCRIBE_URL_MARKER = '{{unsubscribe_url}}';

/** What every category's list begins with. */
const CATEGORY_PREFIX = 'optional:';

/** A category: a lower-case letter, then at most 63 lower-case letters, digits, hyphens or underscores. */
const CATEGORY = /^[a-z][a-z0-9_-]{0,63}$/;

/** The most characters a page address takes, so a link with its token stays inside one line of `List-Unsubscribe`. */
const MOST_PAGE_CHARACTERS = 900;

/** An address a `mailto:` link can carry as written: no character a URI would have to escape. */
const MAILBOX = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** One address in a recipient: no white space and none of the characters that separate or quote addresses. */
const ADDRESS = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;

/** A character no line of a footer may hold: a control character, or a Unicode line or paragraph separator. */
const NOT_ON_A_LINE = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

/** How the record names an address: 64 lower-case hexadecimal characters, which the route reads a token's recipient by. */
export const ADDRESS_HASH = /^[0-9a-f]{64}$/;

/** The white space of HTML, the only white space that separates a tag's parts: a no-break space is part of a name. */
const HTML_SPACE = String.raw`\t\n\f\r `;

/** What ends a tag's name: white space, a slash or a closing bracket, read and not taken. */
const NAME_END = String.raw`(?=[${HTML_SPACE}/>])`;

/**
 * An attribute's value as the HTML standard's tokenizer reads it: quoted, a quote left open running to the part's end,
 * or unquoted, running to white space or a closing bracket.
 */
const VALUE = String.raw`(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^${HTML_SPACE}>"'][^${HTML_SPACE}>]*)`;

/**
 * A tag's attributes after its name, as the HTML standard's tokenizer reads them: a name, which an equals sign may
 * start, then an equals sign and a value when it has one, so a quote opens a value only after an equals sign. Every
 * character but `>` starts one alternative or the other, so this stops only at a `>` or the part's end, and whatever
 * follows it in `HTML_SPANS` matches at either: a match never backtracks into it, however long the tag.
 */
const ATTRIBUTES = String.raw`(?:[${HTML_SPACE}/]+|(?:=[^${HTML_SPACE}/>=]*|[^${HTML_SPACE}/>=]+)(?:[${HTML_SPACE}]*=[${HTML_SPACE}]*${VALUE}?)?)*`;

/** The elements a browser reads as text to their end tag, whatever tags they seem to hold; a script has rules of its own. */
const TEXT_ELEMENTS = 'style|title|textarea|xmp|iframe|noembed|noframes|plaintext';

/**
 * Every span of a part's HTML that decides where a footer can go, one match each, read as a browser reads them with
 * scripting off, as mail is:
 *
 * - a comment (`openComment` is set when it is left open to the part's end);
 * - an element whose content is text, to its end tag (`openText` is set when it is left open, `openEnd` when its end tag
 *   is);
 * - a doctype, a processing instruction or a bad end tag (`openDeclaration` is set when it is left open);
 * - any other tag, named by `slash` and `name` (`openTag` is set when it is left open).
 *
 * A `</body>` inside any of these is no tag, and a part's end inside any of them hides what follows. Inside an `svg` or
 * a `math` a browser reads a style's or a title's content as tags and a CDATA section as text; this reading takes them
 * as it takes them elsewhere.
 */
const HTML_SPANS = new RegExp(
  [
    String.raw`<!--(?:-?>|[\s\S]*?(?:--!?>|(?<openComment>$)))`,
    String.raw`<(?<text>${TEXT_ELEMENTS})${NAME_END}${ATTRIBUTES}(?:>|$)[\s\S]*?(?:<\/\k<text>${NAME_END}${ATTRIBUTES}(?:>|(?<openEnd>$))|(?<openText>$))`,
    String.raw`<(?:[!?]|\/[^a-z>])[^>]*(?:>|(?<openDeclaration>$))`,
    String.raw`<(?<slash>\/?)(?<name>[a-z][^${HTML_SPACE}/>]*)${ATTRIBUTES}(?:>|(?<openTag>$))`,
  ].join('|'),
  'gi',
);

/**
 * What changes how a browser reads a script's content (the script data states of the HTML standard): the start of a
 * comment, which `>` right after it closes at once; the end of a comment; a script's start tag; a script's end tag.
 */
const SCRIPT_MARKS = new RegExp(String.raw`<!--(?:-*>)?|-->|<script${NAME_END}|<\/script${NAME_END}`, 'gi');

/** The rest of an end tag after its name: `open` is set when the part ends inside it. */
const END_TAG_REST = new RegExp(String.raw`${ATTRIBUTES}(?:>|(?<open>$))`, 'y');

/** The shortest key the tokens take, HMAC-SHA256's output length. */
const KEY_BYTES = 32;

/** The footer's paragraph: 13 pixels, the smallest text a reader is asked to read at a phone's width. */
const FOOT = 'margin:24px 0 0;font-size:13px;line-height:20px;color:#5f6368';

/** The footer's link, underlined so it reads as one without colour. */
const FOOT_LINK = 'color:#5f6368;text-decoration:underline';

/**
 * Returns the category when it is a lower-case letter followed by at most 63 lower-case letters, digits, hyphens or
 * underscores, and otherwise throws a `TypeError` that never holds the value.
 */
function requireCategory(value: unknown): string {
  if (typeof value === 'string' && CATEGORY.test(value)) return value;
  throw new TypeError(
    'The category was refused: give a lower-case letter followed by at most 63 lower-case letters, digits, hyphens or underscores',
  );
}

/**
 * The list of one category of optional mail, `optional:` and the category: its link writes it, and every optional send
 * of the category reads it.
 *
 * @param category A lower-case letter followed by at most 63 lower-case letters, digits, hyphens or underscores.
 * @throws TypeError when the category does not fit.
 */
export function categoryScope(category: string): string {
  return `${CATEGORY_PREFIX}${requireCategory(category)}`;
}

/**
 * The category a list names, or `null` when it is no category's list. `OPTIONAL_MAIL_SCOPE` is no category's list.
 *
 * @param scope A suppression list's name.
 */
export function categoryOfScope(scope: string): string | null {
  if (!scope.startsWith(CATEGORY_PREFIX)) return null;
  const category = scope.slice(CATEGORY_PREFIX.length);
  return CATEGORY.test(category) ? category : null;
}

/** The configuration's `unsubscribe`: what every mail the service sends then carries, and what it reads first. */
export interface UnsubscribeOptions {
  /**
   * The page each link opens and the address a mailbox provider's one-click POST goes to: an https address with no
   * query, fragment or credentials, 900 characters at most. A link is it with `?t=` and the token.
   */
  readonly pageUrl: string;
  /**
   * An address at the sender that takes unsubscribe requests by mail, listed after the link in `List-Unsubscribe` as
   * `mailto:` with the subject `unsubscribe`. Leave it out when nothing reads that mailbox.
   */
  readonly mailto?: string;
  /** Where the tokens are drawn, such as `SqlRecipientCapability`; the route finds them in the same store. */
  readonly tokens: RecipientCapability;
  /** The suppression record read before each send, such as `SqlSuppressionStore`; the route writes it. */
  readonly suppressions: SuppressionStore;
  /**
   * The key the tokens are drawn under, 32 random bytes or more kept secret, or a function that answers it at each send
   * so a rotated key applies at once.
   */
  readonly key: Uint8Array | (() => Uint8Array);
  /**
   * How the record names an address, given the address trimmed and lower-cased: 64 lower-case hexadecimal characters,
   * the same way wherever the host reads or writes the record. The SHA-256 of the address in hex when not given. A send
   * whose address it names any other way is refused with a `TypeError` before any list is read.
   */
  readonly addressHash?: (address: string) => string;
  /**
   * The sender's postal address on one line, printed at the foot of every mail. Commercial mail is refused without it,
   * since CAN-SPAM asks a commercial mail for the sender's valid physical postal address (15 U.S.C. 7704(a)(5)).
   */
  readonly postalAddress?: string;
  /** The category of the mail the `emailSend` tool and the channel adapter send: `conversation` when not given. */
  readonly agentCategory?: string;
  /** The words of the footer's link: `Unsubscribe` when not given. */
  readonly linkText?: string;
}

/** What one send says of its mail. */
export interface UnsubscribeKind {
  /** The category of optional mail, which its link stops; required mail may name one too, which changes nothing. */
  readonly category?: unknown;
  /** Mail a person cannot turn off: sign-in codes, receipts, security and legal notices. */
  readonly required?: unknown;
  /** Advertising mail: optional, and carrying the postal address. */
  readonly commercial?: unknown;
}

/** The lists one send reads, in order, the list its link writes, and whether it is commercial. */
export interface UnsubscribePlan {
  readonly reads: readonly string[];
  readonly tokenScope: string;
  readonly commercial: boolean;
}

/** What a send carries: its link, and the two fields that name it. */
export interface UnsubscribeLink {
  readonly url: string;
  readonly headers: Readonly<Record<'List-Unsubscribe' | 'List-Unsubscribe-Post', string>>;
}

/**
 * A send the suppression record stopped: nothing was sent and no token was drawn. `scope` names the list that held the
 * address; the message names it too, and never the address.
 */
export class EmailSuppressedError extends Error {
  /** Always `suppressed`. */
  readonly code = 'suppressed' as const;
  /** The list that held the address: `DO_NOT_CONTACT_SCOPE`, `DEFAULT_SUPPRESSION_SCOPE`, `OPTIONAL_MAIL_SCOPE` or a category's list. */
  readonly scope: string;

  constructor(scope: string) {
    super(`The mail was not sent: the recipient is on the ${scope} suppression list`);
    this.name = 'EmailSuppressedError';
    this.scope = scope;
  }
}

/** The page address as given, checked: https, no query, fragment or credentials, 900 characters at most. */
function requirePageUrl(value: unknown): string {
  if (typeof value === 'string' && !value.includes('?') && !value.includes('#')) {
    let url: URL | null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (
      url !== null &&
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.href.length <= MOST_PAGE_CHARACTERS &&
      /^[\x21-\x7e]+$/.test(url.href)
    ) {
      return url.href;
    }
  }
  throw new TypeError(
    `The unsubscribe page was refused: give an https address with no query, fragment or credentials, ${MOST_PAGE_CHARACTERS} characters at most`,
  );
}

/** A `mailto` address, checked: one address of letters, digits, dots, plus signs, hyphens and underscores. */
function requireMailto(value: unknown): string {
  if (typeof value === 'string' && value.length <= 254 && MAILBOX.test(value)) return value;
  throw new TypeError('The unsubscribe mailto was refused: give one address, such as unsubscribe@example.com');
}

/** A line of a footer or a page, checked: text on one line, not blank, `most` characters at most. */
export function requireLine(field: string, value: unknown, most: number): string {
  if (typeof value === 'string' && value.trim() !== '' && value.length <= most && !NOT_ON_A_LINE.test(value)) return value;
  throw new TypeError(`The ${field} was refused: give it as text on one line, ${most} characters at most`);
}

/** A store, checked: an object with each of `methods` as a function. */
function requireStore<T>(field: string, value: unknown, methods: readonly string[]): T {
  if (typeof value === 'object' && value !== null && methods.every((name) => typeof (value as Record<string, unknown>)[name] === 'function')) {
    return value as T;
  }
  throw new TypeError(`The unsubscribe ${field} were refused: give a store with ${methods.join(' and ')}`);
}

/** A flag of a send, checked: `undefined` and `null` are `false`. */
function requireFlag(field: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  throw new TypeError(`The ${field} was refused: give it as true or false, or leave it out`);
}

/** The default name of an address on the record: its SHA-256 in lower-case hexadecimal. */
function sha256Of(address: string): string {
  return createHash('sha256').update(address, 'utf8').digest('hex');
}

/** Text written into HTML, its five special characters as references. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

/** What goes between a part's text and a footer: a blank line, or nothing when the part is empty. */
function breakAfter(text: string): string {
  if (text === '') return '';
  return text.endsWith('\n') ? '\n' : '\n\n';
}

/**
 * Where a script's content and its end tag stop, given where its content starts, or `-1` when the part ends first. A
 * comment in a script that opens another script holds the next end tag as text, until that comment ends.
 */
function endOfScript(html: string, from: number): number {
  const marks = new RegExp(SCRIPT_MARKS);
  marks.lastIndex = from;
  let state: 'script' | 'comment' | 'nested' = 'script';
  for (let mark = marks.exec(html); mark !== null; mark = marks.exec(html)) {
    const found = mark[0].toLowerCase();
    if (found.startsWith('<!--')) {
      if (found.endsWith('>')) state = 'script';
      else if (state === 'script') state = 'comment';
    } else if (found === '-->') {
      state = 'script';
    } else if (found === '<script') {
      if (state === 'comment') state = 'nested';
    } else if (state === 'nested') {
      state = 'comment';
    } else {
      const rest = new RegExp(END_TAG_REST);
      rest.lastIndex = marks.lastIndex;
      const tail = rest.exec(html);
      return tail === null || tail.groups?.open !== undefined ? -1 : rest.lastIndex;
    }
  }
  return -1;
}

/**
 * `html` with `footer` before its last closing body tag that is a tag, not text in a comment, an attribute's value or
 * an element whose content is text, nor inside a template, which a browser never shows. With none it goes at the part's
 * end, or, since they would hide it, before a template or anything else the part leaves open there.
 */
function atFoot(html: string, footer: string): string {
  const spans = new RegExp(HTML_SPANS);
  let closingBody = -1;
  let leftOpen = -1;
  let templates = 0;
  let outerTemplate = -1;
  for (let match = spans.exec(html); match !== null; match = spans.exec(html)) {
    const { slash, name, openComment, openDeclaration, openEnd, openTag, openText } = match.groups ?? {};
    if ((openComment ?? openDeclaration ?? openEnd ?? openTag ?? openText) !== undefined) {
      leftOpen = match.index;
      break;
    }
    const tag = name?.toLowerCase();
    if (tag === 'script' && slash === '') {
      const end = endOfScript(html, spans.lastIndex);
      if (end < 0) {
        leftOpen = match.index;
        break;
      }
      spans.lastIndex = end;
    } else if (tag === 'template') {
      if (slash === '') {
        if (templates === 0) outerTemplate = match.index;
        templates += 1;
      } else if (templates > 0) {
        templates -= 1;
      }
    } else if (tag === 'body' && slash === '/' && templates === 0) {
      closingBody = match.index;
    }
  }
  let place = html.length;
  if (closingBody >= 0) place = closingBody;
  else if (templates > 0) place = outerTemplate;
  else if (leftOpen >= 0) place = leftOpen;
  return `${html.slice(0, place)}${footer}${html.slice(place)}`;
}

/** Whether a cc or a bcc names anyone. */
function names(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return false;
  return !(Array.isArray(value) && value.length === 0);
}

/**
 * The one address a recipient names, trimmed and lower-cased: `reader@example.com` or `Reader <reader@example.com>`.
 * A list of addresses, a group, or a display name holding an address is refused with a `TypeError` that holds none of
 * it, since a link names one recipient.
 *
 * @param to The recipient as the send gives it.
 */
export function oneRecipient(to: unknown): string {
  if (typeof to === 'string') {
    const text = to.trim();
    const angle = /^([^<>]*)<([^<>]*)>$/.exec(text);
    // A quoted display name may hold a comma or a colon; outside quotes either would start another address or a group.
    const shown = angle === null ? '' : (angle[1] ?? '').replace(/"(?:[^"\\]|\\.)*"/g, '');
    const address = (angle === null ? text : (angle[2] ?? '')).trim();
    if (!/[@,;:"]/.test(shown) && ADDRESS.test(address)) return address.toLowerCase();
  }
  throw new TypeError(
    'The recipient was refused: with unsubscribe links on, give one address, such as reader@example.com or Reader <reader@example.com>',
  );
}

/**
 * Refuses a cc or a bcc while unsubscribe links are on: a link names one recipient, so each person gets a message of
 * their own.
 */
export function refuseCopies(cc: unknown, bcc: unknown): void {
  if (names(cc) || names(bcc)) {
    throw new TypeError('The send was refused: with unsubscribe links on, each recipient gets a message of their own, so cc and bcc are not taken');
  }
}

/** Refuses the two fields the service writes itself while unsubscribe links are on, in any case. */
export function refuseOwnListFields(headers: Record<string, string> | undefined): void {
  for (const name of Object.keys(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower === 'list-unsubscribe' || lower === 'list-unsubscribe-post') {
      throw new Error(`The header field ${name} was refused: with unsubscribe links on, the service writes it`);
    }
  }
}

/**
 * The checked `unsubscribe` configuration of one service: the plan of each send, the gate and the token, and the
 * footer of each part.
 */
export class Unsubscribe {
  private readonly pageUrl: string;
  private readonly mailto: string | undefined;
  private readonly tokens: RecipientCapability;
  private readonly suppressions: SuppressionStore;
  private readonly key: Uint8Array | (() => Uint8Array);
  private readonly hash: (address: string) => string;
  private readonly linkText: string;
  /** The sender's postal address, or `undefined`. */
  readonly postalAddress: string | undefined;
  /** The category of the mail the `emailSend` tool and the channel adapter send. */
  readonly agentCategory: string;

  /**
   * Checks every option, and throws a `TypeError` that names the first one at fault and holds none of its value.
   *
   * @param options The configuration's `unsubscribe`.
   */
  constructor(options: UnsubscribeOptions) {
    if (typeof options !== 'object' || options === null) {
      throw new TypeError('The unsubscribe configuration was refused: give it as an object');
    }
    this.pageUrl = requirePageUrl(options.pageUrl);
    this.mailto = options.mailto === undefined || options.mailto === null ? undefined : requireMailto(options.mailto);
    this.tokens = requireStore<RecipientCapability>('tokens', options.tokens, ['issue', 'find']);
    this.suppressions = requireStore<SuppressionStore>('suppressions', options.suppressions, ['isSuppressed', 'suppress']);
    const key: unknown = options.key;
    if (typeof key !== 'function' && !(types.isUint8Array(key) && key.byteLength >= KEY_BYTES)) {
      throw new TypeError(`The unsubscribe key was refused: give ${KEY_BYTES} bytes or more, such as a Buffer, or a function that answers them`);
    }
    this.key = options.key;
    if (options.addressHash !== undefined && typeof options.addressHash !== 'function') {
      throw new TypeError('The unsubscribe addressHash was refused: give a function or leave it out');
    }
    this.hash = options.addressHash ?? sha256Of;
    this.postalAddress =
      options.postalAddress === undefined || options.postalAddress === null
        ? undefined
        : requireLine('postal address', options.postalAddress, 300);
    this.agentCategory = options.agentCategory === undefined ? 'conversation' : requireCategory(options.agentCategory);
    this.linkText = options.linkText === undefined ? 'Unsubscribe' : requireLine('link text', options.linkText, 64);
  }

  /**
   * The plan of one send, from its kind: required mail reads the do-not-contact list alone and its link turns off every
   * optional mail; optional mail names its category, reads the do-not-contact list, the provider's record
   * (`DEFAULT_SUPPRESSION_SCOPE`), the list of all optional mail and its category's list, and its link stops the
   * category. Throws before anything is read for a kind that does not fit: optional mail that names no category, a
   * category that is not a lower-case word, required mail marked commercial, or commercial mail with no postal address
   * configured.
   *
   * @param kind What the send says of its mail.
   */
  plan(kind: UnsubscribeKind): UnsubscribePlan {
    const required = requireFlag('required', kind.required);
    const commercial = requireFlag('commercial', kind.commercial);
    if (required && commercial) throw new TypeError('The send was refused: commercial mail is never required mail');
    if (commercial && this.postalAddress === undefined) {
      throw new Error("The send was refused: commercial mail carries the sender's postal address; give the unsubscribe configuration a postalAddress");
    }
    if (required) {
      if (kind.category !== undefined && kind.category !== null) requireCategory(kind.category);
      return this.replyPlan();
    }
    if (kind.category === undefined || kind.category === null) {
      throw new TypeError('The send was refused: optional mail names its category, which its unsubscribe link stops; mark mail a person cannot turn off as required');
    }
    const scope = categoryScope(kind.category as string);
    return { reads: [DO_NOT_CONTACT_SCOPE, DEFAULT_SUPPRESSION_SCOPE, OPTIONAL_MAIL_SCOPE, scope], tokenScope: scope, commercial };
  }

  /** The plan of a reply, and of required mail: the do-not-contact list alone, and a link that turns off every optional mail. */
  replyPlan(): UnsubscribePlan {
    return { reads: [DO_NOT_CONTACT_SCOPE], tokenScope: OPTIONAL_MAIL_SCOPE, commercial: false };
  }

  /**
   * Names the address by `addressHash`, and throws a `TypeError` that holds neither the address nor the name when the
   * name is not 64 lower-case hexadecimal characters, since the route would find no link drawn for it. Then reads each of
   * the plan's lists for the address and throws `EmailSuppressedError` for the first that holds it, then
   * draws the token and answers the link with its two fields. A nonce of the send's own, such as its idempotency key,
   * gives a retry the same token; without one each send draws a new one.
   *
   * @param address The recipient, trimmed and lower-cased, as `oneRecipient` answers it.
   * @param plan The send's plan.
   * @param nonce The send's nonce, or `undefined` for a new one.
   */
  async prepare(address: string, plan: UnsubscribePlan, nonce: string | undefined): Promise<UnsubscribeLink> {
    const addressHash: unknown = this.hash(address);
    // A name the route cannot read would send a link that stops nothing, so it is refused before any list is read.
    if (typeof addressHash !== 'string' || !ADDRESS_HASH.test(addressHash)) {
      throw new TypeError("The unsubscribe addressHash answered a name that was refused: answer the address's hash as 64 lower-case hexadecimal characters");
    }
    for (const scope of plan.reads) {
      if (await this.suppressions.isSuppressed(scope, addressHash)) throw new EmailSuppressedError(scope);
    }
    const key = typeof this.key === 'function' ? this.key() : this.key;
    const token = await this.tokens.issue(addressHash, plan.tokenScope, nonce ?? randomUUID(), key);
    const url = `${this.pageUrl}?t=${token}`;
    return {
      url,
      headers: {
        'List-Unsubscribe': this.mailto === undefined ? `<${url}>` : `<${url}>, <mailto:${this.mailto}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    };
  }

  /**
   * The text part with its link: where it holds `UNSUBSCRIBE_URL_MARKER`, the link written in place of each, and the
   * postal address after a blank line when commercial mail does not hold it already; otherwise a blank line, the link's
   * words and the link, and the postal address on the next line when one is configured.
   *
   * @param body The text part as given.
   * @param url The send's link.
   * @param commercial Whether the mail is commercial.
   */
  text(body: string, url: string, commercial: boolean): string {
    if (body.includes(UNSUBSCRIBE_URL_MARKER)) {
      const written = body.split(UNSUBSCRIBE_URL_MARKER).join(url);
      const postal = this.postalAddress;
      return commercial && postal !== undefined && !written.includes(postal) ? `${written}${breakAfter(written)}${postal}\n` : written;
    }
    const lines = [`${this.linkText}: ${url}`];
    if (this.postalAddress !== undefined) lines.push(this.postalAddress);
    return `${body}${breakAfter(body)}${lines.join('\n')}\n`;
  }

  /**
   * The HTML part with its link: where it holds `UNSUBSCRIBE_URL_MARKER`, the link written in place of each, and a
   * paragraph with the postal address before `</body>` when commercial mail does not hold it already; otherwise a
   * paragraph in 13-pixel text before `</body>`, or at the end when the part has none, with the link and the postal
   * address under it when one is configured.
   *
   * @param html The HTML part as given.
   * @param url The send's link.
   * @param commercial Whether the mail is commercial.
   */
  html(html: string, url: string, commercial: boolean): string {
    const postal = this.postalAddress === undefined ? undefined : escapeHtml(this.postalAddress);
    if (html.includes(UNSUBSCRIBE_URL_MARKER)) {
      const written = html.split(UNSUBSCRIBE_URL_MARKER).join(escapeHtml(url));
      return commercial && postal !== undefined && !written.includes(postal) ? atFoot(written, `<p style="${FOOT}">${postal}</p>`) : written;
    }
    const link = `<a href="${escapeHtml(url)}" style="${FOOT_LINK}">${escapeHtml(this.linkText)}</a>`;
    return atFoot(html, `<p style="${FOOT}">${link}${postal === undefined ? '' : `<br>${postal}`}</p>`);
  }
}
