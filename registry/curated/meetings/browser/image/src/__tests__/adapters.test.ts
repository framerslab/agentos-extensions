import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { ChatStepError, OUTLINE_LIMITS, cleanName, collectFrameOutline, frameHost, frameLine, outlineOf, panelOutline, rosterTerms, type ElementLike, type FrameScan } from '../adapters/chat-outline.js';
import { fixtureAdapter } from '../adapters/fixture.js';
import { MEET_CHAT_TIMING, SELECTORS as MEET_SELECTORS, googleMeetAdapter } from '../adapters/google-meet.js';
import { SELECTORS as TEAMS_SELECTORS, microsoftTeamsAdapter } from '../adapters/microsoft-teams.js';
import { hostAllowed, requestAllowed } from '../network-policy.js';
import type { ChatMessage } from '../adapters/types.js';

const top = (url: string) => ({ url, topLevelNavigation: true });
const sub = (url: string) => ({ url, topLevelNavigation: false });

/** The alphabet of the nightly check's record line (real-join.mjs, ERROR_LINE): an error report's message outside it is kept as `error`. */
const RECORD_LINE = /^[\p{L}\p{N}_.,:;=|() -]{1,2000}$/u;

/**
 * Whether a selector string mixes Playwright engines: Playwright reads a string that does not start with an engine
 * prefix (`text=`, `css=`, `xpath=`) as CSS, so an engine prefix later in a comma list makes the whole string invalid
 * CSS, which throws when the locator is used.
 */
function mixesEngines(selector: string): boolean {
  if (/^[a-zA-Z_0-9-+:*]+=/.test(selector)) return false;
  return /(^|,)\s*[a-zA-Z_-]+=/.test(selector);
}

describe('the selector tables', () => {
  it('mark a mixed string, such as a CSS selector and a text selector in one list', () => {
    expect(mixesEngines('input[type="email"], text=/Sign in/i')).toBe(true);
    expect(mixesEngines('text=/Sign in/i')).toBe(false);
    expect(mixesEngines('div[data-participant-id], div[data-self-name]')).toBe(false);
  });

  for (const [platform, table] of [['Google Meet', MEET_SELECTORS], ['Microsoft Teams', TEAMS_SELECTORS]] as const) {
    it(`hold one Playwright engine per selector (${platform})`, () => {
      for (const [name, selector] of Object.entries(table)) expect({ name, mixed: mixesEngines(selector) }).toEqual({ name, mixed: false });
    });
  }

  it('date each adapter by the reading of its client', () => {
    for (const adapter of [googleMeetAdapter, microsoftTeamsAdapter]) expect(adapter.selectorsVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  // the nightly check of 24 October 2026 found the Meet chat's composer is no textarea in a meeting whose chat is a
  // Google Chat conversation: the key and the composer are named by role and accessible name, the earlier markup kept
  it("name the Meet chat's key and composer by role and accessible name, and keep the earlier markup as fallbacks", () => {
    expect(MEET_SELECTORS.chatButton).toMatch(/^role=button\[name=\/.*chat with everyone.*\/i\]$/);
    expect(MEET_SELECTORS.chatInput).toMatch(/^role=textbox\[name=\/.*send a message.*history is o.*\/i\]$/);
    expect(MEET_SELECTORS.chatInputLegacy).toMatch(/^textarea\[aria-label/);
    expect(MEET_SELECTORS.chatInputEditable).toContain('[role="textbox"][contenteditable]');
    expect(MEET_SELECTORS.chatInputEditable).toContain('[aria-label^="Send a message" i] [contenteditable]');
    expect(googleMeetAdapter.selectorsVersion >= '2026-10-25').toBe(true);
  });

  // a Google Chat conversation draws a Pin key beside each message that carries the message's data-message-id too: read
  // as a message, it would take the message's place in the observer's memory of what it has read
  it("read a Meet message by the client's id for it, never the Pin key beside it that carries the same id", () => {
    expect(MEET_SELECTORS.chatMessages.split(',')[0].trim()).toBe('[data-message-id]:not(button):not([role="button"])');
  });
});

describe('the network policy', () => {
  it('matches a host exactly, or a suffix pattern for the suffix and the hosts under it', () => {
    expect(hostAllowed('google.com', ['*.google.com'])).toBe(true);
    expect(hostAllowed('clients6.google.com', ['*.google.com'])).toBe(true);
    expect(hostAllowed('evilgoogle.com', ['*.google.com'])).toBe(false);
    expect(hostAllowed('google.com.example.org', ['*.google.com'])).toBe(false);
    expect(hostAllowed('www.meet.google.com', ['meet.google.com'])).toBe(false);
  });

  it('keeps a Google Meet page on the join hosts and its other requests on the platform hosts', () => {
    expect(requestAllowed(top('https://meet.google.com/abc-defg-hij'), googleMeetAdapter).allowed).toBe(true);
    expect(requestAllowed(top('https://accounts.google.com/signin'), googleMeetAdapter).allowed).toBe(true);
    expect(requestAllowed(top('https://www.google.com/'), googleMeetAdapter)).toEqual({ allowed: false, host: 'www.google.com' });
    expect(requestAllowed(sub('https://www.google.com/'), googleMeetAdapter).allowed).toBe(true);
    expect(requestAllowed(sub('https://www.gstatic.com/meet/app.js'), googleMeetAdapter).allowed).toBe(true);
    // the frame a Google Chat conversation's panel embeds is on a Google host the policy admits
    expect(requestAllowed(sub('https://chat.google.com/embed/space/x'), googleMeetAdapter).allowed).toBe(true);
    expect(requestAllowed(sub('https://evilgoogle.com/x.js'), googleMeetAdapter)).toEqual({ allowed: false, host: 'evilgoogle.com' });
  });

  it('keeps a Microsoft Teams page on the join hosts and its other requests on the platform hosts', () => {
    expect(requestAllowed(top('https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0'), microsoftTeamsAdapter).allowed).toBe(true);
    expect(requestAllowed(top('https://teams.live.com/meet/9312345678901'), microsoftTeamsAdapter).allowed).toBe(true);
    expect(requestAllowed(top('https://login.microsoftonline.com/common/oauth2'), microsoftTeamsAdapter).allowed).toBe(false);
    expect(requestAllowed(sub('https://login.microsoftonline.com/common/oauth2'), microsoftTeamsAdapter).allowed).toBe(true);
    expect(requestAllowed(sub('https://teams.microsoft.com.example.org/x.js'), microsoftTeamsAdapter).allowed).toBe(false);
  });

  it('refuses plain http, address literals and unparsable urls on every platform', () => {
    for (const adapter of [googleMeetAdapter, microsoftTeamsAdapter]) {
      expect(adapter.allowHttp).not.toBe(true);
      expect(requestAllowed(top(`http://${adapter.joinHosts[0]}/`), adapter).allowed).toBe(false);
      expect(requestAllowed(sub('https://142.250.80.46/x'), adapter)).toEqual({ allowed: false, host: '142.250.80.46' });
      expect(requestAllowed(sub('https://0x7f000001/x'), adapter)).toEqual({ allowed: false, host: '127.0.0.1' });
      expect(requestAllowed(sub('https://[2607:f8b0:4004:c1b::64]/x'), adapter).allowed).toBe(false);
      expect(requestAllowed(sub('not a url'), adapter)).toEqual({ allowed: false, host: 'unparsable' });
    }
  });
});

describe('the fixture adapter', () => {
  const link = 'http://fixture:8787/?platform=google_meet&people=1';

  it('runs the adapter of the platform the link names', () => {
    const adapter = fixtureAdapter(link);
    expect(adapter.platform).toBe('google_meet');
    expect(adapter.join).toBe(googleMeetAdapter.join);
    expect(adapter.observeChat).toBe(googleMeetAdapter.observeChat);
    const teams = fixtureAdapter('http://fixture:8787/?platform=microsoft_teams&composer=self');
    expect(teams.platform).toBe('microsoft_teams');
    expect(teams.postChat).toBe(microsoftTeamsAdapter.postChat);
    expect(teams.observeChat).toBe(microsoftTeamsAdapter.observeChat);
    expect(teams.joinHosts).toEqual(['fixture']);
  });

  it("admits the fixture's own host alone, over http as well as https", () => {
    const adapter = fixtureAdapter(link);
    expect(requestAllowed(top(link), adapter).allowed).toBe(true);
    expect(requestAllowed(sub('http://fixture:8787/recording.wav'), adapter).allowed).toBe(true);
    expect(requestAllowed(sub('https://fixture/x'), adapter).allowed).toBe(true);
    expect(requestAllowed(top('https://meet.google.com/abc-defg-hij'), adapter).allowed).toBe(false);
    expect(requestAllowed(sub('http://product:8790/events'), adapter)).toEqual({ allowed: false, host: 'product' });
  });
});

/** A message element of a fake chat panel: the client's id for it, its sender's name, its body element's text or none, and its whole text. */
interface FakeMessage {
  id: string;
  sender: string;
  body?: string;
  whole: string;
}

/** A fake frame of a fake page: its url, the elements each selector finds in it, and what the outline reads in it. */
interface FakeFrame {
  url(): string;
  locator(selector: string): unknown;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
}

/** A fake frame whose reads of its selectors are `locator`, whose outline reads `root`, and whose `evaluate` never answers when `silent`. */
function fakeFrame(url: string, locator: (selector: string) => unknown, root?: ElementLike, silent = false): FakeFrame {
  return {
    url: () => url,
    locator,
    evaluate: <T, A>(fn: (arg: A) => T, arg: A): Promise<T> => (silent ? new Promise<T>(() => undefined) : Promise.resolve(fn({ ...(arg as object), root } as A))),
  };
}

/**
 * As much of a Playwright page as an adapter's chat observer reads: the panel's composer in each shape the table names
 * (`chatInput` and its other `chatInput…` entries), of which `shownComposer` is the one shown (`null` for none), and the
 * panel's message elements. With `inFrame` the composer and the messages are in a frame the page embeds, as a Google
 * Chat conversation's panel draws them, and the main frame holds neither.
 */
function fakeChatPage(messages: FakeMessage[], table: Record<string, string> & { chatInput: string; chatMessages: string; chatMessageSender: string; chatMessageText: string }, shownComposer: string | null = table.chatInput, inFrame = false) {
  // an element read by its selector: a missing one fails its read, as a Playwright read that waits out its timeout does
  const element = (text: string | undefined) => ({
    first() {
      return this;
    },
    async innerText(): Promise<string> {
      if (text === undefined) throw new Error('timeout waiting for the element');
      return text;
    },
  });
  const node = (message: FakeMessage) => ({
    async evaluate<T>(fn: (el: { getAttribute(name: string): string | null }, attribute: string) => T, attribute: string): Promise<T> {
      return fn({ getAttribute: (name) => (name === attribute ? message.id : null) }, attribute);
    },
    locator(selector: string) {
      if (selector === table.chatMessageSender) return element(message.sender);
      if (selector === table.chatMessageText) return element(message.body);
      throw new Error(`no fake for ${selector}`);
    },
    async innerText(): Promise<string> {
      return message.whole;
    },
  });
  const composers = Object.entries(table).filter(([name]) => name.startsWith('chatInput')).map(([, selector]) => selector);
  const panel = (selector: string) => {
    if (composers.includes(selector)) return { first: () => ({ isVisible: async () => selector === shownComposer }) };
    if (selector === table.chatMessages) return { all: async () => messages.map(node) };
    throw new Error(`no fake for ${selector}`);
  };
  const empty = (selector: string) => {
    if (composers.includes(selector)) return { first: () => ({ isVisible: async () => false }) };
    if (selector === table.chatMessages) return { all: async () => [] };
    throw new Error(`no fake for ${selector}`);
  };
  const main = fakeFrame('https://meet.google.com/abc-defg-hij', inFrame ? empty : panel);
  const frames = inFrame ? [main, fakeFrame('https://chat.google.com/embed/space/AAAA?hl=en', panel)] : [main];
  return { locator: main.locator, mainFrame: () => main, frames: () => frames };
}

/** One element of a fake Meet page: whether it shows, the text it holds, what happens when it is clicked or typed into, and what the adapter did to it. */
interface FakeElement {
  name: string;
  shown: () => boolean;
  text: string;
  editable: boolean;
  blocked: boolean;
  /** Whether the element refuses the text typed into it, or the key pressed on it, as an element a Playwright action waits out does. */
  refusesFill: boolean;
  refusesPress: boolean;
  onClick?: () => void;
  onPress?: (key: string) => void;
  clicks: number;
  fills: string[];
  presses: string[];
}

const fakeElement = (name: string, more: Partial<FakeElement> = {}): FakeElement => ({ name, shown: () => true, text: '', editable: false, blocked: false, refusesFill: false, refusesPress: false, clicks: 0, fills: [], presses: [], ...more });

/** What Playwright throws when an action or a wait runs out of time. */
const timeoutError = () => Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' });

/**
 * As much of a Playwright locator as the Meet adapter's chat posting uses, over the elements a selector finds. Like
 * Playwright's, it resolves its elements at each action, never when it is made, so a message posted after the locator
 * was made is found by it.
 */
function fakeLocator(resolve: () => FakeElement[], journal: string[]) {
  const first = () => resolve()[0];
  return {
    first: () => fakeLocator(() => resolve().slice(0, 1), journal),
    isVisible: async () => first()?.shown() ?? false,
    count: async () => resolve().length,
    all: async () => resolve().map((element) => fakeLocator(() => [element], journal)),
    filter: ({ hasText }: { hasText: string }) => fakeLocator(() => resolve().filter((element) => element.text.includes(hasText)), journal),
    async click() {
      const element = first();
      if (!element?.shown() || element.blocked) throw timeoutError(); // a key under a dialog never takes the click
      element.clicks += 1;
      journal.push(`click ${element.name}`);
      element.onClick?.();
    },
    async fill(text: string) {
      const element = first();
      if (!element?.shown() || element.refusesFill) throw timeoutError();
      element.fills.push(text);
      element.text = text;
    },
    async press(key: string) {
      const element = first();
      if (!element?.shown() || element.refusesPress) throw timeoutError();
      element.presses.push(key);
      element.onPress?.(key);
    },
    // the wait the read was given goes in the journal: a read given none waits for a missing element without limit
    async evaluate<T>(fn: (el: { value?: unknown; textContent: string | null }) => T, _arg?: unknown, options?: { timeout?: number }): Promise<T> {
      const element = first();
      if (!element) throw timeoutError();
      journal.push(`read ${element.name} within ${options?.timeout ?? 'no limit'}`);
      return fn(element.editable ? { textContent: element.text } : { value: element.text, textContent: element.text });
    },
  };
}

type MeetSelector = keyof typeof MEET_SELECTORS;
type Present = Partial<Record<MeetSelector, FakeElement[]>>;

/** A frame of a fake Meet page: its host, the elements each of the table's selectors finds in it, and the tree its outline reads. */
interface FramePresent {
  url: string;
  present: Present;
  root?: ElementLike;
  /** A frame whose reads never answer, as one between documents. */
  silent?: boolean;
}

/**
 * A fake Meet page in the call: the elements each of the table's selectors finds in its main frame, the keyboard, and
 * the frames the page embeds, each with its own elements. Any other selector of the table finds nothing. With
 * `mainSilent` the main frame's outline read never answers.
 */
function fakeMeetPage(present: Present, onKey: (key: string) => void = () => undefined, embedded: FramePresent[] = [], root?: ElementLike, mainSilent = false) {
  const journal: string[] = [];
  const locatorsOf = (elements: Present) => {
    const bySelector = new Map<string, FakeElement[]>();
    for (const [name, found] of Object.entries(elements)) bySelector.set(MEET_SELECTORS[name as MeetSelector], found ?? []);
    return (selector: string) => {
      if (!bySelector.has(selector) && !Object.values(MEET_SELECTORS).includes(selector)) throw new Error(`no fake for ${selector}`);
      return fakeLocator(() => bySelector.get(selector) ?? [], journal);
    };
  };
  const main = fakeFrame('https://meet.google.com/abc-defg-hij', locatorsOf(present), root, mainSilent);
  const frames = [main, ...embedded.map((frame) => fakeFrame(frame.url, locatorsOf(frame.present), frame.root, frame.silent))];
  const page = {
    journal,
    locator: main.locator,
    mainFrame: () => main,
    frames: () => frames,
    keyboard: {
      async press(key: string) {
        journal.push(`press ${key}`);
        onKey(key);
      },
    },
  };
  return page as typeof page & Page;
}

/** How a fake call behaves: which composer shape it draws and where, whether it has a Chat key and whether that key takes the click, whether Enter sends, whether the shortcut opens the panel. */
interface CallOptions {
  composer: 'chatInput' | 'chatInputLegacy' | 'chatInputEditable';
  composerShows?: boolean;
  /** The composer, the messages and the Send key in a frame the panel embeds, as a Google Chat conversation's panel draws them. */
  inFrame?: boolean;
  key?: 'chatButton' | 'chatButtonLegacy' | null;
  keyBlocked?: boolean;
  sends?: boolean;
  shortcutOpens?: boolean;
  tip?: boolean;
  sendKey?: boolean;
  /** A text already among the panel's messages before the post: the bot's own notice after a rejoin, say. */
  preposted?: string;
  /** Which of the composer's actions the element refuses. */
  refuses?: 'fill' | 'press';
  /** The trees the outline reads, in the main frame and in the embedded frame. */
  roots?: { main?: ElementLike; frame?: ElementLike };
}

/**
 * A call whose chat panel opens on its key or on the shortcut: the composer shows once the panel is open, and a sent text
 * appears among the panel's messages, which are the messages the observer reads (`chatMessages`): the bot reads its own
 * message back from those alone, so a notice confirmed is one the observer can read beside.
 */
function callWithChat({ composer, composerShows = true, inFrame = false, key = 'chatButton', keyBlocked = false, sends = true, shortcutOpens = false, tip = false, sendKey = false, preposted, refuses, roots }: CallOptions) {
  const state = { open: false };
  const messages: FakeElement[] = preposted === undefined ? [] : [fakeElement('message', { text: preposted })];
  const post = (input: FakeElement) => {
    messages.push(fakeElement('message', { text: input.text }));
    input.text = '';
  };
  const input = fakeElement('composer', {
    shown: () => state.open && composerShows,
    editable: composer !== 'chatInputLegacy',
    refusesFill: refuses === 'fill',
    refusesPress: refuses === 'press',
    onPress: (pressed) => {
      if (pressed === 'Enter' && sends) post(input);
    },
  });
  const button = fakeElement('key', { blocked: keyBlocked, onClick: () => { state.open = true; } });
  const send = fakeElement('send', { shown: () => state.open, onClick: () => post(input) });
  const panel: Present = { chatMessages: messages };
  panel[composer] = [input];
  if (sendKey) panel.chatSendButton = [send];
  const main: Present = inFrame ? {} : panel;
  if (key) main[key] = [button];
  if (tip) main.dismissButton = [fakeElement('tip')];
  const embedded: FramePresent[] = inFrame ? [{ url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: panel, root: roots?.frame }] : [];
  const page = fakeMeetPage(main, (pressed) => {
    if (pressed === 'Control+Alt+c' && shortcutOpens) state.open = true;
  }, embedded, roots?.main);
  return { page, input, button, send, messages };
}

const NOTICE = 'A notetaker joined this call for its host. Type stop taking notes in the chat and it leaves.';

describe("the Google Meet adapter's posting of a message", () => {
  // the fake page answers at once, so the waits that bound each step may be short
  const timing = { ...MEET_CHAT_TIMING };
  beforeAll(() => {
    Object.assign(MEET_CHAT_TIMING, { stepMs: 40, shortcutMs: 40, echoMs: 40, pollMs: 2 });
  });
  afterAll(() => {
    Object.assign(MEET_CHAT_TIMING, timing);
  });

  // the nightly check's Meet run of 24 October 2026: the panel opened on its key and held Google Chat's editable, no
  // textarea, and the adapter's fill waited out Playwright's thirty seconds for a textarea that never came
  for (const [shape, composer] of [['a textbox named for the chat', 'chatInput'], ['the textarea', 'chatInputLegacy'], ['the editable by its shape', 'chatInputEditable']] as const) {
    it(`opens the panel on its key, types into ${shape} and reads the message back`, async () => {
      const { page, input, button, messages } = callWithChat({ composer });
      await googleMeetAdapter.postChat(page, NOTICE);
      expect(button.clicks).toBe(1);
      expect(input.fills).toEqual([NOTICE]);
      expect(input.presses).toEqual(['Enter']);
      expect(messages.map((m) => m.text)).toEqual([NOTICE]);
      expect(page.journal).not.toContain('press Control+Alt+c');
    });
  }

  // the nightly check's Meet run of 25 October 2026 (40152692677): the panel opened on its key and no composer was found
  // by any lookup, since a Google Chat conversation's panel draws its composer in a frame it embeds, where a page-level
  // locator never looks (a page's locator is its main frame's)
  for (const [shape, composer] of [['a textbox named for the chat', 'chatInput'], ['the editable by its shape', 'chatInputEditable']] as const) {
    it(`finds ${shape} in a frame the panel embeds, types into it and reads the message back from that frame`, async () => {
      const { page, input, button, messages } = callWithChat({ composer, inFrame: true });
      await googleMeetAdapter.postChat(page, NOTICE);
      expect(button.clicks).toBe(1);
      expect(input.fills).toEqual([NOTICE]);
      expect(messages.map((m) => m.text)).toEqual([NOTICE]);
      expect(page.journal).not.toContain('press Control+Alt+c');
    });
  }

  it("presses the Send key in the composer's frame when Enter leaves the message there", async () => {
    const { page, send, messages } = callWithChat({ composer: 'chatInput', inFrame: true, sends: false, sendKey: true });
    await googleMeetAdapter.postChat(page, NOTICE);
    expect(send.clicks).toBe(1);
    expect(messages.map((m) => m.text)).toEqual([NOTICE]);
  });

  it('finds the key by its markup when its role and name are not read', async () => {
    const { page, button, messages } = callWithChat({ composer: 'chatInputLegacy', key: 'chatButtonLegacy' });
    await googleMeetAdapter.postChat(page, NOTICE);
    expect(button.clicks).toBe(1);
    expect(messages.map((m) => m.text)).toEqual([NOTICE]);
  });

  it('closes a tip laid over the call before it presses the key', async () => {
    const { page } = callWithChat({ composer: 'chatInput', tip: true });
    await googleMeetAdapter.postChat(page, NOTICE);
    expect(page.journal.slice(0, 2)).toEqual(['click tip', 'click key']);
  });

  it('opens the panel with the keyboard shortcut when the key is under a dialog, and when there is no key', async () => {
    for (const options of [{ keyBlocked: true }, { key: null }] as const) {
      const { page, messages } = callWithChat({ composer: 'chatInput', shortcutOpens: true, ...options });
      await googleMeetAdapter.postChat(page, NOTICE);
      expect(page.journal).toContain('press Control+Alt+c');
      expect(messages.map((m) => m.text)).toEqual([NOTICE]);
    }
  });

  it('presses the Send key once when Enter leaves the message in the composer, reading the composer within the step\'s wait', async () => {
    const { page, send, messages } = callWithChat({ composer: 'chatInput', sends: false, sendKey: true });
    await googleMeetAdapter.postChat(page, NOTICE);
    expect(send.clicks).toBe(1);
    expect(messages.map((m) => m.text)).toEqual([NOTICE]);
    expect(page.journal).toContain(`read composer within ${MEET_CHAT_TIMING.stepMs}`);
  });

  // the bot's own notice can sit in the panel from before, after a rejoin: a message it did not just send stands for nothing
  it('reads its message back as a new message, never as one the panel already held', async () => {
    const stale = callWithChat({ composer: 'chatInput', sends: false, preposted: NOTICE });
    await expect(googleMeetAdapter.postChat(stale.page, NOTICE)).rejects.toThrow('chat_echo_missing');
    const again = callWithChat({ composer: 'chatInput', preposted: NOTICE });
    await googleMeetAdapter.postChat(again.page, NOTICE);
    expect(again.messages.map((m) => m.text)).toEqual([NOTICE, NOTICE]);
  });

  it('names the step that failed, in a code the run reports', async () => {
    const cases: Array<[string, CallOptions]> = [
      ['chat_input_missing', { composer: 'chatInput', composerShows: false }],
      ['chat_input_missing', { composer: 'chatInput', composerShows: false, inFrame: true }],
      ['chat_button_missing', { composer: 'chatInput', key: null }],
      ['chat_button_blocked', { composer: 'chatInput', keyBlocked: true }],
      ['chat_input_blocked', { composer: 'chatInputEditable', refuses: 'fill' }],
      ['chat_enter_blocked', { composer: 'chatInputEditable', refuses: 'press' }],
      ['chat_echo_missing', { composer: 'chatInput', sends: false }],
      ['chat_echo_missing', { composer: 'chatInput', sends: false, inFrame: true }],
    ];
    for (const [code, options] of cases) {
      const { page } = callWithChat(options);
      await expect(googleMeetAdapter.postChat(page, NOTICE), code).rejects.toThrow(code);
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/); // the shape errorCode passes through to the report unchanged
    }
  });

  // the next failure explains itself: the error of a failed step carries the panel's outline, frame by frame, and the
  // lookups the step tried, in the record line's alphabet
  it("carries the panel's outline with the step's code, naming each frame by its host and the lookups it tried", async () => {
    const { el } = fakeTree();
    const main = el('body', {}, [el('button', { 'aria-label': 'Chat with everyone' }), el('div', { 'data-participant-id': 'p1' }, ['Participant 1'])]);
    const frame = el('body', {}, [el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }), el('button', { 'aria-label': 'Send message' })]);
    const { page } = callWithChat({ composer: 'chatInput', composerShows: false, inFrame: true, roots: { main, frame } });
    const failure = await googleMeetAdapter.postChat(page, NOTICE).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ChatStepError);
    const { outline } = failure as ChatStepError;
    expect(outline).toMatch(/^panel: frames=2; f1 meet\.google\.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0; f2 chat\.google\.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 names=History is on\|Send message; tried=composer:role,textarea,editable$/);
    expect(outline).toMatch(RECORD_LINE);
    expect(outline).not.toContain('Participant');
    expect(outlineOf(failure)).toBe(`; ${outline}`);
    // the shortcut's way names its own lookups
    const noKey = await googleMeetAdapter.postChat(callWithChat({ composer: 'chatInput', key: null }).page, NOTICE).catch((err: unknown) => err);
    expect((noKey as ChatStepError).outline).toMatch(/; tried=key:role,markup shortcut composer:role,textarea,editable$/);
  });
});

describe("the chat observers' reading of a message", () => {
  for (const [platform, adapter, table] of [['Google Meet', googleMeetAdapter, MEET_SELECTORS], ['Microsoft Teams', microsoftTeamsAdapter, TEAMS_SELECTORS]] as const) {
    it(`reads a message from its body element, and one whose element has no body element from the whole element, marked as such (${platform})`, async () => {
      const read: ChatMessage[] = [];
      const page = fakeChatPage([
        { id: 'm1', sender: 'Sam', body: 'Stop taking notes!', whole: 'Sam\n10:32\nStop taking notes!' },
        { id: 'm2', sender: 'Sam', whole: 'Sam\n10:33\nStop taking notes!' },
      ], table);
      const observer = await adapter.observeChat(page as unknown as Parameters<typeof adapter.observeChat>[0], (message) => read.push(message));
      observer.stop();
      expect(read).toEqual([
        { sender: 'Sam', text: 'Stop taking notes!', bodyRead: true },
        { sender: 'Sam', text: 'Sam\n10:33\nStop taking notes!', bodyRead: false },
      ]);
      expect(observer.lastGoodPollAt()).toBeTypeOf('number');
    });
  }

  // the Meet observer reads the panel as open through any composer shape the adapter knows, and reads nothing through
  // none: a closed panel's messages can sit in the page with nobody reading new ones
  it("reads the Meet panel through Google Chat's editable alone, and refuses a panel that shows no composer", async () => {
    const messages: FakeMessage[] = [{ id: 'm1', sender: 'Sam', body: 'hello', whole: 'Sam\n10:32\nhello' }];
    const read: ChatMessage[] = [];
    const editable = fakeChatPage(messages, MEET_SELECTORS, MEET_SELECTORS.chatInputEditable);
    const observer = await googleMeetAdapter.observeChat(editable as unknown as Page, (message) => read.push(message));
    observer.stop();
    expect(read.map((message) => message.text)).toEqual(['hello']);
    const closed = fakeChatPage(messages, MEET_SELECTORS, null);
    await expect(googleMeetAdapter.observeChat(closed as unknown as Page, () => undefined)).rejects.toThrow('chat_panel_closed');
  });

  // a Google Chat conversation's panel draws its messages in the frame that holds its composer: the observer reads the
  // frame the composer is in, so the stop phrase typed there is heard
  it("reads the Meet panel's messages from the frame its composer is in", async () => {
    const messages: FakeMessage[] = [{ id: 'spaces/AAAA/messages/BBBB', sender: 'Sam', body: 'stop taking notes', whole: 'Sam\n10:32\nstop taking notes' }];
    const read: ChatMessage[] = [];
    const page = fakeChatPage(messages, MEET_SELECTORS, MEET_SELECTORS.chatInput, true);
    const observer = await googleMeetAdapter.observeChat(page as unknown as Page, (message) => read.push(message));
    observer.stop();
    expect(read).toEqual([{ sender: 'Sam', text: 'stop taking notes', bodyRead: true }]);
    const closed = fakeChatPage(messages, MEET_SELECTORS, null, true);
    await expect(googleMeetAdapter.observeChat(closed as unknown as Page, () => undefined)).rejects.toThrow('chat_panel_closed');
  });
});

/** A node of a fake tree: the members the outline reads, with `hidden` for a node drawn without a box. */
interface FakeNode extends ElementLike {
  children: FakeNode[];
  parentElement: FakeNode | null;
  hidden: boolean;
}

/** A fake document: `el` makes a node with its attributes and its children (strings are text), and the document finds nodes by id. */
function fakeTree() {
  const byId = new Map<string, FakeNode>();
  const document = { getElementById: (id: string) => byId.get(id) ?? null };
  const el = (tagName: string, attrs: Record<string, string> = {}, children: Array<FakeNode | string> = [], { hidden = false } = {}): FakeNode => {
    const texts: string[] = [];
    const node: FakeNode = {
      tagName,
      children: [],
      parentElement: null,
      hidden,
      ownerDocument: document,
      get textContent() {
        return [...texts, ...node.children.map((child) => child.textContent ?? '')].join('');
      },
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      hasAttribute: (name) => name in attrs,
      getClientRects() {
        for (let p: FakeNode | null = node; p; p = p.parentElement) if (p.hidden) return [];
        return [{}];
      },
    };
    for (const child of children) {
      if (typeof child === 'string') texts.push(child);
      else {
        child.parentElement = node;
        node.children.push(child);
      }
    }
    if (attrs.id) byId.set(attrs.id, node);
    return node;
  };
  return { el, document };
}

describe("the chat panel's outline", () => {
  const limits = { buttonNames: true, maxRawNames: 60, maxElements: 30_000 };
  const COUNTS_NONE = { textbox: 0, combobox: 0, button: 0, menuitem: 0, editable: 0, listitem: 0, messageid: 0 };

  /** The fixture page in the call, with its chat panel open on a Google Chat conversation's shape, its tiles and a message drawn. */
  function callPage() {
    const { el } = fakeTree();
    return el('body', {}, [
      el('section', { id: 'prejoin' }, [el('input', { 'aria-label': 'Your name' })], { hidden: true }),
      el('section', { id: 'call' }, [
        el('div', { id: 'grid' }, [el('div', { 'data-self-name': 'Notetaker (test)' }, ['Notetaker (test)']), el('div', { 'data-participant-id': 'p1' }, ['Participant 1'])]),
        el('button', { 'aria-label': 'People' }, [el('div', { class: 'count' }, ['2'])]),
        el('button', { 'aria-label': 'Chat with everyone' }, ['Chat']),
        el('div', { id: 'people' }, [el('button', {}, ['Mute Participant 1'])]),
        el('div', { id: 'chat' }, [
          el('div', { role: 'list', 'aria-label': 'In-call messages' }, [
            el('div', { role: 'listitem', 'data-message-id': 'm1' }, [
              el('div', { 'data-sender-name': 'Sam' }, ['Sam']),
              el('div', { 'data-message-text': '' }, ['hello everyone, the address is sam at example dot com']),
              el('button', { 'aria-label': 'Pin message from Sam' }),
            ]),
          ]),
          el('div', { role: 'combobox', 'aria-label': 'Ask Gemini' }),
          el('div', { role: 'textbox', contenteditable: '', 'aria-multiline': 'true', 'aria-label': 'History is on' }),
          el('div', { contenteditable: 'true' }),
          el('textarea', { 'aria-label': 'Send a message' }, [], { hidden: true }),
          el('button', { 'aria-labelledby': 'send-label' }),
          el('span', { id: 'send-label' }, ['Send message']),
          el('div', { role: 'menuitem' }, ['Emoji & more / tools']),
        ]),
        el('button', { 'aria-label': 'Leave call' }, ['Leave']),
      ]),
    ]);
  }

  it('counts the drawn controls by role, the editables, the list items and the message ids, and names the composer-shaped controls and the buttons of the frame, never a menu item', () => {
    const scan = collectFrameOutline({ ...limits, root: callPage() });
    expect(scan.counts).toEqual({ textbox: 1, combobox: 1, button: 6, menuitem: 1, editable: 2, listitem: 1, messageid: 1 });
    expect(scan.truncated).toBe(false);
    // the names in document order: a hidden control, a control inside a message, an editable with no name and a menu
    // item (no lookup targets one, and a menu may list people) give none
    expect(scan.names).toEqual(['People', 'Chat with everyone', 'Mute Participant 1', 'Ask Gemini', 'History is on', 'Send message', 'Leave call']);
    // the texts a name must not quote, kept apart from the names, and among them the participants' names, matched by their words too
    expect(scan.roster).toEqual(expect.arrayContaining(['Notetaker (test)', 'Participant 1', 'Sam', 'hello everyone, the address is sam at example dot com']));
    expect(scan.people).toEqual(expect.arrayContaining(['Notetaker (test)', 'Participant 1', 'Sam']));
    expect(scan.people).not.toContain('hello everyone, the address is sam at example dot com');
  });

  it('names no button of the main frame, whose tiles and lists carry the participants on their controls', () => {
    const scan = collectFrameOutline({ ...limits, buttonNames: false, root: callPage() });
    expect(scan.names).toEqual(['Ask Gemini', 'History is on']);
    expect(scan.counts.button).toBe(6);
  });

  it('stops at its element limit and says so', () => {
    const scan = collectFrameOutline({ ...limits, maxElements: 3, root: callPage() });
    expect(scan.truncated).toBe(true);
    expect(frameLine(1, 'meet.google.com', scan, [])).toContain(' partial');
  });

  it("writes a frame's line in the record line's alphabet, dropping a name that quotes a tile, a sender or a message", () => {
    const scan = collectFrameOutline({ ...limits, root: callPage() });
    const roster = scan.roster.map((entry) => entry.replace(/\s+/g, ' ').trim().toLowerCase());
    const line = frameLine(2, 'chat.google.com', scan, roster);
    expect(line).toBe('f2 chat.google.com textbox=1 combobox=1 button=6 menuitem=1 editable=2 listitem=1 messageid=1 names=People|Chat with everyone|Ask Gemini|History is on|Send message|Leave call');
    expect(line).toMatch(RECORD_LINE);
    for (const quoted of ['Sam', 'hello', 'example', 'Participant', 'Notetaker', 'Pin', 'Emoji', '/']) expect(line).not.toContain(quoted);
    expect(frameLine(1, 'meet.google.com', undefined, roster)).toBe('f1 meet.google.com unread');
  });

  // a participant's name is compared as a name is cut, so a spelling with marks still matches, and one word of the name
  // is enough; an address or a link is dropped before the cut could respell it
  it("drops a name that quotes a participant's name in another spelling or by one of its words, and one that holds an address or a link", () => {
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 5 }, names: ["Reply to O'Reilly", 'Message Alice', 'alice@example.com', 'Open https://example.com/x', 'Send message'], roster: ["O'Reilly", 'Alice Smith'], people: ['Alice Smith'], truncated: false };
    expect(rosterTerms(scan.roster, scan.people)).toEqual(expect.arrayContaining(['oreilly', 'alice smith', 'alice', 'smith']));
    // the roster as the outline passes it, and as a frame's own entries folded alone
    for (const roster of [rosterTerms(scan.roster, scan.people), ["o'reilly", 'alice smith', 'alice']]) {
      const line = frameLine(2, 'chat.google.com', scan, roster);
      expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=5 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
    }
  });

  // a dozen controls quoting a participant must not use up the names a frame may give: the filter runs before the cut
  it('keeps a safe name after a dozen that quoted a participant, reading more names than it keeps', () => {
    const { el } = fakeTree();
    const people = Array.from({ length: 13 }, (_, i) => `Participant ${i + 1}`);
    const root = el('body', {}, [
      ...people.map((name, i) => el('div', { 'data-participant-id': `p${i + 1}` }, [name])),
      ...people.map((name) => el('button', { 'aria-label': `Mute ${name}` })),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    expect(scan.names).toHaveLength(14);
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=0 combobox=0 button=14 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
    // twelve names at most, after the filter
    const many: FrameScan = { ...scan, names: Array.from({ length: 20 }, (_, i) => `Key ${i + 1}`) };
    expect(frameLine(2, 'chat.google.com', many, []).match(/names=(.*)$/)?.[1]?.split('|')).toHaveLength(12);
  });

  // a reading cut short at its element limit may hold the names and not yet the texts they must not quote, and so may a
  // page whose main frame, which holds the tiles, went unread: the names are then withheld in every frame
  it("withholds the names when a frame's reading was cut short or the main frame went unread", async () => {
    const cut: FrameScan = { counts: { ...COUNTS_NONE, textbox: 1 }, names: ['Message Alice'], roster: [], people: [], truncated: true };
    expect(frameLine(1, 'meet.google.com', cut, [])).toBe('f1 meet.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 partial names=withheld');
    const whole: FrameScan = { ...cut, truncated: false };
    expect(frameLine(2, 'chat.google.com', whole, [], false)).toBe('f2 chat.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 names=withheld');
    expect(frameLine(2, 'chat.google.com', { ...whole, names: [] }, [], false)).toBe('f2 chat.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0');
    // through the page: the main frame's walk stops before the tile that names Alice, so neither frame names anything
    const { el } = fakeTree();
    const main = el('body', {}, [el('div', { role: 'textbox', 'aria-label': 'Message Alice' }), el('div', {}), el('div', { 'data-participant-id': 'p1' }, ['Alice'])]);
    const chat = el('body', {}, [el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }), el('button', { 'aria-label': 'Reply to Alice' })]);
    const embedded = [{ url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat }];
    const { maxElements } = OUTLINE_LIMITS;
    OUTLINE_LIMITS.maxElements = 3;
    try {
      const outline = await panelOutline(fakeMeetPage({}, undefined, embedded, main), 'composer:role,textarea,editable', 200);
      expect(outline).toBe('panel: frames=2; f1 meet.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 partial names=withheld; f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 names=withheld; tried=composer:role,textarea,editable');
      expect(outline).not.toContain('Alice');
    } finally {
      OUTLINE_LIMITS.maxElements = maxElements;
    }
    // the main frame unread: the tiles are unread with it
    const unread = await panelOutline(fakeMeetPage({}, undefined, embedded, undefined, true), 'composer:role,textarea,editable', 100);
    expect(unread).toBe('panel: frames=2; f1 meet.google.com unread; f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 names=withheld; tried=composer:role,textarea,editable');
  });

  // a link in a name need not announce itself with a scheme or `www.`: a bare host, with a path after it (a link
  // preview's key, titled with its address) or alone, is a link, and the cut would keep the host's and the path's words
  it('drops a name that holds a bare host, with a path after it or alone, as it drops one with a scheme', () => {
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 4 }, names: ['Open docs.example.com/q3-plan', 'Open example.com', 'Open https://example.com/x', 'Send message'], roster: [], people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, [])).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // a protocol-relative link (`//host/path`) has no scheme either, and a scheme without slashes (`tel:`, `mailto:`) no `//`
  it('drops a name that holds a protocol-relative link, and one that holds a scheme without slashes', () => {
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 3 }, names: ['//files.example.com/private/report', 'Call tel:+15551234567', 'Send message'], roster: [], people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, [])).toBe('f2 chat.google.com textbox=0 combobox=0 button=3 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // a name is tested whole, before any cut: an address past the fortieth character still drops it
  it('tests a name for an address or a link before it is cut, so an address past the fortieth character drops the name', () => {
    const { el } = fakeTree();
    const root = el('body', {}, [el('button', { 'aria-label': 'Share the recording with the whole team at someone@example.com' }), el('button', { 'aria-label': 'Send message' })]);
    const scan = collectFrameOutline({ ...limits, root });
    const line = frameLine(2, 'chat.google.com', scan, []);
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=2 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
    expect(line).not.toContain('Share the recording');
  });

  // a message is compared whole: a name quoting its text past the eightieth character is dropped as one quoting its
  // first words is, whether the text is the element's content or the value of its data-message-text attribute
  it("drops a name that quotes a message's text past its eightieth character", () => {
    const { el } = fakeTree();
    const message = 'hello everyone, before we start: the recording and the slides of this call will be in the shared drive folder named Q3 planning, please keep them inside the team';
    expect(message.indexOf('shared drive folder')).toBeGreaterThan(80);
    const root = el('body', {}, [
      el('div', { role: 'listitem', 'data-message-id': 'm1' }, [el('div', { 'data-sender-name': 'Sam' }, ['Sam']), el('div', { 'data-message-text': '' }, [message])]),
      el('div', { role: 'listitem', 'data-message-id': 'm2' }, [el('div', { 'data-message-text': 'the slides are at the usual place' })]),
      el('button', { 'aria-label': 'shared drive folder named Q3 planning' }),
      el('button', { 'aria-label': 'the slides are at the usual place' }),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=3 menuitem=0 editable=0 listitem=2 messageid=2 names=Send message');
  });

  // a message longer than a shown name may be is still a text no name may quote, whole or in part
  it('drops a name that quotes a message longer than forty characters, whole or in part', () => {
    const message = 'please send the invoice for the consulting work to accounting before friday';
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 3 }, names: [message, 'invoice for the consulting work', 'Send message'], roster: [message], people: [], truncated: false };
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=3 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // a name that quotes a part of a message with words of its own around it neither holds the message whole nor sits
  // inside it: a run of three of the message's words in it is a quote too, whatever marks the name puts between them,
  // and a run of two is not
  it('drops a name that shares a run of three words with a message, and keeps one that shares fewer', () => {
    const message = 'the budget is in the shared folder, see you after the call';
    expect(rosterTerms([message])).toEqual(expect.arrayContaining(['the budget is', 'shared folder see', 'after the call']));
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 5 }, names: ['Replying to Al: the budget is in the shared folder', 'Open the shared folder now', 'Open the, shared, folder', 'Send a message to the call', 'Send message'], roster: [message], people: [], truncated: false };
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=5 menuitem=0 editable=0 listitem=0 messageid=0 names=Send a message to the call|Send message');
    expect(line).not.toContain('budget');
  });

  // an address of four numbers has no top-level label: a name that holds one, with a port or a path after it or alone, is a link too
  it('drops a name that holds an IPv4 address, with or without a port or a path', () => {
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 4 }, names: ['Open 192.168.0.50/admin', 'Open 10.0.0.1:8080', 'Ping 10.0.0.1', 'Send message'], roster: [], people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, [])).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // a frame that went unread may be the chat's, whose messages' texts then reach no roster: the names are withheld in
  // every frame, as they are when the main frame went unread
  it("withholds the names when a frame the page embeds went unread, since the chat's texts may be in it", async () => {
    const { el } = fakeTree();
    const main = el('body', {}, [el('button', { 'aria-label': 'Chat with everyone' }), el('div', { 'data-participant-id': 'p1' }, ['Participant 1'])]);
    const chat = el('body', {}, [el('div', { role: 'listitem', 'data-message-id': 'm1' }, [el('div', { 'data-message-text': '' }, ['the budget is in the shared folder'])])]);
    const other = el('body', {}, [el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }), el('button', { 'aria-label': 'the budget is in the shared folder' })]);
    const page = fakeMeetPage({}, undefined, [
      { url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat, silent: true },
      { url: 'https://chat.google.com/embed/space/BBBB?hl=en', present: {}, root: other },
    ], main);
    const outline = await panelOutline(page, 'composer:role,textarea,editable', 200);
    expect(outline).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0; f2 chat.google.com unread; f3 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 names=withheld; tried=composer:role,textarea,editable');
    expect(outline).not.toContain('budget');
  });

  // the frames are read at once against one deadline: a frame that never answers (one between documents) holds up no
  // frame after it, whatever order the page lists them in; the names are withheld, since the texts they must not quote
  // may be in the frame that went unread
  it('reads the frames at once, so a frame that never answers holds up no frame after it', async () => {
    const { el } = fakeTree();
    const main = el('body', {}, [el('button', { 'aria-label': 'Chat with everyone' })]);
    const chat = el('body', {}, [el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }), el('button', { 'aria-label': 'Send message' })]);
    const page = fakeMeetPage({}, undefined, [
      { url: 'about:blank', present: {}, silent: true },
      { url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat },
    ], main);
    const started = Date.now();
    const outline = await panelOutline(page, 'composer:role,textarea,editable', 200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(outline).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0; f2 about:blank unread; f3 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 names=withheld; tried=composer:role,textarea,editable');
  });

  it('cuts a name to letters, digits, space and a few marks, and to its length', () => {
    expect(cleanName('Send a message to everyone ✈ /path?x=1&y=2')).toBe('Send a message to everyone pathx1y2');
    expect(cleanName('  Envoyer   un message à tous  ')).toBe('Envoyer un message à tous');
    expect(cleanName('x'.repeat(60))).toHaveLength(40);
    expect(cleanName('|;:=')).toBe('');
  });

  it('names a frame by its host alone, never its path or query', () => {
    expect(frameHost('https://chat.google.com/embed/space/AAAA/thread/BBBB?hl=en&token=x')).toBe('chat.google.com');
    expect(frameHost('https://MEET.google.com/abc-defg-hij')).toBe('meet.google.com');
    expect(frameHost('about:blank')).toBe('about:blank');
    expect(frameHost('about:srcdoc')).toBe('about:srcdoc');
    expect(frameHost('')).toBe('unparsable');
    expect(frameHost('not a url')).toBe('unparsable');
  });

  it('reads every frame of the page within its time, the main frame first, and writes an unanswering frame as unread', async () => {
    const { el } = fakeTree();
    const main = el('body', {}, [el('button', { 'aria-label': 'Chat with everyone' }), el('div', { 'data-participant-id': 'p1' }, ['Participant 1'])]);
    const chat = el('body', {}, [el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }), el('button', { 'aria-label': 'Hide Participant 1' }), el('button', { 'aria-label': 'Send message' })]);
    // every frame read: the main frame's tile drops the chat frame's name that quotes it
    const read = await panelOutline(fakeMeetPage({}, undefined, [
      { url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat },
      { url: 'about:blank', present: {}, root: el('body') },
    ], main), 'composer:role,textarea,editable', 200);
    expect(read).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0; f2 chat.google.com textbox=1 combobox=0 button=2 menuitem=0 editable=1 listitem=0 messageid=0 names=History is on|Send message; f3 about:blank textbox=0 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0; tried=composer:role,textarea,editable');
    expect(read).toMatch(RECORD_LINE);
    // a frame that never answers is written as unread, and the names are withheld with it: the texts they must not
    // quote may be in it
    const unread = await panelOutline(fakeMeetPage({}, undefined, [
      { url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat },
      { url: 'about:blank', present: {}, silent: true },
    ], main), 'composer:role,textarea,editable', 200);
    expect(unread).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0; f2 chat.google.com textbox=1 combobox=0 button=2 menuitem=0 editable=1 listitem=0 messageid=0 names=withheld; f3 about:blank unread; tried=composer:role,textarea,editable');
    expect(unread).toMatch(RECORD_LINE);
  });

  it('rides beside the code on a failed step and nowhere else', () => {
    const failed = new ChatStepError('chat_input_missing', 'panel: frames=1; f1 meet.google.com unread; tried=composer:role,textarea,editable');
    expect(failed.message).toBe('chat_input_missing');
    expect(outlineOf(failed)).toBe('; panel: frames=1; f1 meet.google.com unread; tried=composer:role,textarea,editable');
    expect(outlineOf(new ChatStepError('chat_echo_missing'))).toBe('');
    expect(outlineOf(new Error('TimeoutError'))).toBe('');
    expect(outlineOf('chat_input_missing')).toBe('');
  });
});
