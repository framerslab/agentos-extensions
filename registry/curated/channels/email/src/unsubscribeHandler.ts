/**
 * @fileoverview The route an unsubscribe link opens, as one function from a web `Request` to a `Response`, so a host
 * mounts it on any server on Node.js that speaks them (a Next.js route handler on the Node.js runtime, Hono, a Node
 * server through an adapter). The route reads the request with web APIs alone; the package it ships in loads Node's
 * modules. A GET shows a page that asks and changes nothing, since link scanners follow links. A POST suppresses at
 * once: a mailbox provider's one-click POST (RFC 8058 section 3.1) and the page's buttons alike, the token in the
 * address the only thing it depends on. The route holds no transport, so an unsubscribe is never answered by a mail.
 */
import type { RecipientCapability } from './preferences/RecipientCapability.js';
import type { SuppressionStore } from './preferences/SuppressionStore.js';
import { ADDRESS_HASH, OPTIONAL_MAIL_SCOPE, categoryOfScope, escapeHtml, requireLine } from './unsubscribe.js';

/** What the route takes: the stores the service draws in and reads, and the page's words. */
export interface UnsubscribeHandlerOptions {
  /** The store the service's tokens were drawn in. */
  readonly tokens: RecipientCapability;
  /** The suppression record the service reads before each send. */
  readonly suppressions: SuppressionStore;
  /** The sender's name, shown above the page's heading. */
  readonly productName?: string;
  /** The words a page names each category by, such as `{ 'weekly-summary': 'weekly summary' }`; the category with its hyphens and underscores as spaces when not given. */
  readonly categoryNames?: Readonly<Record<string, string>>;
  /** Where a person deletes their account: an https address or a path, linked on the page of a required mail's link. */
  readonly deleteAccountUrl?: string;
  /** The clock the day of each suppression is read from, in epoch milliseconds: `Date.now` unless given. */
  readonly now?: () => number;
  /** Writes the page in place of the route's own, given what the token found and what was done. */
  readonly render?: (view: UnsubscribeView) => string;
}

/**
 * What a page shows. `category` is the category the link stops, or `null` for a required mail's link, which turns off
 * every optional mail. `ask` carries the token, so a page of the host's own can post it back.
 */
export type UnsubscribeView =
  | { readonly state: 'ask'; readonly category: string | null; readonly token: string }
  | { readonly state: 'done'; readonly category: string | null; readonly all: boolean }
  | { readonly state: 'invalid' };

/** What a token names, when it is an unsubscribe link's. */
interface Found {
  readonly addressHash: string;
  readonly scope: string;
  readonly category: string | null;
}

/** The most bytes of a form the route reads; a longer body counts as a one-click POST. */
const MOST_FORM_BYTES = 4096;

/** Every answer: kept by no cache, sending no referrer, as the address carries the token, and kept out of search. */
const PRIVATE: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex',
};

/** A page's answer: HTML that loads nothing, runs nothing and posts only to its own origin. */
const PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...PRIVATE,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

/** The page's style: phone first, 16-pixel text, 44-pixel buttons, light and dark. */
const STYLE = [
  ':root{color-scheme:light dark}',
  'body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}',
  'main{max-width:32rem;margin:0 auto;padding:32px 16px}',
  '.from{margin:0 0 8px;font-size:14px}',
  'h1{font-size:22px;line-height:1.3;margin:0 0 16px}',
  'p{margin:0 0 16px}',
  'form{margin:0 0 12px}',
  'button{font:inherit;width:100%;min-height:44px;padding:10px 16px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer}',
  'button.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}',
  '.note{font-size:14px}',
].join('');

/** What still comes once optional mail is off, said on every page that turns mail off. */
const STILL_COMES =
  'Mail that is part of your account still comes when it is due: sign-in codes you ask for, receipts when you pay, and security and legal notices.';

/** A link on the page, checked: an https address or a path that starts with one slash. */
function requireLink(value: unknown): string {
  if (typeof value === 'string' && !/[\s"'<>]/.test(value)) {
    if (value.startsWith('/') && !value.startsWith('//')) return value;
    try {
      if (new URL(value).protocol === 'https:') return value;
    } catch {
      // Refused below.
    }
  }
  throw new TypeError('The deleteAccountUrl was refused: give an https address or a path that starts with one slash');
}

/** The day of an epoch reading in UTC, `YYYY-MM-DD`. */
function dayOf(reading: number): string {
  return new Date(reading).toISOString().slice(0, 10);
}

/** The token an address carries in `t`, or the empty string. */
function tokenOf(request: Request): string {
  try {
    return new URL(request.url).searchParams.get('t') ?? '';
  } catch {
    return '';
  }
}

/**
 * What a token names when it is an unsubscribe link's: an address's hash with `OPTIONAL_MAIL_SCOPE` or a category's
 * list. A token of any other scope, such as one a host drew for a purpose of its own in the same store, finds nothing,
 * so a link can only ever stop mail.
 */
async function found(tokens: RecipientCapability, token: string): Promise<Found | null> {
  if (token === '') return null;
  const grant = await tokens.find(token);
  if (grant === null || !ADDRESS_HASH.test(grant.recipient)) return null;
  if (grant.scope === OPTIONAL_MAIL_SCOPE) return { addressHash: grant.recipient, scope: grant.scope, category: null };
  const category = categoryOfScope(grant.scope);
  return category === null ? null : { addressHash: grant.recipient, scope: grant.scope, category };
}

/**
 * The page's choice from a form the route can read: `all` for every optional mail, `this` for the link's own list, and
 * `null` for a one-click POST or any body that is no form, longer than 4,096 bytes or names no choice.
 */
async function choiceOf(request: Request): Promise<'this' | 'all' | null> {
  const type = request.headers.get('content-type') ?? '';
  if (!/^application\/x-www-form-urlencoded\b/i.test(type) || request.body === null) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let form = '';
  let bytes = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk: Uint8Array = next.value;
    bytes += chunk.byteLength;
    if (bytes > MOST_FORM_BYTES) {
      await reader.cancel();
      return null;
    }
    form += decoder.decode(chunk, { stream: true });
  }
  form += decoder.decode();
  const choice = new URLSearchParams(form).get('choice');
  if (choice === null) return null;
  return choice === 'all' ? 'all' : 'this';
}

/**
 * The route an unsubscribe link opens, as a function from a `Request` to a `Response`, mounted at the path of the
 * service's `pageUrl`:
 *
 * - GET and HEAD show a page that asks and change nothing: for a category's link, a button that stops the category and
 *   one that turns off every optional mail; for a required mail's link, one button that turns off every optional mail,
 *   what still comes and why, and a link to delete the account when `deleteAccountUrl` is given. A token that finds
 *   nothing answers 404 with a page that says so.
 * - POST suppresses at once, with the reason `manual` on the day `now` reads: a one-click POST, or any POST that names
 *   no choice, writes the link's own list and answers a blank 200, never a redirect (RFC 8058 section 3.2); the page's
 *   buttons post `choice=this` or `choice=all` and get the page that says what was done. A required mail's link always
 *   writes `OPTIONAL_MAIL_SCOPE`. A token that finds nothing writes nothing and gets the same blank 200, or the 404
 *   page from a button.
 * - Any other method answers 405.
 *
 * Every answer is kept by no cache and sends no referrer. Nothing is mailed, so no unsubscribe is ever confirmed by a
 * mail. An error of a store passes through as it was thrown, so the server answers 500 and a mailbox provider tries
 * again.
 *
 * @param options The stores and the page's words; each is checked here, and a `TypeError` names the first one at fault.
 */
export function createUnsubscribeHandler(options: UnsubscribeHandlerOptions): (request: Request) => Promise<Response> {
  if (typeof options !== 'object' || options === null) throw new TypeError('The unsubscribe route options were refused: give them as an object');
  const { tokens, suppressions } = options;
  if (typeof tokens?.find !== 'function') throw new TypeError('The unsubscribe route tokens were refused: give a store with find');
  if (typeof suppressions?.suppress !== 'function') throw new TypeError('The unsubscribe route suppressions were refused: give a store with suppress');
  const productName = options.productName === undefined ? undefined : requireLine('product name', options.productName, 120);
  // A map, so a category no name is given for, such as `constructor`, finds no name an object inherits.
  const names = new Map<string, string>();
  for (const [category, name] of Object.entries(options.categoryNames ?? {})) names.set(category, requireLine('category name', name, 120));
  const deleteAccountUrl = options.deleteAccountUrl === undefined ? undefined : requireLink(options.deleteAccountUrl);
  const now = options.now ?? Date.now;
  if (typeof now !== 'function') throw new TypeError('The unsubscribe route clock was refused: give a function or leave it out');
  const render = options.render;
  if (render !== undefined && typeof render !== 'function') throw new TypeError('The unsubscribe route render was refused: give a function or leave it out');

  /** The words a page names a category by. */
  const nameOf = (category: string): string => names.get(category) ?? category.replace(/[-_]+/g, ' ');

  /** The route's own page for a view. */
  const pageOf = (view: UnsubscribeView): string => {
    const parts: string[] = [];
    let title: string;
    if (view.state === 'invalid') {
      title = 'This link does not work';
      parts.push(`<h1>${title}</h1>`, '<p>Use the unsubscribe link at the foot of a newer mail.</p>');
    } else if (view.state === 'done') {
      title = 'You are unsubscribed';
      const what = view.all || view.category === null ? 'Every optional mail to this address is off.' : `No more ${escapeHtml(nameOf(view.category))} mail goes to this address.`;
      parts.push(`<h1>${title}</h1>`, `<p>${what}</p>`, `<p class="note">${escapeHtml(STILL_COMES)}</p>`);
    } else {
      const action = `?t=${escapeHtml(view.token)}`;
      const button = (choice: 'this' | 'all', words: string, primary: boolean): string =>
        `<form method="post" action="${action}"><input type="hidden" name="choice" value="${choice}"><button type="submit"${primary ? ' class="primary"' : ''}>${escapeHtml(words)}</button></form>`;
      if (view.category === null) {
        title = 'Turn off optional mail';
        parts.push(
          `<h1>${title}</h1>`,
          `<p>${escapeHtml(STILL_COMES)}</p>`,
          '<p>Turn off every optional mail to this address?</p>',
          button('all', 'Turn off all optional mail', true),
        );
        if (deleteAccountUrl !== undefined) {
          parts.push(`<p class="note">To stop that mail too, <a href="${escapeHtml(deleteAccountUrl)}">delete your account</a>.</p>`);
        }
      } else {
        title = 'Unsubscribe';
        const name = escapeHtml(nameOf(view.category));
        parts.push(
          `<h1>${title}</h1>`,
          `<p>Stop ${name} mail to this address?</p>`,
          button('this', `Unsubscribe from ${nameOf(view.category)} mail`, true),
          button('all', 'Unsubscribe from all optional mail', false),
          `<p class="note">${escapeHtml(STILL_COMES)}</p>`,
        );
      }
    }
    const from = productName === undefined ? '' : `<p class="from">${escapeHtml(productName)}</p>`;
    return [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<meta name="robots" content="noindex">',
      `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>`,
      `<body><main>${from}${parts.join('')}</main></body></html>`,
    ].join('');
  };

  /** A page's answer, its body left out for HEAD. */
  const page = (view: UnsubscribeView, status: number, head: boolean): Response =>
    new Response(head ? null : render === undefined ? pageOf(view) : render(view), { status, headers: PAGE_HEADERS });

  /** The blank answer a one-click POST gets. */
  const blank = (): Response => new Response(null, { status: 200, headers: PRIVATE });

  return async (request: Request): Promise<Response> => {
    const method = request.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return new Response(null, { status: 405, headers: { ...PRIVATE, Allow: 'GET, HEAD, POST' } });
    }
    const token = tokenOf(request);
    const link = await found(tokens, token);
    if (method !== 'POST') {
      return link === null
        ? page({ state: 'invalid' }, 404, method === 'HEAD')
        : page({ state: 'ask', category: link.category, token }, 200, method === 'HEAD');
    }
    const choice = await choiceOf(request);
    if (link === null) return choice === null ? blank() : page({ state: 'invalid' }, 404, false);
    const day = dayOf(now());
    await suppressions.suppress(link.scope, link.addressHash, 'manual', day);
    const all = link.category === null || choice === 'all';
    if (all && link.scope !== OPTIONAL_MAIL_SCOPE) await suppressions.suppress(OPTIONAL_MAIL_SCOPE, link.addressHash, 'manual', day);
    return choice === null ? blank() : page({ state: 'done', category: link.category, all }, 200, false);
  };
}
