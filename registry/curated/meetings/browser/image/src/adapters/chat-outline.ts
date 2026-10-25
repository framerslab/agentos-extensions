import type { Frame, Page } from 'playwright';

/**
 * What a failed step of posting a message leaves in the run's report beside its code: an outline of the chat panel, so
 * the next failure explains itself. For each frame of the page, the main frame first and then the frames the panel
 * embeds (a Google Chat conversation's frame on chat.google.com), the outline holds the frame's host and its counts of
 * interactive controls by role (textbox, combobox, button, menuitem), of editables, of list items and of elements that
 * carry a message id, and the accessible names of the composer-shaped controls (textboxes, comboboxes and editables in
 * every frame; buttons in the embedded frames alone, since the main frame's tiles and lists carry the participants'
 * names on theirs; a menu item is counted and never named, since no lookup targets one and a menu may list people),
 * capped in length and count. It never holds a message's text, a participant's name or address, or a link: a control
 * inside a message element names nothing; a name is tested whole, before any cut, and is dropped when it holds the
 * whole of a tile's, a sender's or a message's text, when such a text holds the whole of it, when it shares a run of
 * three words with one, or when it holds a word of a participant's name, however the name spells them, each text
 * compared whole; a name that holds anything shaped like an address or a link (an `@` address, a scheme, a
 * protocol-relative `//`, a bare host such as `docs.example.com` with or without a path after it, an IPv4 address) is
 * dropped whole, never cleaned and kept; every kept name is cut to letters, digits and a few marks; the names are
 * withheld altogether when any frame went unread or any frame's reading stopped at its element limit, since the texts
 * they must not quote may then be unread; and a frame is named by its host alone. Everything in it fits the nightly
 * check's record line: letters, digits, space and `_.,:;=|()-`.
 */

/** As much of a DOM element as the outline reads: the same members on a fake tree in the tests and on the page's elements in the frame. */
export interface ElementLike {
  tagName: string;
  children: ArrayLike<ElementLike>;
  parentElement: ElementLike | null;
  textContent: string | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getClientRects(): ArrayLike<unknown>;
  ownerDocument?: { getElementById(id: string): ElementLike | null } | null;
}

/** The roles the outline counts. */
export type OutlineRole = 'textbox' | 'combobox' | 'button' | 'menuitem';

/** One frame's reading, as {@link collectFrameOutline} returns it from inside the frame. */
export interface FrameScan {
  /** How many drawn controls of each role the frame holds, and how many drawn editables, list items and elements carrying a message id. */
  counts: Record<OutlineRole | 'editable' | 'listitem' | 'messageid', number>;
  /** The accessible names of the controls the outline may name, in document order and whole, before the address test, the roster filter and the cut. */
  names: string[];
  /** The texts a name must not quote, whole: the tiles' names, the senders' names and the messages' texts. They are used to drop names and never leave the bot. */
  roster: string[];
  /** The participants' names among the roster: the tiles' and the senders'. A name quoting one of their words is dropped too. They never leave the bot. */
  people: string[];
  /** True when the walk stopped at its element limit. */
  truncated: boolean;
}

/** What {@link collectFrameOutline} is given: how much to read, and in a test the fake root to read instead of the frame's document. */
export interface OutlineLimits {
  /** Whether buttons are named: true in an embedded frame, whose controls are the chat's own. A menu item is never named. */
  buttonNames: boolean;
  /** How many names one frame reads, before the roster filter and the cut to the names it may give. */
  maxRawNames: number;
  /** How many elements the walk reads before it stops. */
  maxElements: number;
  /** The tree to read, in a test; the frame's `document.body` when absent. */
  root?: ElementLike;
}

/**
 * Reads one frame's outline. It runs inside the frame through Playwright's `evaluate`, so it refers to nothing outside
 * itself: Playwright sends its source to the page and calls it with `limits`.
 *
 * @param limits - How much to read, and in a test the tree to read.
 */
export function collectFrameOutline(limits: OutlineLimits): FrameScan {
  const root = limits.root ?? (globalThis as unknown as { document?: { body?: ElementLike | null } }).document?.body ?? undefined;
  const counts: FrameScan['counts'] = { textbox: 0, combobox: 0, button: 0, menuitem: 0, editable: 0, listitem: 0, messageid: 0 };
  const names: string[] = [];
  const roster: string[] = [];
  const people: string[] = [];
  if (!root) return { counts, names, roster, people, truncated: false };
  const text = (el: ElementLike | null | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const roleOf = (el: ElementLike): string | undefined => {
    const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0];
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
      if (type === 'text' || type === 'search' || type === 'email' || type === 'url' || type === 'tel' || type === 'password') return 'textbox';
    }
    return undefined;
  };
  const editable = (el: ElementLike): boolean => {
    const value = el.getAttribute('contenteditable');
    return value !== null && value.toLowerCase() !== 'false';
  };
  const drawn = (el: ElementLike): boolean => {
    try {
      return el.getClientRects().length > 0;
    } catch {
      return true;
    }
  };
  // a control inside a message (the Pin key beside it, a reaction's key) names nothing: its name may quote the message
  const insideMessage = (el: ElementLike): boolean => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (parent.hasAttribute('data-message-id') || parent.hasAttribute('data-sender-name') || parent.hasAttribute('data-message-text')) return true;
      if ((parent.getAttribute('role') ?? '').toLowerCase() === 'listitem') return true;
    }
    return false;
  };
  const nameOf = (el: ElementLike, role: string | undefined): string => {
    let name = el.getAttribute('aria-label') ?? '';
    if (!name) {
      const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      const doc = el.ownerDocument;
      if (doc && ids.length) name = ids.map((id) => text(doc.getElementById(id))).filter(Boolean).join(' ');
    }
    if (!name) name = el.getAttribute('title') ?? '';
    if (!name && role === 'button') name = text(el);
    if (!name && role !== 'button') name = el.getAttribute('placeholder') ?? '';
    return name.replace(/\s+/g, ' ').trim();
  };
  const stack: ElementLike[] = [root];
  let seen = 0;
  let truncated = false;
  while (stack.length) {
    const el = stack.pop() as ElementLike;
    seen += 1;
    if (seen > limits.maxElements) {
      truncated = true;
      break;
    }
    // the tiles' names, the senders' names and the messages' texts: read whole, so that a name quoting any part of them
    // is dropped
    const self = el.getAttribute('data-self-name');
    if (self) {
      roster.push(self);
      people.push(self);
    }
    const sender = el.getAttribute('data-sender-name');
    if (sender) {
      roster.push(sender);
      people.push(sender);
    }
    if (el.hasAttribute('data-participant-id') || el.hasAttribute('data-self-name') || el.hasAttribute('data-sender-name')) {
      const own = text(el);
      if (own) {
        roster.push(own);
        people.push(own);
      }
    }
    // a message's text as the element shows it and as its attribute carries it
    if (el.hasAttribute('data-message-text')) {
      const own = text(el);
      if (own) roster.push(own);
      const carried = el.getAttribute('data-message-text');
      if (carried) roster.push(carried);
    }
    if (el.hasAttribute('data-message-id')) counts.messageid += 1;
    const role = roleOf(el);
    if (role === 'listitem') counts.listitem += 1;
    const isEditable = editable(el);
    if (drawn(el)) {
      if (isEditable) counts.editable += 1;
      if (role === 'textbox' || role === 'combobox' || role === 'button' || role === 'menuitem') counts[role] += 1;
      const named = role === 'textbox' || role === 'combobox' || isEditable || (role === 'button' && limits.buttonNames);
      // the name is kept whole: the address test and the roster filter read all of it, and the cut comes after them
      if (named && names.length < limits.maxRawNames && !insideMessage(el)) {
        const name = nameOf(el, role);
        if (name) names.push(name);
      }
    }
    for (let i = el.children.length - 1; i >= 0; i -= 1) stack.push(el.children[i]);
  }
  return { counts, names, roster, people, truncated };
}

/** How much of each frame the outline reads and keeps: the names a frame may give, the names it reads before the filter, a kept name's length, the elements a walk reads. */
export const OUTLINE_LIMITS = { maxNames: 12, maxRawNames: 60, maxNameLength: 40, maxElements: 30_000 };
/** How long the whole outline may take, over all the frames: a failed step's report is not held up by a frame that does not answer. */
export const OUTLINE_MS = 3_000;
/** How long the outline may be: well inside the protocol's ceiling on an error report's message, with the phase and the code before it. */
export const OUTLINE_MAX_LENGTH = 1_500;

/**
 * A name that holds anything shaped like an address or a link: an `@` address, a scheme (`https://`, `mailto:`, `tel:`:
 * a word of letters, digits, `+`, `-` and `.` before a colon that something follows), a protocol-relative `//`, a bare
 * host (two or more labels joined by dots, the last of them two or more letters: `docs.example.com`, `www.example.org`),
 * with or without a path after it, or an IPv4 address (`192.168.0.50`), with or without a port or a path. Such a name
 * is dropped whole, since the cut would only respell the host's and the path's words, and it is tested whole, before
 * any cut could hide the address past it.
 */
const ADDRESS_OR_LINK = /@|\/\/|[a-z][a-z0-9+.-]*:\S|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}|\d{1,3}(?:\.\d{1,3}){3}/iu;

/** How many consecutive words a name must share with a text to count as quoting it: two meet too much (`is on`, `to the`). */
const RUN_WORDS = 3;

const sleep = (ms: number): Promise<undefined> => new Promise((resolve) => setTimeout(() => resolve(undefined), ms));

/** Text as the roster filter compares it: spaces collapsed, case folded. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The words of a folded text: what is left between its spaces and the marks the outline keeps. */
const wordsOf = (folded: string): string[] => folded.split(/[\s_.,()-]+/).filter(Boolean);

/** Each run of `length` consecutive words of a folded text, joined by single spaces: the pieces a quote of the text shares with it. */
const runsOf = (folded: string, length = RUN_WORDS): string[] => {
  const words = wordsOf(folded);
  const runs: string[] = [];
  for (let i = 0; i + length <= words.length; i += 1) runs.push(words.slice(i, i + length).join(' '));
  return runs;
};

/** A text in the outline's alphabet, whole: letters, digits, space and `_.,()-` alone (the record line's alphabet, less the outline's own marks), spaces collapsed. */
const clean = (text: string): string =>
  text
    .replace(/[^\p{L}\p{N} _.,()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/** A name as the outline shows it: the whole name cleaned, then cut to its length. The address test and the roster filter never read a cut name. */
export function cleanName(name: string, maxLength = OUTLINE_LIMITS.maxNameLength): string {
  return clean(name).slice(0, maxLength).trim();
}

/**
 * The texts a name must not quote, as the filter compares them with a name: each entry whole, cleaned as a name is
 * cleaned and folded, so a spelling with marks (`O'Reilly`) still meets the name that quotes it (`Reply to OReilly`);
 * each run of three words of an entry, so a name that quotes a part of a message with words of its own around it
 * (`Replying to Al: the budget is in the shared folder`) meets the message; and each word of three or more characters
 * of a participant's name, so `Message Alice` meets the tile `Alice Smith`. Short entries are left out, since two
 * letters meet too much. The terms never leave the bot.
 *
 * @param roster - The tiles' names, the senders' names and the messages' texts.
 * @param people - The participants' names among them, whose words count too.
 */
export function rosterTerms(roster: readonly string[], people: readonly string[] = []): string[] {
  const terms = new Set<string>();
  for (const entry of roster) {
    const whole = fold(clean(entry));
    if (whole.length >= 3) terms.add(whole);
    for (const run of runsOf(whole)) terms.add(run);
  }
  for (const name of people) {
    const whole = fold(clean(name));
    if (whole.length >= 3) terms.add(whole);
    for (const word of wordsOf(whole)) if (word.length >= 3) terms.add(word);
  }
  return [...terms];
}

/** The frame's host, which names its origin without a path or a query: `about:blank` for an empty frame, `unparsable` for a url that is none. */
export function frameHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:') return `about:${parsed.pathname.replace(/[^a-z]/gi, '') || 'blank'}`;
    return parsed.hostname.toLowerCase() || 'unparsable';
  } catch {
    return 'unparsable';
  }
}

/**
 * One frame's line of the outline, from its scan: its counts, `partial` when its walk stopped at the element limit, and
 * the names that hold nothing shaped like an address or a link and quote no roster text (a name that holds a term, that
 * a text holds whole, or that shares a run of three words with a text is dropped, whatever the lengths), at most
 * `maxNames` after that filter; the test and the filter read the whole name, and the cut to its length comes after
 * them. The names are withheld (`names=withheld`) when the scan is partial or `namesAllowed` is false, which the
 * outline passes when any frame went unread or any frame's scan is partial: the texts the names must not quote may
 * then be unread.
 *
 * @param index - The frame's place in the outline, the main frame being 1.
 * @param host - The frame's host, from {@link frameHost}.
 * @param scan - The frame's reading, or undefined for a frame that gave none in time.
 * @param roster - The texts a name must not quote, from every frame; they are compared as {@link rosterTerms} prepares them.
 * @param namesAllowed - Whether any frame's names may be shown.
 * @param maxNames - How many names the frame may give.
 */
export function frameLine(index: number, host: string, scan: FrameScan | undefined, roster: readonly string[], namesAllowed = true, maxNames = OUTLINE_LIMITS.maxNames): string {
  if (!scan) return `f${index} ${host} unread`;
  const c = scan.counts;
  const terms = rosterTerms(roster);
  const termSet = new Set(terms);
  const names: string[] = [];
  if (namesAllowed && !scan.truncated) {
    for (const raw of scan.names) {
      if (names.length >= maxNames) break;
      // the whole name, before any cut: a cut could hide an address past it or leave the words of a path
      if (ADDRESS_OR_LINK.test(raw)) continue;
      const folded = fold(clean(raw));
      if (!folded) continue;
      // a name that holds a term (a tile's or a sender's name, a word of one, a message's text, a run of its words),
      // that appears inside a text (a part of a message's text), or whose own run of words is a text's (a quote with
      // words of the name's around it, or marks between them), is dropped, whatever the lengths
      if (terms.some((term) => folded.includes(term) || term.includes(folded)) || runsOf(folded).some((run) => termSet.has(run))) continue;
      const name = cleanName(raw);
      if (!name || names.includes(name)) continue;
      names.push(name);
    }
  }
  const counts = `textbox=${c.textbox} combobox=${c.combobox} button=${c.button} menuitem=${c.menuitem} editable=${c.editable} listitem=${c.listitem} messageid=${c.messageid}`;
  const withheld = names.length === 0 && scan.names.length > 0 && (!namesAllowed || scan.truncated);
  const shown = names.length ? ` names=${names.join('|')}` : withheld ? ' names=withheld' : '';
  return `f${index} ${host} ${counts}${scan.truncated ? ' partial' : ''}${shown}`;
}

/**
 * The chat panel's outline: `panel: frames=<n>; f1 <host> <counts> [names=...]; f2 ...; tried=<lookups>`. The main frame
 * is f1 and the frames the page embeds follow, in the page's order. The frames are read at once against one deadline,
 * and a frame that gives no reading within it is `unread`, holding up no other frame. The lookups are the ones the
 * failed step tried, named by the adapter.
 *
 * @param page - The page in the call.
 * @param tried - The lookups the failed step tried, as the adapter names them (for example `composer:role,textarea,editable`).
 * @param timeoutMs - How long the whole outline may take.
 */
export async function panelOutline(page: Page, tried: string, timeoutMs = OUTLINE_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const main = page.mainFrame();
  const frames: Frame[] = [main, ...page.frames().filter((frame) => frame !== main)];
  const scans: Array<{ host: string; scan: FrameScan | undefined }> = await Promise.all(
    frames.map(async (frame) => {
      const remaining = deadline - Date.now();
      const limits: OutlineLimits = { buttonNames: frame !== main, maxRawNames: OUTLINE_LIMITS.maxRawNames, maxElements: OUTLINE_LIMITS.maxElements };
      // a frame between documents, or one that never answers, is read as unread rather than holding the report up
      const scan = remaining > 0 ? await Promise.race([frame.evaluate(collectFrameOutline, limits).catch(() => undefined), sleep(remaining)]) : undefined;
      return { host: frameHost(frame.url()), scan };
    }),
  );
  // the texts a name must not quote are read from every frame and applied to every frame's names: a participant's name
  // on a tile in the main frame may be quoted by a control in the chat's frame
  const roster = rosterTerms(
    scans.flatMap(({ scan }) => scan?.roster ?? []),
    scans.flatMap(({ scan }) => scan?.people ?? []),
  );
  // the names are withheld when any frame went unread (the main frame holds the tiles, and an unread frame may be the
  // chat's, with its senders and messages) or any frame's walk stopped at its element limit: the texts the names must
  // not quote may then be unread
  const namesAllowed = scans.every(({ scan }) => scan !== undefined && !scan.truncated);
  const lines = scans.map(({ host, scan }, i) => frameLine(i + 1, host, scan, roster, namesAllowed));
  return `panel: frames=${frames.length}; ${lines.join('; ')}; tried=${tried}`.slice(0, OUTLINE_MAX_LENGTH);
}

/** A failed step of posting a message: its code is the error's message, as {@link errorCode} reports it, and the panel's outline rides beside it. */
export class ChatStepError extends Error {
  constructor(code: string, readonly outline?: string) {
    super(code);
    this.name = 'ChatStepError';
  }
}

/** The outline a failed step carries, ready to follow its code in a report (`; panel: ...`), or nothing for an error that carries none. */
export function outlineOf(err: unknown): string {
  const outline = err instanceof Error ? (err as { outline?: unknown }).outline : undefined;
  return typeof outline === 'string' && outline ? `; ${outline}` : '';
}
