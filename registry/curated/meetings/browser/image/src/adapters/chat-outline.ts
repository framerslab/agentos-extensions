import type { Frame, Page } from 'playwright';

/**
 * What a failed step of posting a message leaves in the run's report beside its code: an outline of the chat panel, so
 * the next failure explains itself. For each frame of the page, the main frame first and then the frames the panel
 * embeds (a Google Chat conversation's frame on chat.google.com), the outline holds the frame's host and its counts of
 * interactive controls by role (textbox, combobox, button, menuitem), of editables, of list items and of elements that
 * carry a message id, and the accessible names of the composer-shaped controls (textboxes, comboboxes and editables in
 * every frame; buttons and menu items in the embedded frames alone, since the main frame's tiles and lists carry the
 * participants' names on theirs), capped in length and count. It never holds a message's text, a participant's name or
 * address, or a URL's path or query: a control inside a message element names nothing, a name that quotes a tile's, a
 * sender's or a message's text is dropped, every name is cut to letters, digits and a few marks, and a frame is named by
 * its host alone. Everything in it fits the nightly check's record line: letters, digits, space and `_.,:;=|()-`.
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
  /** The accessible names of the controls the outline may name, in document order, before the roster filter and the cut. */
  names: string[];
  /** The texts a name must not quote: the tiles' names, the senders' names and the messages' texts. They are used to drop names and never leave the bot. */
  roster: string[];
  /** True when the walk stopped at its element limit. */
  truncated: boolean;
}

/** What {@link collectFrameOutline} is given: how much to read, and in a test the fake root to read instead of the frame's document. */
export interface OutlineLimits {
  /** Whether buttons and menu items are named: true in an embedded frame, whose controls are the chat's own. */
  buttonNames: boolean;
  /** How many names one frame may give, before the roster filter. */
  maxNames: number;
  /** How many characters of a name are kept. */
  maxNameLength: number;
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
  if (!root) return { counts, names, roster, truncated: false };
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
    if (!name && (role === 'button' || role === 'menuitem')) name = text(el);
    if (!name && role !== 'button' && role !== 'menuitem') name = el.getAttribute('placeholder') ?? '';
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
    // the tiles' names, the senders' names and the messages' texts: read so that a name quoting them is dropped
    const self = el.getAttribute('data-self-name');
    if (self) roster.push(self);
    const sender = el.getAttribute('data-sender-name');
    if (sender) roster.push(sender);
    if (el.hasAttribute('data-participant-id') || el.hasAttribute('data-sender-name') || el.hasAttribute('data-message-text')) {
      const own = text(el);
      if (own) roster.push(own.slice(0, 80));
    }
    if (el.hasAttribute('data-message-id')) counts.messageid += 1;
    const role = roleOf(el);
    if (role === 'listitem') counts.listitem += 1;
    const isEditable = editable(el);
    if (drawn(el)) {
      if (isEditable) counts.editable += 1;
      if (role === 'textbox' || role === 'combobox' || role === 'button' || role === 'menuitem') counts[role] += 1;
      const named = role === 'textbox' || role === 'combobox' || isEditable || ((role === 'button' || role === 'menuitem') && limits.buttonNames);
      if (named && names.length < limits.maxNames && !insideMessage(el)) {
        const name = nameOf(el, role);
        if (name) names.push(name.slice(0, limits.maxNameLength));
      }
    }
    for (let i = el.children.length - 1; i >= 0; i -= 1) stack.push(el.children[i]);
  }
  return { counts, names, roster, truncated };
}

/** How much of each frame the outline reads and keeps. */
export const OUTLINE_LIMITS = { maxNames: 12, maxNameLength: 40, maxElements: 30_000 };
/** How long the whole outline may take, over all the frames: a failed step's report is not held up by a frame that does not answer. */
export const OUTLINE_MS = 3_000;
/** How long the outline may be: well inside the protocol's ceiling on an error report's message, with the phase and the code before it. */
export const OUTLINE_MAX_LENGTH = 1_500;

const sleep = (ms: number): Promise<undefined> => new Promise((resolve) => setTimeout(() => resolve(undefined), ms));

/** Text as the roster filter compares it: spaces collapsed, case folded. */
const fold = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** A name as the outline shows it: letters, digits, space and `_.,()-` alone (the record line's alphabet, less the outline's own marks), spaces collapsed. */
export function cleanName(name: string, maxLength = OUTLINE_LIMITS.maxNameLength): string {
  return name
    .replace(/[^\p{L}\p{N} _.,()-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
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

/** One frame's line of the outline, from its scan, with the names that quote no roster text. */
export function frameLine(index: number, host: string, scan: FrameScan | undefined, roster: readonly string[]): string {
  if (!scan) return `f${index} ${host} unread`;
  const c = scan.counts;
  const names: string[] = [];
  for (const raw of scan.names) {
    const name = cleanName(raw);
    if (!name || names.includes(name)) continue;
    const folded = fold(name);
    if (roster.some((entry) => folded.includes(entry))) continue;
    names.push(name);
  }
  const counts = `textbox=${c.textbox} combobox=${c.combobox} button=${c.button} menuitem=${c.menuitem} editable=${c.editable} listitem=${c.listitem} messageid=${c.messageid}`;
  return `f${index} ${host} ${counts}${scan.truncated ? ' partial' : ''}${names.length ? ` names=${names.join('|')}` : ''}`;
}

/**
 * The chat panel's outline: `panel: frames=<n>; f1 <host> <counts> [names=...]; f2 ...; tried=<lookups>`. The main frame
 * is f1 and the frames the page embeds follow, in the page's order. A frame that gives no reading within the outline's
 * time is `unread`. The lookups are the ones the failed step tried, named by the adapter.
 *
 * @param page - The page in the call.
 * @param tried - The lookups the failed step tried, as the adapter names them (for example `composer:role,textarea,editable`).
 * @param timeoutMs - How long the whole outline may take.
 */
export async function panelOutline(page: Page, tried: string, timeoutMs = OUTLINE_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const main = page.mainFrame();
  const frames: Frame[] = [main, ...page.frames().filter((frame) => frame !== main)];
  const scans: Array<{ host: string; scan: FrameScan | undefined }> = [];
  for (const frame of frames) {
    const remaining = deadline - Date.now();
    const limits: OutlineLimits = { ...OUTLINE_LIMITS, buttonNames: frame !== main };
    // a frame between documents, or one that never answers, is read as unread rather than holding the report up
    const scan = remaining > 0 ? await Promise.race([frame.evaluate(collectFrameOutline, limits).catch(() => undefined), sleep(remaining)]) : undefined;
    scans.push({ host: frameHost(frame.url()), scan });
  }
  // the roster is read from every frame and applied to every frame's names: a participant's name on a tile in the main
  // frame may be quoted by a control in the chat's frame
  const roster = scans.flatMap(({ scan }) => scan?.roster ?? []).map(fold).filter((entry) => entry.length >= 3);
  const lines = scans.map(({ host, scan }, i) => frameLine(i + 1, host, scan, roster));
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
