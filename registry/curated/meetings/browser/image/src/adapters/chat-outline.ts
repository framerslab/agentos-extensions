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
 * (`alpha/beta`), a modifier letter written as an apostrophe (`Alʼs`) read as the apostrophe is, and a text or a word
 * of fewer than three characters matched only as a word of the name, except in a script whose words run together
 * (Chinese, Japanese, Korean, Thai, Lao, Khmer, Burmese), where it is matched anywhere in the name and each letter also
 * counts as a word of a run; a name longer than two hundred characters is dropped without its comparison; a name that
 * holds anything shaped like an address or a link (an `@` address, a scheme, a protocol-relative `//`, a bare host such
 * as `docs.example.com` with or without a path after it, an IPv4 or an IPv6 address), read as written, with its
 * compatibility forms decomposed and every invisible or combining mark dropped (a format character such as a zero-width
 * space or a soft hyphen, a default-ignorable code point such as a combining grapheme joiner, a combining mark such as
 * a dot above: none sets a scheme's colon or a host's dot apart) and ideographic full stops as dots, or as it would
 * be shown, is dropped whole, never cleaned and kept; every kept name is cut to letters, digits and a few marks; the
 * names are withheld altogether when any frame went unread or any frame's reading stopped at its element limit, since
 * the texts they must not quote may then be unread, and when those texts come to more than twenty thousand terms, which
 * bounds the filter's work; and a frame is named by its host alone. A text the frames do not draw as a message,
 * a sender or a tile (a message outside the part of a long conversation the panel shows, a participant with no tile)
 * is unknown to the filter.
 *
 * Beside the counts, each frame's line carries what tells the adapter's lookups apart when none found a composer: the
 * toolbar's Chat key's state (`key=pressed:<v>,expanded:<v>`: the first drawn button named "Chat with everyone", the
 * adapter's own name for it, by its `aria-pressed` and `aria-expanded` values, each `true`, `false`, `mixed`, `other`,
 * or `none` when absent, the sign of an open panel where the client marks one), and up to four composer-shaped controls
 * (`cands=`: each textbox by role, textarea, text-like input or editable, the drawn ones first and `more:<n>` for the
 * rest), each by fixed facts alone: its tag and role, whether it is editable, disabled, read-only or aria-disabled (on
 * it or above it), drawn (it has a client rect), boxed (its box has a width and a height, which Playwright's visibility
 * read needs), its computed visibility, whether it or an element above it is aria-hidden (which Playwright's role lookup
 * skips), how it is named (`labelledby`, `aria`, `label`, `title`, `placeholder` or `none`), whether its name begins as
 * the lookups expect (`send` for "Send a message", `history` for "History is o", else `other`, or `none`), whether an
 * element above it is labelled for the chat (a label beginning with "chat" or "in-call messages") and the nearest
 * landmark above it, and which words of a fixed allow-list ({@link LABEL_WORDS}: the words Google's pages and the
 * clients' labels use for a chat that is stopped, a step a guest takes first, the composer's own wordings, an outside
 * guest, whether the chat is available, a restriction and who sets it, the meeting and its people, and a continuation
 * in Google Chat; no word names a person) its name holds (`words:<w1>-<w2>`, in the name's order, each once, a plural
 * read as its word and an apostrophe dropped, or `words:none`). A name is read to decide its kind, its start and its
 * words and never written. A frame that draws a side panel (an element that is a complementary landmark, an `aside` or
 * the role written on a div) also writes the panel's buttons (`pbtn=<drawn>,on:<enabled>`: the drawn buttons under any
 * such panel, whatever landmark lies between (a header, a form or a region of the panel's own), and how many of them
 * are enabled, with no `disabled` attribute and no `aria-disabled="true"` on them or above them) and, for each
 * allow-listed word a button's name holds, `<word>:<drawn>(<enabled>)` in the list's order; a button's name is read for
 * its words alone, and a button inside a message, or carrying a message's id (the Pin key beside one), counts for
 * nothing, as it names nothing. When the frames' lines would pass the outline's length, the frames are fitted to it:
 * every frame's counts, key and panel totals first, then each frame's first candidate, then the panels' tallies by word
 * in rounds, then each frame's other candidates in rounds and its names while they fit, no token cut, and the lookups
 * tried always at the end. Everything in it fits the nightly check's record line: letters, digits, space and
 * `_.,:;=|()-`.
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
  /** The element's box, which a page's element gives: Playwright's visibility read needs a width and a height. A tree that gives none is read as boxless. */
  getBoundingClientRect?(): { width: number; height: number };
  /** The label elements tied to the control (a `label` element's `for`, or one around it), which a page's input or textarea gives. */
  labels?: ArrayLike<NodeLike> | null;
  /** The element's document: its elements by id, and its window's computed styles, which a page's document gives; a tree that gives no window reads a candidate's visibility as `unknown`. */
  ownerDocument?: { getElementById(id: string): ElementLike | null; defaultView?: { getComputedStyle?(el: ElementLike): { visibility?: string } | null } | null } | null;
}

/** The roles the outline counts. */
export type OutlineRole = 'textbox' | 'combobox' | 'button' | 'menuitem';

/**
 * One composer-shaped control of a frame (a textbox by role, a textarea, a text-like input, or an editable), by the
 * fixed facts that tell the adapter's lookups apart when none found a composer. None of them is text: a name is read
 * to decide how the control is named and whether the name begins as the lookups expect, and is never kept.
 */
export interface CandidateScan {
  /** The element's tag, lower-case, cut to letters, digits and dashes. */
  tag: string;
  /** Its role as the counts read it (`textbox`, `combobox`, `button` or `menuitem`), `other` for any other role written on an editable, or `none`. */
  role: string;
  /** Whether it is editable by its contenteditable attribute. */
  editable: boolean;
  /** Whether it carries the `disabled` attribute. */
  disabled: boolean;
  /** Whether it carries the `readonly` attribute. */
  readOnly: boolean;
  /** Whether it, or an element above it, carries `aria-disabled="true"`. */
  ariaDisabled: boolean;
  /** Whether it is drawn: it has a client rect, which an element under `display: none` has not. */
  drawn: boolean;
  /** Whether its box has a width and a height, which Playwright's visibility read needs. */
  box: boolean;
  /** Its computed visibility (`visible`, `hidden`, `collapse`), or `unknown` where the frame gives no computed style. */
  visibility: string;
  /** Whether it, or an element above it, carries `aria-hidden="true"`, which Playwright's role lookup skips. */
  ariaHidden: boolean;
  /** How it is named, in the order a browser builds an accessible name: `labelledby`, `aria`, `label` (a label element), `title`, `placeholder`, or `none`. */
  named: string;
  /** Whether its name begins as the lookups expect: `send` ("Send a message"), `history` ("History is o"), `other` for another name, `none` for no name. */
  label: string;
  /** Whether an element above it is labelled for the chat: a label beginning with "chat" or "in-call messages". */
  chat: boolean;
  /** The nearest landmark above it (`complementary`, `region`, `dialog`, `alertdialog`, `main`, `navigation`, `form`, `banner`, `contentinfo`), or `none`. */
  landmark: string;
  /** The allow-listed words its name holds ({@link LABEL_WORDS}), in the name's order and each once; empty for a name that holds none, or no name. */
  words: string[];
}

/** The buttons inside the side panel a frame draws: how many are drawn, how many of them are enabled, and the same for each allow-listed word a button's name holds, in the list's order. */
export interface PanelButtonScan {
  drawn: number;
  enabled: number;
  words: Array<{ word: string; drawn: number; enabled: number }>;
}

/** The toolbar's Chat key as the frame draws it: the values of its `aria-pressed` and `aria-expanded` attributes, each `true`, `false`, `mixed`, `other`, or `none` when absent. */
export interface KeyScan {
  pressed: string;
  expanded: string;
}

/** One frame's reading, as {@link collectFrameOutline} returns it from inside the frame. */
export interface FrameScan {
  /** How many drawn controls of each role the frame holds, and how many drawn editables, list items and elements carrying a message id. */
  counts: Record<OutlineRole | 'editable' | 'listitem' | 'messageid', number>;
  /** The Chat key's state, when the frame draws one (a drawn button named "Chat with everyone"); absent in a scan written by hand. */
  key?: KeyScan;
  /** The composer-shaped controls, the drawn ones first, at most the limits' `maxCandidates`; absent in a scan written by hand. */
  candidates?: CandidateScan[];
  /** How many composer-shaped controls the frame holds beyond `candidates`. */
  moreCandidates?: number;
  /** The buttons inside the side panel, when the frame draws one (a complementary landmark with a client rect); absent otherwise, and in a scan written by hand. */
  panelButtons?: PanelButtonScan;
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
  /** How many composer-shaped controls the scan keeps, the drawn ones first; four when absent. */
  maxCandidates?: number;
  /** The allow-listed words a name is read for ({@link LABEL_WORDS}), given to the frame since the scan runs inside it. */
  labelWords: readonly string[];
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
  if (!root) return { counts, names, roster, people, truncated: false, candidates: [], moreCandidates: 0 };
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
    // an li element is an item of a list by its element, with no role written on it (its implicit role)
    if (tag === 'li') return 'listitem';
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
  // an element's name in the order a browser builds its accessible name, which the adapter's role lookups read: the
  // elements aria-labelledby names, then aria-label, then the title, then a button's text or a field's placeholder
  const nameOf = (el: ElementLike, role: string | undefined): string => {
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const doc = el.ownerDocument;
    let name = doc && ids.length ? ids.map((id) => text(doc.getElementById(id))).filter(Boolean).join(' ') : '';
    if (!name) name = el.getAttribute('aria-label') ?? '';
    if (!name) name = el.getAttribute('title') ?? '';
    if (!name && role === 'button') name = text(el);
    if (!name && role !== 'button') name = el.getAttribute('placeholder') ?? '';
    return name.replace(/\s+/g, ' ').trim();
  };
  const maxCandidates = limits.maxCandidates ?? 4;
  // the drawn and the undrawn composer-shaped controls, kept apart and each to the limit, so a drawn composer behind
  // any number of undrawn fields is listed
  const drawnFound: CandidateScan[] = [];
  const undrawnFound: CandidateScan[] = [];
  let candidateCount = 0;
  let key: KeyScan | undefined;
  // whether the element, or one above it, carries the attribute as true
  const ariaTrue = (el: ElementLike, attribute: string): boolean => {
    for (let node: ElementLike | null = el; node; node = node.parentElement) if ((node.getAttribute(attribute) ?? '').trim().toLowerCase() === 'true') return true;
    return false;
  };
  // an aria attribute's value in its own words, `other` for any other value, `none` when absent
  const ariaValue = (value: string | null): string => {
    if (value === null) return 'none';
    const folded = value.trim().toLowerCase();
    return folded === 'true' || folded === 'false' || folded === 'mixed' ? folded : 'other';
  };
  // a tag or a role as the line writes it: letters, digits and dashes, cut to its length
  const token = (value: string, max: number): string => value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, max);
  const LANDMARKS = ['complementary', 'region', 'dialog', 'alertdialog', 'main', 'navigation', 'form', 'banner', 'contentinfo'];
  const LANDMARK_TAGS: Record<string, string> = { aside: 'complementary', main: 'main', nav: 'navigation', form: 'form', dialog: 'dialog', header: 'banner', footer: 'contentinfo' };
  // the landmark an element is, by the role written on it or the role its tag implies, or undefined
  const landmarkRoleOf = (el: ElementLike): string | undefined => {
    const explicit = (el.getAttribute('role') ?? '').trim().split(/\s+/)[0].toLowerCase();
    if (LANDMARKS.includes(explicit)) return explicit;
    const implied = LANDMARK_TAGS[el.tagName.toLowerCase()];
    return !explicit && implied ? implied : undefined;
  };
  // the nearest landmark above the element
  const landmarkOf = (el: ElementLike): string => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const landmark = landmarkRoleOf(node);
      if (landmark) return landmark;
    }
    return 'none';
  };
  // whether the element is inside a side panel: an element above it is a complementary landmark, whatever landmark lies
  // between (a header, a form or a region the panel draws), as the adapter's panel lookup finds a composer (`aside textarea`)
  const insidePanel = (el: ElementLike): boolean => {
    for (let node = el.parentElement; node; node = node.parentElement) if (landmarkRoleOf(node) === 'complementary') return true;
    return false;
  };
  // the allow-listed words a name holds, in the name's order and each once: the name folded, its apostrophes dropped
  // (can't as cant), split at anything that is no letter or digit, each word taken as itself or as the word its plural
  // is (messages as message, replies as reply); the name itself is never kept
  const wordSet = new Set(limits.labelWords);
  // the listed word a word is, or is the plural of: its final s dropped, or its final ies read as y; news, whose final
  // s makes no plural of new, is read as itself
  const listedWord = (word: string): string | undefined => {
    if (wordSet.has(word)) return word;
    if (word.endsWith('ies') && wordSet.has(`${word.slice(0, -3)}y`)) return `${word.slice(0, -3)}y`;
    if (word.endsWith('s') && word !== 'news' && wordSet.has(word.slice(0, -1))) return word.slice(0, -1);
    return undefined;
  };
  const labelWordsOf = (name: string): string[] => {
    const found: string[] = [];
    for (const word of name.normalize('NFKC').toLowerCase().replace(/[\u0027\u2018\u2019\u02bc]/g, '').split(/[^\p{L}\p{N}]+/u)) {
      const listed = listedWord(word);
      if (listed && !found.includes(listed)) found.push(listed);
    }
    return found;
  };
  // the side panel's buttons: whether the frame draws a panel, how many drawn buttons sit inside one and how many of
  // them are enabled, and the same per allow-listed word of their names
  let panelDrawn = false;
  const panelButtons = { drawn: 0, enabled: 0 };
  const panelWords = new Map<string, { drawn: number; enabled: number }>();
  // whether an element above the candidate is labelled for the chat (the panel's and its list's names as the adapter and
  // the fixture know them); the label itself never leaves
  const inChat = (el: ElementLike): boolean => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const label = nameOf(node, undefined).toLowerCase();
      if (label.startsWith('chat') || label.startsWith('in-call messages')) return true;
    }
    return false;
  };
  // how a candidate is named, in the order a browser builds an accessible name, and the name, read for its start alone
  const naming = (el: ElementLike): { named: string; name: string } => {
    const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
    const doc = el.ownerDocument;
    const byIds = doc && ids.length ? ids.map((id) => text(doc.getElementById(id))).filter(Boolean).join(' ') : '';
    if (byIds) return { named: 'labelledby', name: byIds };
    const aria = (el.getAttribute('aria-label') ?? '').trim();
    if (aria) return { named: 'aria', name: aria };
    const labels = el.labels;
    const byLabel = labels ? Array.from({ length: labels.length }, (_, i) => (labels[i].textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ') : '';
    if (byLabel) return { named: 'label', name: byLabel };
    const title = (el.getAttribute('title') ?? '').trim();
    if (title) return { named: 'title', name: title };
    const placeholder = (el.getAttribute('placeholder') ?? '').trim();
    if (placeholder) return { named: 'placeholder', name: placeholder };
    return { named: 'none', name: '' };
  };
  // a composer-shaped control by its fixed facts: what Playwright's visibility read and role lookup act on, and how it is named
  const candidateOf = (el: ElementLike, role: string | undefined, isEditable: boolean, isDrawn: boolean): CandidateScan => {
    const rect = el.getBoundingClientRect?.();
    const visibility = el.ownerDocument?.defaultView?.getComputedStyle?.(el)?.visibility;
    const { named, name } = naming(el);
    const folded = name.replace(/\s+/g, ' ').toLowerCase();
    return {
      tag: token(el.tagName, 24) || 'unknown',
      // a role the counts read, in its own word; any other role written on an editable is the client's text, written as other
      role: role === 'textbox' || role === 'combobox' || role === 'button' || role === 'menuitem' ? role : role ? 'other' : 'none',
      editable: isEditable,
      disabled: el.hasAttribute('disabled'),
      readOnly: el.hasAttribute('readonly'),
      ariaDisabled: ariaTrue(el, 'aria-disabled'),
      drawn: isDrawn,
      box: !!rect && rect.width > 0 && rect.height > 0,
      visibility: visibility === 'visible' || visibility === 'hidden' || visibility === 'collapse' ? visibility : 'unknown',
      ariaHidden: ariaTrue(el, 'aria-hidden'),
      named,
      label: folded.startsWith('send a message') ? 'send' : folded.startsWith('history is o') ? 'history' : folded ? 'other' : 'none',
      chat: inChat(el),
      landmark: landmarkOf(el),
      words: labelWordsOf(name),
    };
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
    const isDrawn = drawn(el);
    // a composer-shaped control, whatever its state: listed by its fixed facts, the drawn ones first
    if (role === 'textbox' || isEditable) {
      candidateCount += 1;
      const kept = isDrawn ? drawnFound : undrawnFound;
      if (kept.length < maxCandidates) kept.push(candidateOf(el, role, isEditable, isDrawn));
    }
    // the toolbar's Chat key, by the adapter's own name for it: its pressed and expanded state is the sign of an open panel
    if (!key && isDrawn && role === 'button' && /^chat with everyone/i.test(nameOf(el, role))) {
      key = { pressed: ariaValue(el.getAttribute('aria-pressed')), expanded: ariaValue(el.getAttribute('aria-expanded')) };
    }
    if (isDrawn && landmarkRoleOf(el) === 'complementary') panelDrawn = true;
    // a drawn button inside the side panel and outside any message: counted, read for whether it is enabled and for the
    // words of its name alone; a button inside a message (a reaction's key, a chip the message draws) or carrying a
    // message's id (the Pin key beside one) counts for nothing, since its name may be the message's own text
    if (isDrawn && role === 'button' && !marksMessage(el) && !insideMessage(el) && insidePanel(el)) {
      const enabled = !el.hasAttribute('disabled') && !ariaTrue(el, 'aria-disabled');
      panelButtons.drawn += 1;
      if (enabled) panelButtons.enabled += 1;
      for (const word of labelWordsOf(nameOf(el, role))) {
        const tally = panelWords.get(word) ?? { drawn: 0, enabled: 0 };
        tally.drawn += 1;
        if (enabled) tally.enabled += 1;
        panelWords.set(word, tally);
      }
    }
    if (isDrawn) {
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
  // the drawn candidates first, each kind in document order, and the rest counted
  const candidates = [...drawnFound, ...undrawnFound].slice(0, maxCandidates);
  const words = limits.labelWords.filter((word) => panelWords.has(word)).map((word) => ({ word, ...(panelWords.get(word) as { drawn: number; enabled: number }) }));
  return { counts, names, roster, people, truncated, ...(key ? { key } : {}), candidates, moreCandidates: candidateCount - candidates.length, ...(panelDrawn ? { panelButtons: { ...panelButtons, words } } : {}) };
}

/**
 * The words a composer-shaped control's name and a side panel's buttons' names are read for, in the order the panel's
 * buttons are written: words for a chat that is stopped for the participant (a host's switch or an admin's policy:
 * Google's help page says a host can "turn off chat" and that participants then "can still read the messages", and its
 * admin page that users "can't send messages"), for a step a guest takes first (Google Chat sends an outside person
 * "an invite to join the chat" and asks that a first message request be accepted), for the composer's own wordings
 * ("Send a message", "History is on", a message to everyone, a view-only or read-only chat, a reply) and for an outside
 * guest (a guest "from outside the host's organization", "not signed in", an "External" badge). Then, since the nightly
 * check's Meet run of 28 October 2026 found the disabled composer's label holding `chat` and no other of those words,
 * and the side panel's one disabled button the same, the words that tell apart why a composer drawn disabled takes no
 * text, in the wording of Google's help page on Meet's chat (continuous meeting chat runs "before, during, and after a
 * meeting", and the page explains "why continuous meeting chat is unavailable": an "Organization or policy
 * restriction", "Workspace admin settings", a chat "limited to in-meeting") and of Google's announcement of that chat,
 * which keeps the messages "in a shared Google Chat conversation". They are words for whether the chat is available
 * (`unavailable`, or `isnt` or `wont` beside `available`, names the client saying the chat is not available to this
 * participant; `open`, `start` or `enable` a step that would make it so, and `unable` one refused), for a restriction
 * and who sets it (`restricted`, `limited`, `locked` or `blocked` names the chat held back; `organizer`, `organiser`,
 * `owner`, `admin` or `administrator` who holds it back; `permission`, `policy`, `setting`, `domain`, `workspace` or
 * `account` what holds it back), for the meeting and its people (`during`, `before` or `after` beside `call` or
 * `meeting` names when the chat is open to the participant; `people`, `participant`, `attendee` or `member` whom it
 * covers) and for a continuation in Google Chat (`google`, `space`, `group`, `conversation`, `new` or `here`, or
 * `open`, on the disabled panel button names the meeting's chat carried into Google Chat, for the participant to open
 * there, and `continuous` names that chat itself, which the help page and the announcement (Workspace Updates,
 * November 2025) call "continuous meeting chat" and which a host can turn off for a meeting). A plural is listed as its
 * word, which the scan reads both forms back to (`settings` as `setting`), and an apostrophe is dropped (`isn't` as
 * `isnt`). No word names a person: a name is read for these words and never written, so the outline says what the
 * panel offers without quoting it.
 */
export const LABEL_WORDS: readonly string[] = [
  'off', 'on', 'turned', 'turn', 'disabled', 'paused', 'host', 'only', 'cant', 'cannot', 'not', 'allowed', 'allow',
  'join', 'joined', 'accept', 'accepted', 'invited', 'invite', 'invitation', 'request', 'continue',
  'chat', 'message', 'send', 'sent', 'reply', 'read', 'view', 'history', 'everyone',
  'guest', 'outside', 'external', 'organization', 'organisation', 'signed', 'sign', 'wait',
  'available', 'unavailable', 'isnt', 'wont', 'open', 'opened', 'start', 'started', 'enable', 'enabled', 'unable',
  'restricted', 'limited', 'locked', 'blocked', 'admin', 'administrator', 'organizer', 'organiser', 'owner',
  'permission', 'policy', 'setting', 'domain', 'workspace', 'account',
  'call', 'meeting', 'during', 'after', 'before', 'people', 'participant', 'attendee', 'member',
  'google', 'space', 'group', 'conversation', 'new', 'here', 'continuous',
];

/**
 * How much of each frame the outline reads and keeps: the names a frame may give, the names it reads before the filter,
 * a kept name's length, the elements a walk reads, the length past which a name is dropped without its comparison (no
 * control's label runs that long, and a long quote does), and the terms past which the names are withheld and no more
 * terms are made: the filter makes the terms and compares every name with every term, and these two bound its work, so
 * a long conversation never holds the report up; and the composer-shaped controls a frame lists, the drawn ones first.
 */
export const OUTLINE_LIMITS = { maxNames: 12, maxRawNames: 60, maxNameLength: 40, maxElements: 30_000, maxRawNameLength: 200, maxTerms: 20_000, maxCandidates: 4 };
/** How long the frames' reading may take, over all the frames: a failed step's report is not held up by a frame that does not answer. */
export const OUTLINE_MS = 3_000;
/** How long the outline may be: inside the protocol's ceiling on an error report's message (2,000 characters) with the phase and the longest step code before it; {@link panelOutline} fits the frames to it, and the lookups tried stay at its end. */
export const OUTLINE_MAX_LENGTH = 1_900;

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

/**
 * Visits each run of three consecutive words of a folded text, joined by single spaces: the pieces a quote of the text
 * shares with it. The runs are read over its words between spaces ({@link wordsOf}) and over its words with each letter
 * of {@link UNSPACED} a word of its own ({@link runWordsOf}), so the letters add runs and take none away. It stops, and
 * answers true, as soon as `visit` answers true.
 */
const visitRuns = (folded: string, visit: (run: string) => boolean): boolean => {
  for (const words of [wordsOf(folded), runWordsOf(folded)]) {
    for (let i = 0; i + RUN_WORDS <= words.length; i += 1) if (visit(words.slice(i, i + RUN_WORDS).join(' '))) return true;
  }
  return false;
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
 * What the filter reads as a mark between words, both as nothing and as a space ({@link formsOf}): the characters the
 * clean drops ({@link DROPPED}), and a modifier letter written as an apostrophe, which Unicode makes a letter and the
 * clean keeps: the modifier letter apostrophe (U+02BC, `Alʼs`), the prime (U+02B9), the turned comma (U+02BB, the
 * ʻokina), the reversed comma (U+02BD), the right and the left half ring (U+02BE, U+02BF), the vertical line (U+02C8),
 * the double apostrophe (U+02EE) and the saltillo (U+A78B, U+A78C). Each is read as an apostrophe is, on a text's side
 * and on a name's alike, so `Al` is a word of `Alʼs` as it is of `Al's`, a text of two characters written with one
 * (`xʹ`) is the term `x`, and a text and its quote meet whichever apostrophe each writes. U+02BC alone was split
 * before, by chance: Unicode's script extensions name Thai for it, and {@link RUN_WORD} reads each letter of a script
 * whose words run together as a word of its own.
 */
const MARKS_BETWEEN_WORDS = /[^\p{L}\p{N} _.,()-]|[\u02b9\u02bb\u02bc\u02bd\u02be\u02bf\u02c8\u02ee\ua78b\ua78c]/gu;

/**
 * The forms a text is compared in, case folded: cleaned, the marks it loses joined out (`O'Reilly` as `oreilly`), and
 * with each such mark read as a space (`alpha/beta` as `alpha beta`, `budget:approved` as `budget approved`), so a quote
 * meets its text whichever of the two writes a mark between the words, a modifier letter written as an apostrophe read
 * as a mark ({@link MARKS_BETWEEN_WORDS}). The second form is left out when it is the first. A mark the case folding
 * adds is dropped too: a dotted capital I (`İ`) folds to `i` and a combining dot above, which both forms read as `i`,
 * as they read a plain `I`. A form's forms are then the form itself, so the terms {@link frameLine} makes again from
 * the terms {@link panelOutline} made are the same terms, and a name spelled as the tile or the message spells it still
 * meets them.
 */
const formsOf = (text: string): string[] => {
  const normal = text.normalize('NFKC');
  const joined = fold(normal.replace(MARKS_BETWEEN_WORDS, '')).replace(MARKS_BETWEEN_WORDS, '');
  const spaced = fold(normal.replace(MARKS_BETWEEN_WORDS, ' ')).replace(MARKS_BETWEEN_WORDS, '');
  return spaced === joined ? [joined] : [joined, spaced];
};

/** A name as the outline shows it: the whole name cleaned, then cut to its length. The address test and the roster filter never read a cut name. */
export function cleanName(name: string, maxLength = OUTLINE_LIMITS.maxNameLength): string {
  return clean(name).slice(0, maxLength).trim();
}

/**
 * What the link test drops before it reads a name, in the name's decomposed form (NFKD, which folds its compatibility
 * forms as well: a full-width `@` as `@`, a full-width `tel:` as `tel:`): every format character (a zero-width space,
 * a soft hyphen, a word joiner, a zero-width no-break space), every other default-ignorable code point (a combining
 * grapheme joiner, a variation selector) and every combining mark (a dot above, an accent); the decomposed form so
 * that a mark a letter composes with (`mailtȯ:`) is dropped as one that composes with nothing (`tel` U+0307 `:`) is.
 * What a browser ignores in a host is among them, and none of them keeps a scheme from its colon or a host's label
 * from its dot.
 */
const INVISIBLE_OR_COMBINING = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{M}]/gu;

/**
 * Whether a name holds anything shaped like an address or a link ({@link ADDRESS_OR_LINK}), read three ways: as written;
 * decomposed, with every invisible or combining mark dropped ({@link INVISIBLE_OR_COMBINING}) and the ideographic full
 * stops read as dots, which is a browser's reading of a host and more (a browser keeps an accent), so that no such mark
 * sets a scheme's colon or a host's dot apart from it; and cleaned, as the outline would show it, so a mark the clean
 * drops (a bracket around a dot) cannot leave a host in what is shown. A name any reading matches is dropped whole.
 */
const linkShaped = (name: string): boolean =>
  ADDRESS_OR_LINK.test(name) ||
  ADDRESS_OR_LINK.test(name.normalize('NFKD').replace(INVISIBLE_OR_COMBINING, '').replace(LABEL_DOTS, '.')) ||
  ADDRESS_OR_LINK.test(clean(name));

/**
 * The texts a name must not quote, as the filter compares them with a name, in each of the forms {@link formsOf} makes:
 * each entry whole, cleaned as a name is cleaned and folded, so a spelling with marks (`O'Reilly`) still meets the name
 * that quotes it (`Reply to OReilly`), and a mark between two words (`alpha/beta`) meets the space a name puts there;
 * each run of three words of an entry ({@link visitRuns}: in a script whose words run together, three letters in a row
 * too), so a name that quotes a part of a message with words of its own around it (`Replying to Al: the budget is in
 * the shared folder`) meets the message; and each word of a participant's name, so `Message Alice` meets the tile
 * `Alice Smith`. A term of fewer than three characters (`Li` of `Li Na`, the name `王伟`) is kept too, and
 * {@link frameLine} matches it as a word of a name, never inside one, unless it is written in a script whose words run
 * together ({@link UNSPACED}), where it counts anywhere in the name. The terms never leave the bot. Making them stops
 * one past `limit`, once there are more distinct terms than it: past it the names are withheld whatever the rest holds,
 * so the rest is never made.
 *
 * @param roster - The tiles' names, the senders' names and the messages' texts.
 * @param people - The participants' names among them, whose words count too.
 * @param limit - How many distinct terms to make before stopping one past it; the outline passes {@link OUTLINE_LIMITS}' `maxTerms`.
 */
export function rosterTerms(roster: readonly string[], people: readonly string[] = [], limit = Infinity): string[] {
  const terms = new Set<string>();
  // true once there are more distinct terms than the limit: the making stops there, and the names are withheld
  const add = (term: string): boolean => {
    if (term) terms.add(term);
    return terms.size > limit;
  };
  for (const entry of roster) {
    for (const form of formsOf(entry)) if (add(form) || visitRuns(form, add)) return [...terms];
  }
  for (const name of people) {
    for (const form of formsOf(name)) {
      if (add(form)) return [...terms];
      for (const word of wordsOf(form)) if (add(word)) return [...terms];
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
  return terms.some(quotes) || visitRuns(folded, (run) => termSet.has(run));
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
 * One frame's line of the outline, from its scan: its counts, `partial` when its walk stopped at the element limit, the
 * Chat key's state (`key=`) when the frame draws the key, the side panel's buttons (`pbtn=<drawn>,on:<enabled>` and
 * `<word>:<drawn>(<enabled>)` per allow-listed word of their names) when the frame draws a side panel, the
 * composer-shaped controls by their fixed facts (`cands=`, each as {@link candidateToken} writes it, `more:<n>` for
 * those past the limit), and
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
  return assembleLine(frameParts(index, host, scan, roster, namesAllowed, maxNames));
}

/**
 * One frame's line in the parts {@link panelOutline} fits to the outline's length: the base (`f<n> <host>`, the counts,
 * `partial`, the key and the panel's totals, or `f<n> <host> unread`), the panel's tallies by word (each
 * `,<word>:<drawn>(<enabled>)`, which follow the totals), each candidate's token in the scan's order, how many
 * candidates the scan counted past them, and the names token (` names=...`, or empty).
 */
export interface FrameParts {
  base: string;
  panelWords: string[];
  candidates: string[];
  moreCandidates: number;
  names: string;
}

/**
 * A frame's line from its parts: the base, the first `maxWords` of the panel's tallies by word, at most `maxCandidates`
 * of its candidates with the rest counted in `more:<n>` (no `cands=` token when none is kept), and its names when
 * `withNames`.
 */
export function assembleLine(parts: FrameParts, maxCandidates = Infinity, withNames = true, maxWords = Infinity): string {
  const kept = parts.candidates.slice(0, maxCandidates);
  const more = parts.moreCandidates + parts.candidates.length - kept.length;
  const candidates = kept.length ? ` cands=${kept.join('|')}${more ? `|more:${more}` : ''}` : '';
  return `${parts.base}${parts.panelWords.slice(0, maxWords).join('')}${candidates}${withNames ? parts.names : ''}`;
}

/** One frame's line in parts, as {@link frameLine} describes the line; {@link panelOutline} fits the parts to the outline's length. */
export function frameParts(index: number, host: string, scan: FrameScan | undefined, roster: readonly string[], namesAllowed = true, maxNames = OUTLINE_LIMITS.maxNames): FrameParts {
  if (!scan) return { base: `f${index} ${host} unread`, panelWords: [], candidates: [], moreCandidates: 0, names: '' };
  const c = scan.counts;
  const terms = termsOfRoster.get(roster) ?? rosterTerms(roster, [], OUTLINE_LIMITS.maxTerms);
  termsOfRoster.set(roster, terms);
  // past its limit the roster is never compared in part: the names are withheld
  const allowed = namesAllowed && !scan.truncated && terms.length <= OUTLINE_LIMITS.maxTerms;
  const names: string[] = [];
  if (allowed) {
    const termSet = new Set(terms);
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
  const key = scan.key ? ` key=pressed:${scan.key.pressed},expanded:${scan.key.expanded}` : '';
  // the panel's totals in the base, and its tallies by word as parts of their own, fitted after the first candidates
  const panel = scan.panelButtons ? ` pbtn=${scan.panelButtons.drawn},on:${scan.panelButtons.enabled}` : '';
  const panelWords = (scan.panelButtons?.words ?? []).map(({ word, drawn, enabled }) => `,${word}:${drawn}(${enabled})`);
  const withheld = names.length === 0 && scan.names.length > 0 && !allowed;
  const shown = names.length ? ` names=${names.join('|')}` : withheld ? ' names=withheld' : '';
  return { base: `f${index} ${host} ${counts}${scan.truncated ? ' partial' : ''}${key}${panel}`, panelWords, candidates: (scan.candidates ?? []).map(candidateToken), moreCandidates: scan.moreCandidates ?? 0, names: shown };
}

/**
 * A composer-shaped control's facts as the line writes them: its tag and its role, then each fact as `name:value`, the
 * value a fixed word or `1` or `0`: `ce` editable, `dis` disabled, `ro` read-only, `ad` aria-disabled, `drawn`, `box`,
 * `vis` the computed visibility, `ah` aria-hidden, `name` how it is named, `lbl` whether its name begins as the lookups
 * expect, `chat` whether an element above it is labelled for the chat, `land` the nearest landmark above it, `words`
 * the allow-listed words its name holds, joined by `-` in the name's order, or `none`.
 */
export function candidateToken(candidate: CandidateScan): string {
  const bit = (value: boolean): string => (value ? '1' : '0');
  return [
    candidate.tag,
    candidate.role,
    `ce:${bit(candidate.editable)}`,
    `dis:${bit(candidate.disabled)}`,
    `ro:${bit(candidate.readOnly)}`,
    `ad:${bit(candidate.ariaDisabled)}`,
    `drawn:${bit(candidate.drawn)}`,
    `box:${bit(candidate.box)}`,
    `vis:${candidate.visibility}`,
    `ah:${bit(candidate.ariaHidden)}`,
    `name:${candidate.named}`,
    `lbl:${candidate.label}`,
    `chat:${bit(candidate.chat)}`,
    `land:${candidate.landmark}`,
    `words:${candidate.words.length ? candidate.words.join('-') : 'none'}`,
  ].join(',');
}

/**
 * The chat panel's outline: `panel: frames=<n>; f1 <host> <counts> [key=...] [pbtn=...] [cands=...] [names=...]; f2 ...; tried=<lookups>`. The main frame
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
      const limits: OutlineLimits = { buttonNames: frame !== main, maxRawNames: OUTLINE_LIMITS.maxRawNames, maxElements: OUTLINE_LIMITS.maxElements, maxCandidates: OUTLINE_LIMITS.maxCandidates, labelWords: LABEL_WORDS };
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
    OUTLINE_LIMITS.maxTerms,
  );
  // the names are withheld when any frame went unread (the main frame holds the tiles, and an unread frame may be the
  // chat's, with its senders and messages) or any frame's walk stopped at its element limit: the texts the names must
  // not quote may then be unread
  const namesAllowed = scans.every(({ scan }) => scan !== undefined && !scan.truncated);
  const parts = scans.map(({ host, scan }, i) => frameParts(i + 1, host, scan, roster, namesAllowed));
  const head = `panel: frames=${frames.length}; `;
  const tail = `; tried=${tried}`;
  const room = OUTLINE_MAX_LENGTH - head.length - tail.length;
  // the frames fitted to the room, so a crowded frame never uses it up before the frame that holds the composer is
  // written and no token is cut: every frame's base (its counts, key and panel totals) first; then each frame's first
  // candidate; then the panels' tallies by word, each frame's first word, then each frame's second, and so on, while
  // they fit; then each frame's second candidate, then each frame's third, and so on, while they fit; then each frame's
  // names while they fit
  const kept = parts.map(() => 0);
  const worded = parts.map(() => 0);
  const named = parts.map(() => false);
  const length = (): number => parts.reduce((sum, part, i) => sum + assembleLine(part, kept[i], named[i], worded[i]).length, 0) + 2 * (parts.length - 1);
  if (length() <= room) {
    let full = false;
    // each frame's nth candidate, frame by frame, from the `from`th to the `to`th, while they fit
    const fitCandidates = (from: number, to: number): void => {
      for (let n = from; n <= to && !full; n += 1) {
        for (let i = 0; i < parts.length && !full; i += 1) {
          if (parts[i].candidates.length < n) continue;
          kept[i] = n;
          if (length() > room) {
            kept[i] = n - 1;
            full = true;
          }
        }
      }
    };
    const most = Math.max(0, ...parts.map((part) => part.candidates.length));
    const mostWords = Math.max(0, ...parts.map((part) => part.panelWords.length));
    fitCandidates(1, Math.min(1, most));
    for (let n = 1; n <= mostWords && !full; n += 1) {
      for (let i = 0; i < parts.length && !full; i += 1) {
        if (parts[i].panelWords.length < n) continue;
        worded[i] = n;
        if (length() > room) {
          worded[i] = n - 1;
          full = true;
        }
      }
    }
    fitCandidates(2, most);
    for (let i = 0; i < parts.length; i += 1) {
      if (!parts[i].names) continue;
      named[i] = true;
      if (length() > room) named[i] = false;
    }
    return `${head}${parts.map((part, i) => assembleLine(part, kept[i], named[i], worded[i])).join('; ')}${tail}`;
  }
  // the bases alone pass the room: the frames at the end are dropped whole, without their tallies, and the lookups
  // tried are kept, which a failed night is read by; the first frame's base is cut only when it alone passes the room
  let body = '';
  for (const base of parts.map((part) => assembleLine(part, 0, false, 0))) {
    const next = body ? `${body}; ${base}` : base;
    if (next.length > room) break;
    body = next;
  }
  return `${head}${body || assembleLine(parts[0], 0, false, 0).slice(0, Math.max(0, room))}${tail}`;
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
