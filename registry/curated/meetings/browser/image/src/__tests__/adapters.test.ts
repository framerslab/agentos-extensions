import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { fixtureAdapter } from '../adapters/fixture.js';
import { MEET_CHAT_TIMING, SELECTORS as MEET_SELECTORS, googleMeetAdapter } from '../adapters/google-meet.js';
import { SELECTORS as TEAMS_SELECTORS, microsoftTeamsAdapter } from '../adapters/microsoft-teams.js';
import { hostAllowed, requestAllowed } from '../network-policy.js';
import type { ChatMessage } from '../adapters/types.js';

const top = (url: string) => ({ url, topLevelNavigation: true });
const sub = (url: string) => ({ url, topLevelNavigation: false });

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
    expect(googleMeetAdapter.selectorsVersion >= '2026-10-24').toBe(true);
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

/**
 * As much of a Playwright page as an adapter's chat observer reads: the panel's composer in each shape the table names
 * (`chatInput` and its other `chatInput…` entries), of which `shownComposer` is the one shown (`null` for none), and the
 * panel's message elements.
 */
function fakeChatPage(messages: FakeMessage[], table: Record<string, string> & { chatInput: string; chatMessages: string; chatMessageSender: string; chatMessageText: string }, shownComposer: string | null = table.chatInput) {
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
  return {
    locator(selector: string) {
      if (composers.includes(selector)) return { first: () => ({ isVisible: async () => selector === shownComposer }) };
      if (selector === table.chatMessages) return { all: async () => messages.map(node) };
      throw new Error(`no fake for ${selector}`);
    },
  };
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

/** A fake Meet page in the call: the elements each of the table's selectors finds, and the keyboard. Any other selector of the table finds nothing. */
function fakeMeetPage(present: Partial<Record<MeetSelector, FakeElement[]>>, onKey: (key: string) => void = () => undefined) {
  const journal: string[] = [];
  const bySelector = new Map<string, FakeElement[]>();
  for (const [name, elements] of Object.entries(present)) bySelector.set(MEET_SELECTORS[name as MeetSelector], elements ?? []);
  const page = {
    journal,
    locator(selector: string) {
      if (!bySelector.has(selector) && !Object.values(MEET_SELECTORS).includes(selector)) throw new Error(`no fake for ${selector}`);
      return fakeLocator(() => bySelector.get(selector) ?? [], journal);
    },
    keyboard: {
      async press(key: string) {
        journal.push(`press ${key}`);
        onKey(key);
      },
    },
  };
  return page as typeof page & Page;
}

/** How a fake call behaves: which composer shape it draws, whether it has a Chat key and whether that key takes the click, whether Enter sends, whether the shortcut opens the panel. */
interface CallOptions {
  composer: 'chatInput' | 'chatInputLegacy' | 'chatInputEditable';
  composerShows?: boolean;
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
}

/**
 * A call whose chat panel opens on its key or on the shortcut: the composer shows once the panel is open, and a sent text
 * appears among the panel's messages, which are the messages the observer reads (`chatMessages`): the bot reads its own
 * message back from those alone, so a notice confirmed is one the observer can read beside.
 */
function callWithChat({ composer, composerShows = true, key = 'chatButton', keyBlocked = false, sends = true, shortcutOpens = false, tip = false, sendKey = false, preposted, refuses }: CallOptions) {
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
  const present: Partial<Record<MeetSelector, FakeElement[]>> = { chatMessages: messages };
  present[composer] = [input];
  if (key) present[key] = [button];
  if (tip) present.dismissButton = [fakeElement('tip')];
  if (sendKey) present.chatSendButton = [send];
  const page = fakeMeetPage(present, (pressed) => {
    if (pressed === 'Control+Alt+c' && shortcutOpens) state.open = true;
  });
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
      ['chat_button_missing', { composer: 'chatInput', key: null }],
      ['chat_button_blocked', { composer: 'chatInput', keyBlocked: true }],
      ['chat_input_blocked', { composer: 'chatInputEditable', refuses: 'fill' }],
      ['chat_enter_blocked', { composer: 'chatInputEditable', refuses: 'press' }],
      ['chat_echo_missing', { composer: 'chatInput', sends: false }],
    ];
    for (const [code, options] of cases) {
      const { page } = callWithChat(options);
      await expect(googleMeetAdapter.postChat(page, NOTICE), code).rejects.toThrow(code);
      expect(code).toMatch(/^[a-z][a-z0-9_]{0,63}$/); // the shape errorCode passes through to the report unchanged
    }
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
});
