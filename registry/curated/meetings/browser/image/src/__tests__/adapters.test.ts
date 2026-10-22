import { describe, expect, it } from 'vitest';
import { fixtureAdapter } from '../adapters/fixture.js';
import { SELECTORS as MEET_SELECTORS, googleMeetAdapter } from '../adapters/google-meet.js';
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

/** As much of a Playwright page as an adapter's chat observer reads: an open panel and its message elements. */
function fakeChatPage(messages: FakeMessage[], table: { chatInput: string; chatMessages: string; chatMessageSender: string; chatMessageText: string }) {
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
  return {
    locator(selector: string) {
      if (selector === table.chatInput) return { first: () => ({ isVisible: async () => true }) };
      if (selector === table.chatMessages) return { all: async () => messages.map(node) };
      throw new Error(`no fake for ${selector}`);
    },
  };
}

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
});
