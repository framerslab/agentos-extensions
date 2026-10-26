import type { Frame, Page } from 'playwright';

/**
 * What a failed step of posting a message leaves in the run's report beside its code: an outline of the chat panel, so
 * the next failure explains itself. For each frame of the page, the main frame first and then the frames the panel
 * embeds (a Google Chat conversation's frame on chat.google.com), the outline holds the frame's host and its counts of
 * interactive controls by role (textbox, combobox, button, menuitem), of editables, of list items and of elements that
 * carry a message id, and the accessible names of the composer-shaped controls (textboxes, comboboxes and editables in
 * every frame; buttons in the embedded frames alone, since the main frame's tiles and lists carry the participants'
 * names on theirs; a menu item is counted and never named, since no lookup targets one and a menu may list people),
 * capped in length and count. It never holds an address or a link, nor a message's text or a participant's name that
 * the frames draw: a control inside a message element names nothing; a name is tested whole, before any cut, and is
 * dropped when it holds the whole of a tile's, a sender's or a message's text (a message's text read from the element
 * marked as its text, from the element carrying its id, which is all a Google Chat conversation marks, from an item of
 * a list, and from each element of the message that holds no other, so its sender's name and each of its lines count on
 * their own), when such a text holds the whole of it, when it shares a run of three words with one, or when it holds a
 * word of a participant's name, however the name spells them, each text compared whole, read both as the page gives it
 * and with each element in it a word apart (a sender's name beside a message's first line, two lines split by a line
 * break, a tile's name beside an icon's word), with a mark between two words read both as nothing and as a space
 * (`alpha/beta`), and a text or a word of fewer than three characters matched only as a word of the name, except in a
 * script whose words run together (Chinese, Japanese, Korean, Thai, Lao, Khmer, Burmese), where it is matched anywhere
 * in the name and each letter counts as a word of a run; a name longer than two hundred characters is dropped without
 * its comparison; a name that holds anything shaped like an address or a link (an `@` address, a scheme, a
 * protocol-relative `//`, a bare host such as `docs.example.com` with or without a path after it, an IPv4 or an IPv6
 * address), read as written, as a browser reads a host (full-width forms folded, a zero-width space or a soft hyphen
 * dropped, ideographic full stops read as dots) or as it would be shown, is dropped whole, never cleaned and kept;
 * every kept name is cut to letters, digits and a few marks; the names are withheld altogether when any frame went
 * unread or any frame's reading stopped at its element limit, since the texts they must not quote may then be unread,
 * and when those texts come to more than twenty thousand terms, which bounds the filter's work; and a frame is named by
 * its host alone. A text the frames do not draw as a message, a sender or a tile (a message outside the part of a long
 * conversation the panel shows, a participant with no tile) is unknown to the filter. Everything in it fits the nightly
 * check's record line: letters, digits, space and `_.,:;=|()-`.
 */

/** As much of a DOM node as the outline reads of an element's child nodes: its type (1 an element, 3 text, 4 a CDATA section) and its text. */
export interface NodeLike {
  nodeType: number;
  textContent: string | null;
}

/** As much of a DOM element as the outline reads: the same members on a fake tree in the tests and on the page's elements in the frame. */
export interface ElementLike {
  tagName: string;
  children: ArrayLike<ElementLike>;
  /** The element's child nodes in their order, its texts among them, which a page's element gives: read to set each element in a text apart. A tree that gives none is read by `textContent` alone. */
  childNodes?: ArrayLike<NodeLike>;
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
  /** The texts a name must not quote, whole: the tiles' names, the senders' names and the messages' texts, each message whole (as textContent gives it and with each element in it a word apart) and by each element of it that holds no other. They are used to drop names and never leave the bot. */
  roster: string[];
  /** The participants' names among the roster: the tiles' and the senders', each the value of the attribute that names it when its element carries one and the element's text otherwise, read both ways. A name quoting one of their words is dropped too. They never leave the bot. */
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
  // an element's text with each element in it read as a word apart, a space at each of their edges: textContent joins
  // one element's text to the next with nothing between them, a sender's name to a message's first line
  // (`Samthe budget`), a line to the next across a line break (`foldersee`), a tile's name to the word an icon font
  // draws an icon from (`Smithmic_off`); an element that gives no child nodes is read by its text alone
  const edge: NodeLike = { nodeType: 0, textContent: ' ' };
  const spaced = (el: ElementLike): string => {
    const parts: string[] = [];
    const stack: NodeLike[] = [];
    const open = (node: ElementLike): void => {
      const nodes = node.childNodes;
      if (!nodes) {
        parts.push(' ', node.textContent ?? '', ' ');
        return;
      }
      for (let i = nodes.length - 1; i >= 0; i -= 1) stack.push(nodes[i]);
    };
    open(el);
    while (stack.length) {
      const node = stack.pop() as NodeLike;
      if (node === edge) parts.push(' ');
      else if (node.nodeType === 1) {
        parts.push(' ');
        stack.push(edge);
        open(node as unknown as ElementLike);
      } else if (node.nodeType === 3 || node.nodeType === 4) parts.push(node.textContent ?? '');
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  };
  // an element's text, whole, both as textContent gives it and with each element in it a word apart
  const textsOf = (el: ElementLike): string[] => {
    const own = text(el);
    if (!own) return [];
    const apart = spaced(el);
    return apart && apart !== own ? [own, apart] : [own];
  };
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
  // the element of a message, or of a line of one: its id, its sender's name, its text, or an item of a list, its role
  // read by its first word as the counts read it
  const marksMessage = (el: ElementLike): boolean =>
    el.hasAttribute('data-message-id') || el.hasAttribute('data-sender-name') || el.hasAttribute('data-message-text') || roleOf(el) === 'listitem';
  // a control inside a message (the Pin key beside it, a reaction's key) names nothing: its name may quote the message
  const insideMessage = (el: ElementLike): boolean => {
    for (let parent = el.parentElement; parent; parent = parent.parentElement) if (marksMessage(parent)) return true;
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
      for (const own of textsOf(el)) {
        roster.push(own);
        // a participant's name is the attribute's value when the element carries one: the element of a message drawn
        // with its sender's name on it (`div[jsname][data-sender-name]`) holds the whole message, whose words are no
        // participant's; a tile's whole text otherwise, each element in it a word apart too
        if (!self && !sender) people.push(own);
      }
    }
    // a message's text as the element shows it and as its attribute carries it
    if (el.hasAttribute('data-message-text')) {
      roster.push(...textsOf(el));
      const carried = el.getAttribute('data-message-text');
      if (carried) roster.push(carried);
    }
    const role = roleOf(el);
    if (el.hasAttribute('data-message-id')) {
      counts.messageid += 1;
      // a message drawn with no element marked as its text, as a Google Chat conversation draws one (the chat observer
      // then reads the whole element): the element's whole text; the Pin key beside a message carries its id and is no
      // message
      if (role !== 'button') roster.push(...textsOf(el));
    } else if (role === 'listitem') {
      // an item of a list is a message too, whose controls name nothing: its whole text, since a line of it that holds
      // another element (a link, a bold word) is no element that holds no other
      roster.push(...textsOf(el));
    }
    // each element of a message that holds no other (its sender's name, a line of its text): its text on its own, so a
    // name that holds one whole line, or a line of one or two characters as a word, is dropped
    if (el.children.length === 0 && (marksMessage(el) || insideMessage(el))) {
      const own = text(el);
      if (own) roster.push(own);
    }
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

/**
 * How much of each frame the outline reads and keeps: the names a frame may give, the names it reads before the filter,
 * a kept name's length, the elements a walk reads, the length past which a name is dropped without its comparison (no
 * control's label runs that long, and a long quote does), and the terms past which the names are withheld: the filter
 * compares every name with every term, and these two bound its work, so a long conversation never holds the report up.
 */
export const OUTLINE_LIMITS = { maxNames: 12, maxRawNames: 60, maxNameLength: 40, maxElements: 30_000, maxRawNameLength: 200, maxTerms: 20_000 };
/** How long the frames' reading may take, over all the frames: a failed step's report is not held up by a frame that does not answer. */
export const OUTLINE_MS = 3_000;
/** How long the outline may be: well inside the protocol's ceiling on an error report's message, with the phase and the code before it. */
export const OUTLINE_MAX_LENGTH = 1_500;

/**
 * A name that holds anything shaped like an address or a link: an `@` address, a scheme (`https://`, `mailto:`, `tel:`:
 * a word of letters, digits, `+`, `-` and `.` before a colon that something follows), a protocol-relative `//`, a bare
 * host (two or more labels joined by dots, the last of them two or more letters: `docs.example.com`, `www.example.org`),
 * with or without a path after it, an IPv4 address (`192.168.0.50`), with or without a port or a path, or an IPv6
 * address: compressed (`2001:4860:4860::8888`, `::1`), whole (eight groups), or bracketed as a link writes it
 * (`[2001:db8::1]`). Such a name is dropped whole, since the cut would only respell the host's and the path's words,
 * and it is tested whole, before any cut could hide the address past it, in each of the forms {@link linkShaped} reads.
 */
const ADDRESS_OR_LINK =
  /@|\/\/|[a-z][a-z0-9+.-]*:\S|(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}|\d{1,3}(?:\.\d{1,3}){3}|::|(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|\[[0-9a-f.]*:[0-9a-f:.]*\]/iu;

/** The full stops a browser reads as the dot between a host's labels (UTS #46): the ideographic, the full-width and the half-width ideographic one. */
const LABEL_DOTS = /[\u3002\uff0e\uff61]/gu;

/** How many consecutive words a name must share with a text to count as quoting it: two meet too much (`is on`, `to the`). */
const RUN_WORDS = 3;

/** A term shorter than this is matched as a word of a name and never inside one, two letters meeting too much inside other words (`li` in `Delivery`), unless it is written in a script of {@link UNSPACED}. */
const SHORT_TERM = 3;

/**
 * A letter of the scripts whose words run together, with no space between a word and the next or the particle after it
 * (Chinese, Japanese, Korean, Thai, Lao, Khmer, Burmese): a name in them runs into the words around it (`回复王伟`,
 * `田中さんに返信`), so a short text in them is matched anywhere in a name, and each of their letters counts as a word of
 * a run.
 */
const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]/u;

/** A word of a run: a letter of {@link UNSPACED} alone, or a stretch of other characters whole. */
const RUN_WORD =
  /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]|[^\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Thai}\p{scx=Lao}\p{scx=Khmer}\p{scx=Myanmar}]+/gu;

const sleep = (ms: number): Promise<undefined> => new Promise((resolve) => setTimeout(() => resolve(undefined), ms));

/** Text as the roster filter compares it: spaces collapsed, case folded. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** The words of a folded text: what is left between its spaces and the marks the outline keeps. */
const wordsOf = (folded: string): string[] => folded.split(/[\s_.,()-]+/).filter(Boolean);

/** The words a run is made of: a folded text's words ({@link wordsOf}), each letter of {@link UNSPACED} in them a word of its own. */
const runWordsOf = (folded: string): string[] => wordsOf(folded).flatMap((word) => word.match(RUN_WORD) ?? []);

/** Each run of `length` consecutive words of a folded text ({@link runWordsOf}), joined by single spaces: the pieces a quote of the text shares with it. */
const runsOf = (folded: string, length = RUN_WORDS): string[] => {
  const words = runWordsOf(folded);
  const runs: string[] = [];
  for (let i = 0; i + length <= words.length; i += 1) runs.push(words.slice(i, i + length).join(' '));
  return runs;
};

/** The characters a name loses when it is cleaned: all but letters, digits, space and `_.,()-` (the record line's alphabet, less the outline's own marks). */
const DROPPED = /[^\p{L}\p{N} _.,()-]/gu;

/**
 * A text in the outline's alphabet, whole: its compatibility forms folded (NFKC: a full-width letter as its letter, an
 * accent written as a combining mark as the accented letter), then the characters it loses ({@link DROPPED}) dropped,
 * spaces collapsed.
 */
const clean = (text: string): string => text.normalize('NFKC').replace(DROPPED, '').replace(/\s+/g, ' ').trim();

/**
 * The forms a text is compared in, case folded: cleaned, the marks it loses joined out (`O'Reilly` as `oreilly`), and
 * with each such mark read as a space (`alpha/beta` as `alpha beta`, `budget:approved` as `budget approved`), so a quote
 * meets its text whichever of the two writes a mark between the words. The second form is left out when it is the first.
 */
const formsOf = (text: string): string[] => {
  const normal = text.normalize('NFKC');
  const joined = fold(normal.replace(DROPPED, ''));
  const spaced = fold(normal.replace(DROPPED, ' '));
  return spaced === joined ? [joined] : [joined, spaced];
};

/** A name as the outline shows it: the whole name cleaned, then cut to its length. The address test and the roster filter never read a cut name. */
export function cleanName(name: string, maxLength = OUTLINE_LIMITS.maxNameLength): string {
  return clean(name).slice(0, maxLength).trim();
}

/**
 * Whether a name holds anything shaped like an address or a link ({@link ADDRESS_OR_LINK}), read three ways: as written;
 * as a browser reads a host, with its compatibility forms folded (`＠` as `@`, `ｔｅｌ：` as `tel:`), the invisible format
 * characters a page puts inside a long link dropped (a zero-width space, a soft hyphen) and the ideographic full stops
 * read as dots; and cleaned, as the outline would show it, so a mark the clean drops (a bracket around a dot) cannot
 * leave a host in what is shown.
 */
const linkShaped = (name: string): boolean =>
  ADDRESS_OR_LINK.test(name) ||
  ADDRESS_OR_LINK.test(name.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(LABEL_DOTS, '.')) ||
  ADDRESS_OR_LINK.test(clean(name));

/**
 * The texts a name must not quote, as the filter compares them with a name, in each of the forms {@link formsOf} makes:
 * each entry whole, cleaned as a name is cleaned and folded, so a spelling with marks (`O'Reilly`) still meets the name
 * that quotes it (`Reply to OReilly`), and a mark between two words (`alpha/beta`) meets the space a name puts there;
 * each run of three words of an entry ({@link runWordsOf}: in a script whose words run together, three letters in a
 * row), so a name that quotes a part of a message with words of its own around it (`Replying to Al: the budget is in
 * the shared folder`) meets the message; and each word of a participant's name, so `Message Alice` meets the tile
 * `Alice Smith`. A term of fewer than three characters (`Li` of `Li Na`, the name `王伟`) is kept too, and
 * {@link frameLine} matches it as a word of a name, never inside one, unless it is written in a script whose words run
 * together ({@link UNSPACED}), where it counts anywhere in the name. The terms never leave the bot.
 *
 * @param roster - The tiles' names, the senders' names and the messages' texts.
 * @param people - The participants' names among them, whose words count too.
 */
export function rosterTerms(roster: readonly string[], people: readonly string[] = []): string[] {
  const terms = new Set<string>();
  for (const entry of roster) {
    for (const form of formsOf(entry)) {
      if (form) terms.add(form);
      for (const run of runsOf(form)) terms.add(run);
    }
  }
  for (const name of people) {
    for (const form of formsOf(name)) {
      if (form) terms.add(form);
      for (const word of wordsOf(form)) terms.add(word);
    }
  }
  return [...terms];
}

/** The terms of each roster an outline passes to its frames' lines, made once and not once a frame. */
const termsOfRoster = new WeakMap<readonly string[], string[]>();

/**
 * Whether one folded form of a name quotes a term: it holds the term, the term holds it whole, or a run of three of its
 * words is a term; a term of fewer than three characters counts only as a word of the name (a letter of
 * {@link UNSPACED} setting a word apart, as in `回复Al`), unless the term is written in a script of {@link UNSPACED},
 * where it counts anywhere in the name.
 */
const quotesAny = (folded: string, terms: readonly string[], termSet: ReadonlySet<string>): boolean => {
  const words = new Set(runWordsOf(folded));
  const quotes = (term: string): boolean => (term.length < SHORT_TERM && !UNSPACED.test(term) ? words.has(term) : folded.includes(term) || term.includes(folded));
  return terms.some(quotes) || runsOf(folded).some((run) => termSet.has(run));
};

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
 * a text holds whole, or that shares a run of three words with a text is dropped, whatever the lengths, in either form
 * of {@link formsOf}; a term of fewer than three characters counts when it is a word of the name, or anywhere in it in
 * a script whose words run together), at most `maxNames` after that filter; the test and the filter read the whole
 * name, and the cut to its length comes after them. A name longer than {@link OUTLINE_LIMITS}' `maxRawNameLength` is
 * dropped without its comparison. The names are withheld (`names=withheld`) when the scan is partial, when the roster
 * comes to more terms than `maxTerms`, which bounds the filter's work, or when `namesAllowed` is false, which the
 * outline passes when any frame went unread or any frame's scan is partial: the texts the names must not quote may then
 * be unread.
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
  const terms = termsOfRoster.get(roster) ?? rosterTerms(roster);
  termsOfRoster.set(roster, terms);
  // past its limit the roster is never compared in part: the names are withheld
  const allowed = namesAllowed && !scan.truncated && terms.length <= OUTLINE_LIMITS.maxTerms;
  const termSet = new Set(terms);
  const names: string[] = [];
  if (allowed) {
    for (const raw of scan.names) {
      if (names.length >= maxNames) break;
      // a name longer than any control's label is a quote at most: dropped without the comparison it would cost
      if (raw.length > OUTLINE_LIMITS.maxRawNameLength) continue;
      // the whole name, before any cut: a cut could hide an address past it or leave the words of a path
      if (linkShaped(raw)) continue;
      const forms = formsOf(raw);
      if (!forms[0]) continue;
      // a name that holds a term (a tile's or a sender's name, a word of one, a message's text, a run of its words),
      // that appears inside a text (a part of a message's text), or whose own run of words is a text's (a quote with
      // words of the name's around it), in either form, is dropped, whatever the lengths
      if (forms.some((folded) => quotesAny(folded, terms, termSet))) continue;
      const name = cleanName(raw);
      if (!name || names.includes(name)) continue;
      names.push(name);
    }
  }
  const counts = `textbox=${c.textbox} combobox=${c.combobox} button=${c.button} menuitem=${c.menuitem} editable=${c.editable} listitem=${c.listitem} messageid=${c.messageid}`;
  const withheld = names.length === 0 && scan.names.length > 0 && !allowed;
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
 * @param timeoutMs - How long the frames' reading may take.
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
