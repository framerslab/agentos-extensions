import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright';
import { ChatStepError, LABEL_WORDS, OUTLINE_LIMITS, OUTLINE_MAX_LENGTH, cleanName, collectFrameOutline, frameHost, frameLine, outlineOf, panelOutline, rosterTerms, type ElementLike, type FrameScan } from '../adapters/chat-outline.js';
import { fixtureAdapter } from '../adapters/fixture.js';
import { MEET_CHAT_TIMING, SELECTORS as MEET_SELECTORS, googleMeetAdapter } from '../adapters/google-meet.js';
import { SELECTORS as TEAMS_SELECTORS, microsoftTeamsAdapter } from '../adapters/microsoft-teams.js';
import { hostAllowed, requestAllowed } from '../network-policy.js';
import type { ChatMessage } from '../adapters/types.js';

const top = (url: string) => ({ url, topLevelNavigation: true });
const sub = (url: string) => ({ url, topLevelNavigation: false });

/** The alphabet of the nightly check's record line (real-join.mjs, ERROR_LINE): an error report's message outside it is kept as `error`. */
const RECORD_LINE = /^[\p{L}\p{N}_.,:;=|() -]{1,2000}$/u;

/** The pattern of a Playwright `text=/…/flags` selector, to test the words it matches. */
function textPattern(selector: string): RegExp {
  const match = /^text=\/(.*)\/([a-z]*)$/.exec(selector);
  if (!match) throw new Error(`not a text pattern: ${selector}`);
  return new RegExp(match[1], match[2]);
}

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

  // the nightly check of 27 October 2026 found the composer under another label, disabled, in the side panel the Chat
  // key opens: the panel's composer is read by its shape and its place alone, every part of the lookup inside the side
  // panel (an aside, or the complementary role), never a field anywhere else on the page
  it("read the Meet panel's composer by its shape inside the side panel alone, whatever its label", () => {
    const parts = MEET_SELECTORS.chatInputInPanel.split(',').map((part) => part.trim());
    expect(parts.length).toBeGreaterThanOrEqual(2);
    for (const part of parts) expect(part).toMatch(/^(aside|\[role="complementary"\]) /);
    expect(googleMeetAdapter.selectorsVersion >= '2026-10-27').toBe(true);
  });

  // a Google Chat conversation draws a Pin key beside each message that carries the message's data-message-id too: read
  // as a message, it would take the message's place in the observer's memory of what it has read
  it("read a Meet message by the client's id for it, never the Pin key beside it that carries the same id", () => {
    expect(MEET_SELECTORS.chatMessages.split(',')[0].trim()).toBe('[data-message-id]:not(button):not([role="button"])');
  });

  // the client Microsoft served an anonymous guest on 30 October 2026 (teams.microsoft.com/light-meetings): the name
  // field carries its data-tid and a generated id; the lobby is the pre-join screen with the lobby's words, under
  // [data-tid="calling-lobby-screen"]; the call draws no [data-tid="calling-stage"], and its Leave key is
  // button#hangup-button, named by its title alone; a message's element ([data-tid="chat-pane-message"], the message's
  // id in its own id) holds the text in div#content-<id>, and the author's name sits beside it in the message's item
  it('read the Teams client an anonymous guest is served, as drawn on 30 October 2026', () => {
    expect(TEAMS_SELECTORS.nameInput.split(',').map((part) => part.trim())).toContain('[data-tid="prejoin-display-name-input"]');
    expect(TEAMS_SELECTORS.lobbyScreen).toBe('[data-tid="calling-lobby-screen"]');
    const lobby = textPattern(TEAMS_SELECTORS.lobbyText);
    expect(lobby.test('Hi, Sam. Someone will let you in when the meeting starts.')).toBe(true);
    expect(lobby.test('Someone in the meeting should let you in soon')).toBe(true);
    expect(lobby.test('Type your name')).toBe(false);
    expect(TEAMS_SELECTORS.callStage.split(',').map((part) => part.trim())).toContain('#hangup-button');
    expect(TEAMS_SELECTORS.leaveButton.split(',').map((part) => part.trim())).toContain('#hangup-button');
    expect(TEAMS_SELECTORS.chatMessages).toBe('[data-tid="chat-pane-message"]');
    expect(TEAMS_SELECTORS.chatMessageText.split(',').map((part) => part.trim())).toContain('[id^="content-"]');
    // the author is read from the message's item, never from the message's element, which does not hold it
    expect(TEAMS_SELECTORS.chatMessageSender).toMatch(/^xpath=ancestor::\*\[@data-tid="chat-pane-item"\]\[1\]\/\/\*\[@data-tid="message-author-name"\]$/);
    expect(microsoftTeamsAdapter.selectorsVersion >= '2026-10-30').toBe(true);
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

  // the nightly check's Teams runs of 29 and 30 October 2026 ended join_control_missing with two requests to
  // teams.public.onecdn.static.microsoft blocked: the launcher and the light-meetings client load their scripts from
  // Microsoft's static CDN, which the policy refused, so the client never drew its join controls. Microsoft's list of
  // Microsoft 365 URLs and IP address ranges names it required for every Microsoft 365 client: *.static.microsoft and
  // *.usercontent.microsoft (ID 193), and *.lync.com among the Teams hosts (ID 12)
  it("lets a Microsoft Teams page load Microsoft's static CDN and the other hosts Microsoft lists for Teams", () => {
    for (const url of [
      'https://teams.public.onecdn.static.microsoft/evergreen-assets/apps/light-meetings.js',
      'https://content.usercontent.microsoft/x.png',
      'https://webdir.online.lync.com/autodiscover',
      'https://teams.cloud.microsoft/trap-exp/tokens',
      'https://go.trouter.teams.microsoft.com/v4/c',
      'https://eu-ic3.events.data.microsoft.com/OneCollector/1.0/',
    ]) {
      expect({ url, allowed: requestAllowed(sub(url), microsoftTeamsAdapter).allowed }).toEqual({ url, allowed: true });
    }
    // a host that only ends like one, or one that only begins like one, stays refused
    expect(requestAllowed(sub('https://evilstatic.microsoft/x.js'), microsoftTeamsAdapter)).toEqual({ allowed: false, host: 'evilstatic.microsoft' });
    expect(requestAllowed(sub('https://static.microsoft.example.org/x.js'), microsoftTeamsAdapter).allowed).toBe(false);
    expect(requestAllowed(sub('https://evillync.com/x.js'), microsoftTeamsAdapter).allowed).toBe(false);
    // the top-level document stays on the join hosts
    expect(requestAllowed(top('https://teams.public.onecdn.static.microsoft/x.html'), microsoftTeamsAdapter).allowed).toBe(false);
  });

  // the nightly check's Teams runs of 31 October 2026 on the worker (41188631327, 41189018232) ended join: TimeoutError
  // with aadcdn.msauth.net blocked, while a run of the same image elsewhere joined: the launcher's look for a signed-in
  // user opens Microsoft's sign-in page in a frame, and that page loads its scripts and images from Microsoft's sign-in
  // CDN, which Microsoft's list of Microsoft 365 URLs and IP address ranges names required (ID 59: *.msauth.net,
  // *.msauthimages.net and *.msftauthimages.net, beside *.msftauth.net)
  it("lets a Microsoft Teams page load Microsoft's sign-in CDN, which the sign-in page a frame opens loads from", () => {
    for (const url of [
      'https://aadcdn.msauth.net/shared/1.0/content/js/ConvergedLogin_PCore.js',
      'https://aadcdn.msauthimages.net/c1c6b6c8-x/logintenantbranding/0/bannerlogo',
      'https://aadcdn.msftauthimages.net/dbd5a2dd-x/logintenantbranding/0/illustration',
      'https://aadcdn.msftauth.net/shared/1.0/content/images/microsoft_logo.svg',
    ]) {
      expect({ url, allowed: requestAllowed(sub(url), microsoftTeamsAdapter).allowed }).toEqual({ url, allowed: true });
    }
    // a host that only ends like one stays refused, and the top-level document stays on the join hosts
    expect(requestAllowed(sub('https://evilmsauth.net/x.js'), microsoftTeamsAdapter).allowed).toBe(false);
    expect(requestAllowed(top('https://aadcdn.msauth.net/x.html'), microsoftTeamsAdapter).allowed).toBe(false);
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

// the client an anonymous guest is served on 30 October 2026 writes the number of people on its People key, "2 People"
// with one other person in the call, and no number at all while the bot is alone in it
describe("the Microsoft Teams adapter's count of the others in the call", () => {
  /** A page whose People key reads `text`, or whose key cannot be read when `text` is undefined. */
  const pageWithKey = (text: string | undefined) =>
    ({
      locator: () => ({
        filter() {
          return this;
        },
        first() {
          return this;
        },
        async innerText(): Promise<string> {
          if (text === undefined) throw new Error('timeout waiting for the element');
          return text;
        },
      }),
    }) as unknown as Page;

  it('counts the people on the People key less the bot, reads the key with no number as the bot alone, and an unread key as unknown', async () => {
    expect(await microsoftTeamsAdapter.participantCount(pageWithKey('2 People'))).toBe(1);
    expect(await microsoftTeamsAdapter.participantCount(pageWithKey('12\nPeople'))).toBe(11);
    expect(await microsoftTeamsAdapter.participantCount(pageWithKey('People'))).toBe(0);
    // a key with no number that is not the People key's own word counts no one: it never reads as the bot alone, which
    // would make the bot leave a call that still has people in it
    expect(await microsoftTeamsAdapter.participantCount(pageWithKey('Invite people'))).toBeUndefined();
    // a key that could not be read, or one read with no words, is no count: it starts no alone timer
    expect(await microsoftTeamsAdapter.participantCount(pageWithKey(undefined))).toBeUndefined();
    expect(await microsoftTeamsAdapter.participantCount(pageWithKey(''))).toBeUndefined();
  });
});

// The client the bot image was served on 31 October 2026, read by a probe that ran the published image's adapter as a
// guest of the check's own meeting: it lays a dialog over the pre-join screen when it finds no microphone or camera, as
// in the bot's browser, whose backdrop took the click on Join now until Playwright's thirty seconds ran out (the nightly
// check's run 41147064773, "join: TimeoutError"); and it draws the bot's own message at once as "Sending...", which the
// chat service then takes and gives its time, or refuses ("Failed to send."), as it refused the guest's first message,
// a message that reached nobody while the adapter counted it posted.
describe('the Microsoft Teams adapter on the client served on 31 October 2026', () => {
  const T = TEAMS_SELECTORS as Record<string, string>;
  interface TeamsElement {
    name: string;
    shown: () => boolean;
    blocked?: () => boolean;
    text?: () => string;
    within?: (selector: string) => TeamsElement[];
    onClick?: () => void;
    onFill?: (text: string) => void;
    onPress?: (key: string) => void;
    /** What happens just after the adapter looks at the element. */
    afterLook?: () => void;
    /** The last line Playwright's call log writes for a click or a fill that cannot happen: what holds the element. */
    holds?: () => string | undefined;
  }
  interface TeamsLocator {
    resolve: () => TeamsElement[];
    /** A locator the page made: its selector and words, which a filter's `has` reads inside each element. */
    selector?: string;
    hasText?: string;
    [key: string]: unknown;
  }
  /**
   * A message in the chat: its words, its author, and the chat service's answer, which the page draws at `answerAt`; a
   * message drawn failed for a moment shows its time at `sentAt`.
   */
  interface TeamsItem {
    text: string;
    author: string;
    answer?: 'sent' | 'failed';
    answerAt: number;
    sentAt?: number;
  }

  /**
   * A Teams page as the adapter's locators read it: the pre-join screen under its device dialog, the lobby Join now
   * leads to, and the chat. The chat service refuses the first `refused` messages the bot sends and takes the rest,
   * answering each `answerMs` after it is sent. With `echo` a participant, Sam, posts the bot's words just before each
   * of the bot's messages is drawn, and Sam's message shows its time at once. With `dialogCloses` the device dialog
   * closes on its own just after the adapter looks at its key. The page keeps a clock that waits move on: a wait for
   * something the chat service draws later moves the clock to that answer, or by the whole wait when nothing comes.
   * Like Playwright's, a locator resolves its elements at each action, and a click on an element under the dialog's
   * backdrop runs out of time.
   */
  function teamsPage({
    refused = 0,
    flickers = 0,
    answerMs = 0,
    echo = false,
    dialogCloses = false,
    unknownDialog = false,
    launcher = false,
    nameTakesNoText = false,
    neverLoads = false,
    stuckDialog = false,
    advance,
  }: {
    refused?: number;
    /** How many of the bot's first messages the page draws "Failed to send." for a moment, then with their time. */
    flickers?: number;
    answerMs?: number;
    echo?: boolean;
    dialogCloses?: boolean;
    unknownDialog?: boolean;
    launcher?: boolean;
    nameTakesNoText?: boolean;
    neverLoads?: boolean;
    /** The device dialog's key stays drawn and takes no press, as when something lies over it too. */
    stuckDialog?: boolean;
    /** Moves the test's clock by an action's whole timeout when the action cannot happen, as Playwright's wait would. */
    advance?: (ms: number) => void;
  } = {}) {
    const journal: string[] = [];
    const clock = { now: 0 };
    const state = { dialog: true, screen: (launcher ? 'launcher' : 'prejoin') as 'launcher' | 'prejoin' | 'lobby', name: '', typed: '', sends: 0 };
    // what an unknown dialog's backdrop is as Playwright describes it in its call log: its markup, the words inside it
    // included, which never reach a report
    const backdrop = '<div class="fui-DialogSurface__backdrop rhhyd" aria-hidden="true"><span>Ada Lovelace is waiting</span></div> intercepts pointer events';
    const items: TeamsItem[] = [];
    const statusOf = (item: TeamsItem): 'sending' | 'sent' | 'failed' =>
      item.sentAt !== undefined && clock.now >= item.sentAt ? 'sent' : item.answer && clock.now >= item.answerAt ? item.answer : 'sending';
    const onPrejoin = () => state.screen === 'prejoin';
    const find = (selector: string): TeamsElement[] => {
      // the launcher's key is in the launcher's page alone, and the name field and Join now in the pre-join screen's
      if (selector === T.continueInBrowser) {
        if (state.screen !== 'launcher') return [];
        return [{ name: 'launcher key', shown: () => state.screen === 'launcher', blocked: () => launcher, holds: () => (launcher ? backdrop : undefined), onClick: () => (state.screen = 'prejoin') }];
      }
      if (selector === T.nameInput) {
        if (state.screen === 'launcher') return [];
        const holds = () => (nameTakesNoText ? 'element is not editable' : undefined);
        return [{ name: 'name', shown: onPrejoin, blocked: () => nameTakesNoText, holds, onFill: (text) => (state.name = text) }];
      }
      if (selector === T.joinNow) {
        if (state.screen === 'launcher') return [];
        // under the device dialog its backdrop takes the press, as under a dialog the adapter does not know
        const dialogBackdrop = '<div class="fui-DialogSurface__backdrop rhhyd" aria-hidden="true"></div> intercepts pointer events';
        const holds = () => (unknownDialog ? backdrop : state.dialog ? dialogBackdrop : !state.name ? 'element is not enabled' : undefined);
        return [{ name: 'join now', shown: onPrejoin, blocked: () => unknownDialog || state.dialog || !state.name, holds, onClick: () => (state.screen = 'lobby') }];
      }
      if (selector === T.deviceDialogContinue) {
        const afterLook = () => {
          if (dialogCloses) state.dialog = false;
        };
        const toast = '<div class="fui-Toast r1tq" role="status"><span>Ada Lovelace joined</span></div> intercepts pointer events';
        return [{ name: 'dialog key', shown: () => onPrejoin() && state.dialog, blocked: () => stuckDialog, holds: () => (stuckDialog ? toast : undefined), onClick: () => (state.dialog = false), afterLook }];
      }
      if (selector === T.lobbyText || selector === T.lobbyScreen) return [{ name: 'lobby', shown: () => state.screen === 'lobby' }];
      if (selector === T.chatInput) {
        const onPress = (key: string) => {
          if (key !== 'Enter') return;
          state.sends += 1;
          journal.push(`send ${state.sends}`);
          if (echo) items.push({ text: state.typed, author: 'Sam', answer: 'sent', answerAt: clock.now });
          // a message drawn failed for a moment shows its time 450 ms later, as the client drew a guest's messages
          const flicker = state.sends <= flickers;
          items.push({ text: state.typed, author: state.name || 'You', answer: state.sends <= refused || flicker ? 'failed' : 'sent', answerAt: clock.now + answerMs, sentAt: flicker ? clock.now + answerMs + 450 : undefined });
          state.typed = '';
        };
        return [{ name: 'composer', shown: () => true, onFill: (text) => (state.typed = text), onPress }];
      }
      if (selector === T.chatMessages) return items.map((item) => ({ name: 'message', shown: () => true, text: () => item.text }));
      if (selector === T.chatMessageAuthor) return items.map((item) => ({ name: 'author', shown: () => true, text: () => item.author }));
      if (selector === T.chatMessageItem) {
        return items.map((item) => ({
          name: 'item',
          shown: () => true,
          text: () => `${item.text} by ${item.author}`,
          within: (sub) => {
            if (sub === T.chatMessageAuthor) return [{ name: 'author', shown: () => true, text: () => item.author }];
            const status = statusOf(item);
            return (sub === T.chatMessageSent && status === 'sent') || (sub === T.chatMessageFailed && status === 'failed') ? [{ name: sub, shown: () => true }] : [];
          },
        }));
      }
      return []; // the call's stage, the launcher's key and every other element: not drawn
    };
    const includes = (text: string | undefined, words: string) => (text ?? '').toLowerCase().includes(words.toLowerCase());
    const locator = (resolve: () => TeamsElement[]): TeamsLocator => ({
      resolve,
      first: () => locator(() => resolve().slice(0, 1)),
      last: () => locator(() => resolve().slice(-1)),
      nth: (index: number) => locator(() => resolve().slice(index, index + 1)),
      or: (other: TeamsLocator) => locator(() => [...resolve(), ...other.resolve()]),
      filter: ({ hasText, visible, has }: { hasText?: string; visible?: boolean; has?: TeamsLocator }) =>
        locator(() =>
          resolve().filter((e) => {
            if (hasText !== undefined && !(e.text?.() ?? '').includes(hasText)) return false;
            if (visible !== undefined && e.shown() !== visible) return false;
            if (!has) return true;
            // a `has` locator is read inside the element, with its words when it was given some
            const words = has.hasText;
            return (e.within?.(has.selector ?? '') ?? []).some((inner) => words === undefined || includes(inner.text?.(), words));
          }),
        ),
      locator: (selector: string) => locator(() => resolve().flatMap((e) => e.within?.(selector) ?? [])),
      count: async () => resolve().length,
      async isVisible() {
        const element = resolve()[0];
        const shown = element?.shown() ?? false;
        element?.afterLook?.();
        return shown;
      },
      async waitFor({ timeout = 30_000 }: { timeout?: number } = {}) {
        // what the chat service answers within the wait is drawn as the clock reaches it
        const until = clock.now + timeout;
        for (;;) {
          if (resolve()[0]?.shown()) return;
          const due = items.flatMap((item) => [item.answerAt, item.sentAt ?? item.answerAt]).filter((at) => at > clock.now && at <= until);
          if (!due.length) {
            clock.now = until;
            throw timeoutError();
          }
          clock.now = Math.min(...due);
        }
      },
      async click({ timeout = 30_000 }: { timeout?: number } = {}) {
        const element = resolve()[0];
        if (!element?.shown() || element.blocked?.()) {
          advance?.(timeout); // the action waits out its whole timeout
          throw actionTimeout('click', element?.holds?.()); // the backdrop takes the click
        }
        journal.push(`click ${element.name}`);
        element.onClick?.();
      },
      async fill(text: string) {
        const element = resolve()[0];
        if (!element?.shown() || element.blocked?.()) throw actionTimeout('fill', element?.holds?.());
        journal.push(`fill ${element.name}`);
        element.onFill?.(text);
      },
      async press(key: string) {
        const element = resolve()[0];
        if (!element?.shown()) throw timeoutError();
        element.onPress?.(key);
      },
    });
    // a frame's address as the page's frames give it: the main frame's, and the sign-in page a frame opens
    const mainFrame = { url: () => (state.screen === 'launcher' ? 'https://teams.microsoft.com/dl/launcher/launcher.html?url=x' : 'https://teams.microsoft.com/light-meetings/launch?agent=web&coords=x') };
    const signInFrame = { url: () => 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x&login_hint=ada%40example.com' };
    const page = {
      goto: async () => {
        if (neverLoads) throw Object.assign(new Error('page.goto: Timeout 30000ms exceeded.\nCall log:\n  - navigating to "https://teams.microsoft.com/l/meetup-join/x", waiting until "domcontentloaded"'), { name: 'TimeoutError' });
        journal.push('goto');
      },
      url: () => mainFrame.url(),
      mainFrame: () => mainFrame,
      frames: () => [mainFrame, signInFrame, { url: () => 'about:blank' }],
      locator: (selector: string, { hasText }: { hasText?: string } = {}) => ({
        ...locator(() => find(selector).filter((e) => hasText === undefined || includes(e.text?.(), hasText))),
        selector,
        hasText,
      }),
      waitForTimeout: async (ms: number) => {
        clock.now += ms;
      },
    } as unknown as Page;
    return { page, journal, items, statuses: () => items.map(statusOf) };
  }

  const LINK = 'https://teams.microsoft.com/l/meetup-join/x';

  it("presses the device dialog's key, then Join now, and reports the lobby", async () => {
    const { page, journal } = teamsPage();
    const outcome = await microsoftTeamsAdapter.join(page, { meetingUrl: LINK, botName: "Ada's notes", signedIn: false });
    expect(outcome).toEqual({ state: 'waiting_room' });
    expect(journal).toEqual(['goto', 'fill name', 'click dialog key', 'click join now']);
  });

  // a dialog that closes after the adapter saw its key, before the press lands: the press runs out of time, and the
  // join goes on to Join now within its time rather than ending there
  it('presses Join now when the device dialog closed between the look at its key and the press', async () => {
    const { page, journal } = teamsPage({ dialogCloses: true });
    const outcome = await microsoftTeamsAdapter.join(page, { meetingUrl: LINK, botName: "Ada's notes", signedIn: false });
    expect(outcome).toEqual({ state: 'waiting_room' });
    expect(journal).toEqual(['goto', 'fill name', 'click join now']);
  });

  // a join that cannot go on names its step and what held it, read from Playwright's call log, and carries an outline of
  // the page that holds hosts, the client's own names for its parts and fixed words alone: never a link's path past its
  // first part, a query, nor a word the page shows
  it('names a Join now covered by a dialog it does not know, with the page, its frames and the cover, and nothing the page says', async () => {
    const { page, journal } = teamsPage({ unknownDialog: true });
    const failure = await microsoftTeamsAdapter.join(page, { meetingUrl: LINK, botName: "Ada's notes", signedIn: false }).catch((err: unknown) => err);
    expect((failure as Error).message).toBe('join_now_covered');
    expect(outlineOf(failure)).toBe('; page: teams.microsoft.com light-meetings, dialog pressed, cover fui-DialogSurface__backdrop, frames login.microsoftonline.com');
    expect(outlineOf(failure)).not.toMatch(/Ada|waiting|login_hint|client_id|example/);
    expect(journal.filter((line) => line === 'click dialog key')).toEqual(['click dialog key']);
  });

  // a device dialog whose key stays drawn and takes no press: each round waits out the key's press and Join now's, and
  // the join still ends within its thirty seconds, never fifteen rounds of both
  it('gives up on Join now within its thirty seconds when the device dialog stays and its key takes no press', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      const { page } = teamsPage({ stuckDialog: true, advance: (ms) => vi.setSystemTime(Date.now() + ms) });
      const failure = await microsoftTeamsAdapter.join(page, { meetingUrl: LINK, botName: "Ada's notes", signedIn: false }).catch((err: unknown) => err as Error);
      expect(failure.message).toBe('join_now_covered');
      expect(outlineOf(failure)).toBe('; page: teams.microsoft.com light-meetings, dialog none, cover fui-DialogSurface__backdrop, frames login.microsoftonline.com');
      expect(Date.now() - start).toBeLessThanOrEqual(37_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the launcher's key it could not press, a name field that takes no text and a link that never loads", async () => {
    const join = (options: Parameters<typeof teamsPage>[0]) =>
      microsoftTeamsAdapter.join(teamsPage(options).page, { meetingUrl: LINK, botName: "Ada's notes", signedIn: false }).catch((err: unknown) => err as Error);
    const launcher = await join({ launcher: true });
    expect(launcher.message).toBe('join_continue_covered');
    expect(outlineOf(launcher)).toBe('; page: teams.microsoft.com dl, dialog none, cover fui-DialogSurface__backdrop, frames login.microsoftonline.com');
    const name = await join({ nameTakesNoText: true });
    expect(name.message).toBe('join_name_readonly');
    expect(outlineOf(name)).toBe('; page: teams.microsoft.com light-meetings, dialog none, cover none, frames login.microsoftonline.com');
    const never = await join({ neverLoads: true });
    expect(never.message).toBe('join_page_timeout');
  });

  it('sends a message again when the chat service refused it, and counts it posted once it shows its time', async () => {
    const { page, journal, statuses } = teamsPage({ refused: 1 });
    await microsoftTeamsAdapter.postChat(page, NOTICE);
    expect(statuses()).toEqual(['failed', 'sent']);
    expect(journal.filter((line) => line.startsWith('send'))).toEqual(['send 1', 'send 2']);
  });

  // the client the bot is served draws each message a guest sends "Failed to send." for a moment, its retry and delete
  // keys beside it, and gives it its time about 450 ms later, as it drew every message a guest sent on 31 October 2026 while
  // the meeting's other side read each one once: such a message is posted, and never sent again
  it('counts a message posted once when the client draws it failed for a moment and then gives it its time', async () => {
    const { page, journal, statuses } = teamsPage({ flickers: 1 });
    await microsoftTeamsAdapter.postChat(page, NOTICE);
    expect(statuses()).toEqual(['sent']);
    expect(journal.filter((line) => line.startsWith('send'))).toEqual(['send 1']);
  });

  it('names a message the chat service refuses at every send, after three sends', async () => {
    const { page, items } = teamsPage({ refused: Number.POSITIVE_INFINITY });
    await expect(microsoftTeamsAdapter.postChat(page, NOTICE)).rejects.toThrow('chat_send_failed');
    expect(items).toHaveLength(3);
  });

  // a participant who posts the bot's words while the bot's own message waits for the chat service: their message
  // shows its time, and it never stands for the bot's, which the service refuses at every send
  it("counts only the bot's own message, never a participant's with the same words", async () => {
    const { page, items } = teamsPage({ refused: Number.POSITIVE_INFINITY, echo: true });
    await microsoftTeamsAdapter.join(page, { meetingUrl: LINK, botName: 'SaysHere notes', signedIn: false });
    await expect(microsoftTeamsAdapter.postChat(page, NOTICE)).rejects.toThrow('chat_send_failed');
    expect(items.filter((item) => item.author === 'SaysHere notes')).toHaveLength(3);
  });

  // a message still "Sending..." is waited on, never sent again: the service may take it after the wait, and a second
  // send would put the words in the chat twice
  it('sends a message once while the chat service has not answered it, and names one with no answer within the wait chat_send_unanswered', async () => {
    const { page, journal, items } = teamsPage({ answerMs: 20_000 });
    await expect(microsoftTeamsAdapter.postChat(page, NOTICE)).rejects.toThrow('chat_send_unanswered');
    expect(journal.filter((line) => line.startsWith('send'))).toEqual(['send 1']);
    expect(items).toHaveLength(1);
  });

  it('counts a message posted when the chat service takes it after a few seconds', async () => {
    const { page, journal, statuses } = teamsPage({ answerMs: 8_000 });
    await microsoftTeamsAdapter.postChat(page, NOTICE);
    expect(statuses()).toEqual(['sent']);
    expect(journal.filter((line) => line.startsWith('send'))).toEqual(['send 1']);
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
 * Chat conversation's panel draws them, and the main frame holds neither. The main frame draws the Chat key as
 * `keyState` says: marking its panel open or closed by `aria-pressed`, or no key at all.
 */
function fakeChatPage(messages: FakeMessage[], table: Record<string, string> & { chatInput: string; chatMessages: string; chatMessageSender: string; chatMessageText: string }, shownComposer: string | null = table.chatInput, inFrame = false, keyState: 'open' | 'closed' | 'none' = 'none') {
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
  const keys = Object.entries(table).filter(([name]) => name.startsWith('chatButton')).map(([, selector]) => selector);
  // a locator over elements shown or not, whose filter by visibility and whose first element are itself
  const shown = (visible: boolean, attribute: (name: string) => string | null = () => null) => ({
    first() {
      return this;
    },
    filter() {
      return this;
    },
    isVisible: async () => visible,
    getAttribute: async (name: string) => attribute(name),
  });
  // the Chat key, in the main frame alone: shown with its state in aria-pressed, or not there
  const chatKey = (selector: string) => (keys.includes(selector) ? shown(keyState !== 'none', (name) => (name === 'aria-pressed' && keyState !== 'none' ? String(keyState === 'open') : null)) : undefined);
  const panel = (selector: string) => {
    if (composers.includes(selector)) return shown(selector === shownComposer);
    if (selector === table.chatMessages) return { all: async () => messages.map(node) };
    return chatKey(selector) ?? (() => { throw new Error(`no fake for ${selector}`); })();
  };
  const empty = (selector: string) => {
    if (composers.includes(selector)) return shown(false);
    if (selector === table.chatMessages) return { all: async () => [] };
    return chatKey(selector) ?? (() => { throw new Error(`no fake for ${selector}`); })();
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
  /** Whether Playwright reads the element as editable: enabled and not read-only. A composer drawn disabled, read-only or aria-disabled is not. */
  takesText: boolean;
  /** The element's attributes as Playwright reads them, `null` for one it does not carry; an element without this carries none. */
  attr?: (name: string) => string | null;
  onClick?: () => void;
  onPress?: (key: string) => void;
  clicks: number;
  fills: string[];
  presses: string[];
}

const fakeElement = (name: string, more: Partial<FakeElement> = {}): FakeElement => ({ name, shown: () => true, text: '', editable: false, blocked: false, refusesFill: false, refusesPress: false, takesText: true, clicks: 0, fills: [], presses: [], ...more });

/** What Playwright throws when an action or a wait runs out of time. */
const timeoutError = () => Object.assign(new Error('Timeout exceeded'), { name: 'TimeoutError' });

/**
 * What Playwright throws when a click or a fill runs out of time, with its call log: the locator found, and the last
 * line it wrote, what held the element, when the test gives one.
 */
const actionTimeout = (action: string, holds?: string) =>
  Object.assign(
    new Error(`locator.${action}: Timeout 2000ms exceeded.\nCall log:\n  - waiting for locator('x').first()\n    - locator resolved to <button>x</button>\n  - attempting ${action} action${holds ? `\n    - ${holds}` : ''}`),
    { name: 'TimeoutError' },
  );

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
    // Playwright's read of an editable element's state: enabled and not read-only; a missing element fails the read
    async isEditable() {
      const element = first();
      if (!element) throw timeoutError();
      journal.push(`state ${element.name}`);
      return element.takesText;
    },
    count: async () => resolve().length,
    all: async () => resolve().map((element) => fakeLocator(() => [element], journal)),
    // Playwright's filter by text, and by visibility (locator.filter's `visible`, since 1.51): the matches shown, or the matches not shown
    filter: ({ hasText, visible }: { hasText?: string; visible?: boolean }) =>
      fakeLocator(() => resolve().filter((element) => (hasText === undefined || element.text.includes(hasText)) && (visible === undefined || element.shown() === visible)), journal),
    // an attribute's value as Playwright reads it: a missing element fails the read
    async getAttribute(name: string): Promise<string | null> {
      const element = first();
      if (!element) throw timeoutError();
      return element.attr?.(name) ?? null;
    },
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
  /** The composer's shape: a known one, or the panel's composer by its shape and place alone (`chatInputInPanel`), a textarea under another label. */
  composer: 'chatInput' | 'chatInputLegacy' | 'chatInputEditable' | 'chatInputInPanel';
  composerShows?: boolean;
  /** The composer drawn disabled, as Meet draws it when the meeting's chat is off for the participant: Playwright reads it as not editable, and a fill on it waits out its time. */
  disabled?: boolean;
  /** A field of another side panel, shown before the Chat key is pressed, that the panel lookup would find by its shape and place. */
  strayField?: boolean;
  /** A match of the composer's own lookup drawn hidden before the composer in document order, as a screen the client keeps in the page without showing it. */
  hiddenFirst?: boolean;
  /** The composer, the messages and the Send key in a frame the panel embeds, as a Google Chat conversation's panel draws them. */
  inFrame?: boolean;
  key?: 'chatButton' | 'chatButtonLegacy' | null;
  keyBlocked?: boolean;
  /** How the Chat key marks its panel's state: `aria-pressed` (the fixture's key), `aria-expanded` (Meet's key, in the nightly check's run of 27 October 2026), or neither. */
  keyState?: 'pressed' | 'expanded' | 'none';
  /** The chat panel open before the first post, its key marking it so. */
  open?: boolean;
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
 * message back from those alone, so a notice confirmed is one the observer can read beside. The key is a toggle, as the
 * fixture's is: a click on it while the panel is open closes the panel; and it marks the panel's state as `keyState` says.
 */
function callWithChat({ composer, composerShows = true, disabled = false, strayField = false, hiddenFirst = false, inFrame = false, key = 'chatButton', keyBlocked = false, keyState = 'pressed', open = false, sends = true, shortcutOpens = false, tip = false, sendKey = false, preposted, refuses, roots }: CallOptions) {
  const state = { open };
  const messages: FakeElement[] = preposted === undefined ? [] : [fakeElement('message', { text: preposted })];
  const post = (input: FakeElement) => {
    messages.push(fakeElement('message', { text: input.text }));
    input.text = '';
  };
  const input = fakeElement('composer', {
    shown: () => state.open && composerShows,
    // the textarea shapes hold their text as a value, the others as content
    editable: composer !== 'chatInputLegacy' && composer !== 'chatInputInPanel',
    refusesFill: refuses === 'fill' || disabled,
    refusesPress: refuses === 'press',
    takesText: !disabled,
    onPress: (pressed) => {
      if (pressed === 'Enter' && sends) post(input);
    },
  });
  const stray = fakeElement('stray');
  const hidden = fakeElement('hidden', { shown: () => false });
  const button = fakeElement('key', {
    blocked: keyBlocked,
    onClick: () => { state.open = !state.open; },
    attr: (name) => (keyState !== 'none' && name === `aria-${keyState}` ? String(state.open) : null),
  });
  const send = fakeElement('send', { shown: () => state.open, onClick: () => post(input) });
  const panel: Present = { chatMessages: messages };
  if (strayField) panel.chatInputInPanel = [stray];
  panel[composer] = hiddenFirst ? [hidden, input] : [input];
  if (sendKey) panel.chatSendButton = [send];
  const main: Present = inFrame ? {} : panel;
  if (key) main[key] = [button];
  if (tip) main.dismissButton = [fakeElement('tip')];
  const embedded: FramePresent[] = inFrame ? [{ url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: panel, root: roots?.frame }] : [];
  const page = fakeMeetPage(main, (pressed) => {
    if (pressed === 'Control+Alt+c' && shortcutOpens) state.open = true;
  }, embedded, roots?.main);
  return { page, input, button, send, messages, stray, hidden, setOpen: (value: boolean) => { state.open = value; } };
}

const NOTICE = 'A notetaker joined this call for its host. Type stop taking notes in the chat and it leaves.';
/** A later post through the same chat: the farewell, or a message the manager commands. */
const SECOND = 'The notetaker is leaving the call now.';

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
      ['chat_input_blocked', { composer: 'chatInputInPanel', disabled: true }],
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
    expect(outline).toMatch(/^panel: frames=2; f1 meet\.google\.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:none; f2 chat\.google\.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=History is on\|Send message; tried=composer:role,textarea,editable,panel$/);
    expect(outline).toMatch(RECORD_LINE);
    expect(outline).not.toContain('Participant');
    expect(outlineOf(failure)).toBe(`; ${outline}`);
    // the shortcut's way names its own lookups
    const noKey = await googleMeetAdapter.postChat(callWithChat({ composer: 'chatInput', key: null }).page, NOTICE).catch((err: unknown) => err);
    expect((noKey as ChatStepError).outline).toMatch(/; tried=key:role,markup shortcut composer:role,textarea,editable,panel$/);
  });

  // the nightly check's Meet run of 27 October 2026 (40539663181, bot image 0.1.6 at bd30397c): the panel opened on its
  // key (expanded:true) and held one drawn textarea in the side panel, named by an aria-label that begins neither
  // "Send a message" nor "History is o", disabled and aria-disabled, beside an undrawn unnamed textarea elsewhere in the
  // page: the meeting's chat was off for the bot. No lookup read the composer, since each keys on its name, and the
  // step reported chat_input_missing for a composer that was there and would take no text
  it("finds the panel's composer under another label once the panel has opened, and names one drawn disabled chat_input_blocked at once, with the outline", async () => {
    const { el } = fakeTree();
    const main = el('body', {}, [
      el('button', { 'aria-label': 'Chat with everyone', 'aria-expanded': 'true' }, ['Chat']),
      el('aside', {}, [el('textarea', { 'aria-label': 'Messages are off in this meeting', disabled: '', 'aria-disabled': 'true' })]),
      el('section', {}, [el('textarea', {})], { hidden: true }),
    ]);
    const { page, input, button } = callWithChat({ composer: 'chatInputInPanel', disabled: true, roots: { main } });
    const failure = await googleMeetAdapter.postChat(page, NOTICE).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ChatStepError);
    expect((failure as ChatStepError).message).toBe('chat_input_blocked');
    expect(button.clicks).toBe(1);
    // the state is read and no text is typed into a composer that takes none: the step is named at once, not after a fill that waits out its time
    expect(page.journal).toContain('state composer');
    expect(input.fills).toEqual([]);
    expect((failure as ChatStepError).outline).toBe(
      'panel: frames=1; f1 meet.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:true pbtn=0,on:0 cands=textarea,textbox,ce:0,dis:1,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:message-off-meeting|textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:none,lbl:none,chat:0,land:none,words:none names=Messages are off in this meeting; tried=state:panel',
    );
    expect((failure as ChatStepError).outline).toMatch(RECORD_LINE);
  });

  it("types into the panel's composer under another label when it takes text, and reads the message back", async () => {
    const { page, input, button, messages } = callWithChat({ composer: 'chatInputInPanel' });
    await googleMeetAdapter.postChat(page, NOTICE);
    expect(button.clicks).toBe(1);
    expect(input.fills).toEqual([NOTICE]);
    expect(messages.map((m) => m.text)).toEqual([NOTICE]);
  });

  // a composer the client draws disabled, read-only or aria-disabled takes no text whichever shape found it
  for (const composer of ['chatInput', 'chatInputLegacy', 'chatInputEditable'] as const) {
    it(`names ${composer} drawn disabled chat_input_blocked by its state, before any text is typed`, async () => {
      const { page, input } = callWithChat({ composer, disabled: true });
      await expect(googleMeetAdapter.postChat(page, NOTICE)).rejects.toThrow('chat_input_blocked');
      expect(input.fills).toEqual([]);
    });
  }

  // another side panel's field (People's search, say) is a textbox in a complementary landmark too: it never stands for
  // the composer before the Chat key is pressed, and the known shapes come first once the panel is open
  it('never takes a field of another panel for the composer before the Chat key is pressed', async () => {
    const { page, input, button, stray, messages } = callWithChat({ composer: 'chatInput', strayField: true });
    await googleMeetAdapter.postChat(page, NOTICE);
    expect(button.clicks).toBe(1);
    expect(stray.fills).toEqual([]);
    expect(input.fills).toEqual([NOTICE]);
    expect(messages.map((m) => m.text)).toEqual([NOTICE]);
  });

  // the review of pull request 432: a composer found by the panel lookup alone was not recognised on the next post (the
  // farewell, the manager's postChat commands), so the Chat key was pressed again, which on a key that toggles closes
  // the panel, and the post failed as chat_input_missing. The key's own state says the panel is open (aria-pressed, as
  // the fixture's key marks it; aria-expanded, as Meet's key did in the nightly check's run of 27 October 2026), and the
  // panel's composer is read by its shape then, with no second press; a key that marks nothing is trusted once the panel
  // opened on it in this page
  for (const keyState of ['pressed', 'expanded', 'none'] as const) {
    it(`posts twice through the panel's composer under another label, pressing the Chat key once (${keyState === 'none' ? 'a key that marks nothing' : `the key marking its panel by aria-${keyState}`})`, async () => {
      const { page, input, button, messages } = callWithChat({ composer: 'chatInputInPanel', keyState });
      await googleMeetAdapter.postChat(page, NOTICE);
      await googleMeetAdapter.postChat(page, SECOND);
      expect(button.clicks).toBe(1);
      expect(input.fills).toEqual([NOTICE, SECOND]);
      expect(messages.map((m) => m.text)).toEqual([NOTICE, SECOND]);
    });
  }

  // a panel open before the first post, by the key's own word: the composer is read where it is and the key is never
  // pressed, which would close the panel; a panel open and empty is chat_input_missing with no press either
  for (const keyState of ['pressed', 'expanded'] as const) {
    it(`never presses a Chat key that says its panel is open (aria-${keyState}), and reads the panel's composer by its shape then`, async () => {
      const { page, input, button, messages } = callWithChat({ composer: 'chatInputInPanel', keyState, open: true });
      await googleMeetAdapter.postChat(page, NOTICE);
      expect(button.clicks).toBe(0);
      expect(input.fills).toEqual([NOTICE]);
      expect(messages.map((m) => m.text)).toEqual([NOTICE]);
      const empty = callWithChat({ composer: 'chatInput', composerShows: false, keyState, open: true });
      const failure = await googleMeetAdapter.postChat(empty.page, NOTICE).catch((err: unknown) => err);
      expect((failure as ChatStepError).message).toBe('chat_input_missing');
      expect((failure as ChatStepError).outline).toMatch(/; tried=composer:role,textarea,editable,panel$/);
      expect(empty.button.clicks).toBe(0);
    });
  }

  // the panel closed again after the notice (a participant closed it, or the client did) while a field of another side
  // panel shows: the key says the panel is closed, so that field never stands for the composer, and the next post opens
  // the panel on the key again
  it("opens the panel on its key again when the key says it closed, never taking another panel's field for the composer", async () => {
    const { page, input, button, stray, messages, setOpen } = callWithChat({ composer: 'chatInput', strayField: true });
    await googleMeetAdapter.postChat(page, NOTICE);
    setOpen(false);
    await googleMeetAdapter.postChat(page, SECOND);
    expect(button.clicks).toBe(2);
    expect(stray.fills).toEqual([]);
    expect(input.fills).toEqual([NOTICE, SECOND]);
    expect(messages.map((m) => m.text)).toEqual([NOTICE, SECOND]);
  });

  // a screen the client keeps in the page without showing it can hold a match of a lookup before the composer in
  // document order: each lookup reads its first visible match, never its first match
  for (const composer of ['chatInput', 'chatInputLegacy', 'chatInputEditable', 'chatInputInPanel'] as const) {
    it(`reads the first visible match of ${composer}, past a hidden match before it`, async () => {
      const { page, input, hidden, button, messages } = callWithChat({ composer, hiddenFirst: true });
      await googleMeetAdapter.postChat(page, NOTICE);
      expect(button.clicks).toBe(1);
      expect(hidden.fills).toEqual([]);
      expect(input.fills).toEqual([NOTICE]);
      expect(messages.map((m) => m.text)).toEqual([NOTICE]);
    });
  }
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

  // the review of pull request 432: the observer read the panel as open through any field inside a side panel, so a field
  // of another panel kept the chat read while the chat panel was closed. The panel's composer by its shape stands for an
  // open panel only while the Chat key says the panel is open; with the key saying it is closed, or with no key and a
  // page whose panel never opened on the key, nothing is read through it
  it("reads the Meet panel through its composer under another label while the Chat key says the panel is open, and refuses another panel's field when the key says it is closed or there is no key", async () => {
    const messages: FakeMessage[] = [{ id: 'm1', sender: 'Sam', body: 'hello', whole: 'Sam\n10:32\nhello' }];
    const read: ChatMessage[] = [];
    const open = fakeChatPage(messages, MEET_SELECTORS, MEET_SELECTORS.chatInputInPanel, false, 'open');
    const observer = await googleMeetAdapter.observeChat(open as unknown as Page, (message) => read.push(message));
    observer.stop();
    expect(read.map((message) => message.text)).toEqual(['hello']);
    for (const keyState of ['closed', 'none'] as const) {
      const closed = fakeChatPage(messages, MEET_SELECTORS, MEET_SELECTORS.chatInputInPanel, false, keyState);
      await expect(googleMeetAdapter.observeChat(closed as unknown as Page, () => undefined), keyState).rejects.toThrow('chat_panel_closed');
    }
  });
});

/** A text node of a fake tree. */
interface FakeText {
  nodeType: 3;
  textContent: string;
}

/** A node of a fake tree: the members the outline reads, with `hidden` for a node drawn without a box. */
interface FakeNode extends ElementLike {
  nodeType: 1;
  children: FakeNode[];
  childNodes: Array<FakeNode | FakeText>;
  parentElement: FakeNode | null;
  hidden: boolean;
  /** The visibility the node sets, which the fake window's computed style gives it and the nodes under it. */
  visibility?: string;
}

/** What a fake node may be given besides its attributes and children: a hidden ancestor's effect, an empty box, a visibility it sets, and the texts of label elements tied to it. */
interface FakeNodeOptions {
  hidden?: boolean;
  box?: boolean;
  visibility?: string;
  labels?: string[];
}

/**
 * A fake document: `el` makes a node with its attributes and its children (strings are text), and the document finds
 * nodes by id. A node keeps its children in their order, its texts among them, as a page's element does (`childNodes`),
 * and its text is theirs joined with nothing at an element's edge, as `textContent` reads it.
 */
function fakeTree() {
  const byId = new Map<string, FakeNode>();
  const document = {
    getElementById: (id: string) => byId.get(id) ?? null,
    // the window's computed style, as far as the outline reads it: a node's visibility is the nearest one set on it or above it
    defaultView: {
      getComputedStyle: (el: ElementLike) => {
        for (let p: FakeNode | null = el as FakeNode; p; p = p.parentElement) if (p.visibility) return { visibility: p.visibility };
        return { visibility: 'visible' };
      },
    },
  };
  const el = (tagName: string, attrs: Record<string, string> = {}, children: Array<FakeNode | string> = [], { hidden = false, box = true, visibility, labels }: FakeNodeOptions = {}): FakeNode => {
    const node: FakeNode = {
      tagName,
      nodeType: 1,
      children: [],
      childNodes: [],
      parentElement: null,
      hidden,
      visibility,
      labels: labels?.map((textContent) => ({ nodeType: 1, textContent })),
      ownerDocument: document,
      get textContent() {
        return node.childNodes.map((child) => child.textContent ?? '').join('');
      },
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
      hasAttribute: (name) => name in attrs,
      getClientRects() {
        for (let p: FakeNode | null = node; p; p = p.parentElement) if (p.hidden) return [];
        return [{}];
      },
      // a hidden node has no box, and a drawn node's box is empty when it is given none
      getBoundingClientRect() {
        for (let p: FakeNode | null = node; p; p = p.parentElement) if (p.hidden) return { width: 0, height: 0 };
        return box ? { width: 10, height: 10 } : { width: 0, height: 0 };
      },
    };
    for (const child of children) {
      if (typeof child === 'string') node.childNodes.push({ nodeType: 3, textContent: child });
      else {
        child.parentElement = node;
        node.children.push(child);
        node.childNodes.push(child);
      }
    }
    if (attrs.id) byId.set(attrs.id, node);
    return node;
  };
  return { el, document };
}

describe("the chat panel's outline", () => {
  const limits = { buttonNames: true, maxRawNames: 60, maxElements: 30_000, labelWords: LABEL_WORDS };
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
    // the Chat key carries no state attribute; the four composer-shaped controls are the two drawn ones first (the
    // editable named "History is on" and the editable with no name), then the pre-join name field and the textarea
    // under their hidden sections, each by its fixed facts alone
    expect(line).toBe('f2 chat.google.com textbox=1 combobox=1 button=6 menuitem=1 editable=2 listitem=1 messageid=1 key=pressed:none,expanded:none cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on|div,none,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:none,lbl:none,chat:0,land:none,words:none|input,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:none,words:none|textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:aria,lbl:send,chat:0,land:none,words:send-message names=People|Chat with everyone|Ask Gemini|History is on|Send message|Leave call');
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
      expect(outline).toBe('panel: frames=2; f1 meet.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 partial cands=div,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:none,words:message names=withheld; f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=withheld; tried=composer:role,textarea,editable');
      expect(outline).not.toContain('Alice');
    } finally {
      OUTLINE_LIMITS.maxElements = maxElements;
    }
    // the main frame unread: the tiles are unread with it
    const unread = await panelOutline(fakeMeetPage({}, undefined, embedded, undefined, true), 'composer:role,textarea,editable', 100);
    expect(unread).toBe('panel: frames=2; f1 meet.google.com unread; f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=withheld; tried=composer:role,textarea,editable');
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

  // a Google Chat conversation draws a message as the element that carries its id, with no element marked as its text or
  // its sender (the chat observer then reads the whole element): its text, and the sender's name drawn in it, are texts
  // no name may quote, whole or in part
  it('drops a name that quotes a message drawn without a text element, as a Google Chat conversation draws it', () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('div', { role: 'list', 'aria-label': 'Messages' }, [
        el('div', { role: 'listitem', 'data-message-id': 'spaces/AAAA/messages/BBBB' }, [el('div', {}, ['Sam']), el('div', {}, ['the budget is in the shared folder'])]),
      ]),
      el('button', { 'aria-label': 'Pinned: the budget is in the shared folder' }),
      el('button', { 'aria-label': 'Pinned: the budget is' }),
      el('button', { 'aria-label': 'Reply to Sam' }),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=1 messageid=1 names=Send message');
    for (const quoted of ['budget', 'Sam']) expect(line).not.toContain(quoted);
  });

  // a participant's name, or a word of it, of one or two characters is matched as a word of the name (two letters meet
  // too much inside other words: `li` in `Delivery`), and a name that writes a participant's name in another form of the
  // same letters (an accent as a combining mark) meets the tile's
  it("drops a name that holds a participant's name however short, as a word, and in another form of its letters", () => {
    const people = ['Li Na', '王伟', 'Al', 'José García'];
    const names = ['Message Li', 'Message 王伟', 'Reply to Al', 'Message Jose\u0301', 'Delivery options', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, textbox: 1, button: 5 }, names, roster: people, people, truncated: false };
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=1 combobox=0 button=5 menuitem=0 editable=0 listitem=0 messageid=0 names=Delivery options|Send message');
    expect(line).toMatch(RECORD_LINE);
  });

  // a modifier letter written as an apostrophe (U+02BC, which a keyboard or a text pipeline writes for the possessive;
  // the turned comma U+02BB likewise) is a letter to Unicode, kept by the clean and no break between words, so `Alʻs`
  // was one word and `Al`, a participant's name of two letters matched only as a word, was not met. U+02BC was split
  // by chance alone: Unicode's script extensions name Thai for it (ScriptExtensions.txt), and the outline reads each
  // letter of a script whose words run together as a word of its own. An apostrophe (`'`) or a right single quotation
  // mark (U+2019) is a mark the clean drops, read as nothing and as a space, so `Al's` met it already. A word that
  // merely holds a short name's letters (`Alpha`, `Delivery`) is no word of the name and stays
  it("drops a name that holds a short participant's name before a modifier letter written as an apostrophe, as before an apostrophe", () => {
    const people = ['Al', 'Li Na'];
    const names = ['Open Al\u02bcs notes', 'Open Al\u02bbs notes', "Open Al's notes", 'Open Al\u2019s notes', 'Alpha channel', 'Delivery options', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: names.length }, names, roster: people, people, truncated: false };
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=7 menuitem=0 editable=0 listitem=0 messageid=0 names=Alpha channel|Delivery options|Send message');
    expect(line).toMatch(RECORD_LINE);
  });

  // a text of two characters, one of them a modifier letter written as an apostrophe (`x` U+02B9), is a term matched
  // only as a word of a name: the letter is read as an apostrophe is on both sides, in the text's terms and in the
  // name's words, so `Reply to x` U+02B9 and `Reply to x` are dropped as `Reply to y` is beside the text `y'`, and a
  // word that merely holds the letter `x` stays
  it('drops a name that holds a two-character text written with a modifier letter apostrophe, as it drops one with an apostrophe', () => {
    const roster = ['x\u02b9', "y'"];
    const names = ['Reply to x\u02b9', 'Reply to x', "Reply to y'", 'Reply to y', 'Open xylophone', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: names.length }, names, roster, people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=0 combobox=0 button=6 menuitem=0 editable=0 listitem=0 messageid=0 names=Open xylophone|Send message');
  });

  // folding the case of a dotted capital I (`İ`, U+0130) gives `i` and a combining dot above (U+0307), a mark the clean
  // drops: the outline makes its terms once and each frame's line makes them again from those, so a form must give the
  // same form again, or the terms made again lose the dot and no longer meet a name that spells the word as the tile or
  // the message does; a name spelled with a plain `I` meets them too
  it("drops a name that holds a participant's word or quotes a message spelled with a dotted capital I", () => {
    const people = ['İlker Yılmaz'];
    const message = 'Toplantı İstanbul ofisinde olacak';
    const names = ['Reply to İlker', 'Pinned: Toplantı İstanbul ofisinde', 'Message Ilker', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: names.length }, names, roster: [...people, message], people, truncated: false };
    const roster = rosterTerms(scan.roster, scan.people);
    expect(frameLine(2, 'chat.google.com', scan, roster)).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
    // the terms made again from the terms hold every one of them
    expect(rosterTerms(roster)).toEqual(expect.arrayContaining(roster));
  });

  // a message drawn with its sender's name on its own element (`div[jsname][data-sender-name]`) holds the whole message:
  // its text is a text no name may quote, and the participant's name is the attribute's value alone, so the message's
  // short words (`is`, `a`) are no participant's words and the composer's names stay
  it("takes a participant's name from the attribute that names the sender, never from the whole message its element holds", () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('div', { jsname: 'm1', 'data-sender-name': 'Sam' }, [el('div', {}, ['Sam']), el('div', {}, ['the copy is in a shared folder'])]),
      el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }),
      el('textarea', { 'aria-label': 'Send a message' }),
      el('button', { 'aria-label': 'Reply to Sam' }),
      el('button', { 'aria-label': 'Pinned: copy is in' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=2 combobox=0 button=2 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on|textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:send,chat:0,land:none,words:send-message names=History is on|Send a message');
    expect(scan.people).toEqual(['Sam']);
  });

  // a mark the clean drops joins the words beside it (`alpha/beta` as `alphabeta`): the texts and the names are also
  // compared with each such mark read as a space, so a quote meets its text whichever of them writes the mark
  it('drops a name that quotes a message across a mark the clean drops, whether the message or the name writes the mark', () => {
    const roster = ['alpha/beta gamma delta', 'budget:approved tomorrow', 'the budget is in the shared folder'];
    const names = ['Open alpha beta gamma delta', 'Pinned budget approved tomorrow', 'Open the/budget/is', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 4 }, names, roster, people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // a role is read by its first word, as the counts read it: an item of a list whose role carries a space after it or a
  // second role is a message too, so a control inside it names nothing and its texts are texts no name may quote
  it('reads a list item whose role carries a space or a second role as a message', () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('div', { role: 'listitem ' }, [el('div', {}, ['Sam']), el('div', {}, ['the budget is in the shared folder']), el('button', { 'aria-label': 'Reply to Sam' })]),
      el('div', { role: 'listitem presentation' }, [el('button', { 'aria-label': 'React to the budget is in the shared folder' })]),
      el('button', { 'aria-label': 'Pinned: the budget is in the shared folder' }),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=2 messageid=0 names=Send message');
  });

  // an `li` element is an item of a list by its element, with no role written on it (its implicit role is listitem), as
  // an element with the listitem role is: its text is a message's text no name may quote, and a control inside it names
  // nothing
  it('reads an li element with no role written on it as an item of a list, and so as a message', () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('ul', {}, [el('li', {}, [el('div', {}, ['Sam']), el('div', {}, ['the budget is in the shared folder']), el('button', { 'aria-label': 'Reply to Sam' })])]),
      el('button', { 'aria-label': 'Pinned: the budget is in the shared folder' }),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=0 combobox=0 button=3 menuitem=0 editable=0 listitem=1 messageid=0 names=Send message');
  });

  // textContent joins the text of one element to the next with nothing between them: a sender's name drawn beside a
  // message's first line (`Samthe budget`) and two lines split by a line break (`foldersee`), while a line that holds a
  // link or a bold word holds another element and is not read on its own. A message's text, an item of a list's among
  // them, is also read with each element in it as a word apart, so a name that quotes three of its words across such an
  // edge is dropped
  it("reads a message's text with each element in it as a word apart, so a quote across a sender's name, a line break or a link is dropped", () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('div', { role: 'list', 'aria-label': 'Messages' }, [
        el('div', { role: 'listitem', 'data-message-id': 'spaces/AAAA/messages/CCCC' }, [
          el('div', {}, ['Sam']),
          el('div', {}, ['the budget is in the shared folder', el('br'), 'see you after the call, notes ', el('a', { href: 'https://docs.example.com/q3' }, ['here'])]),
        ]),
        el('div', { role: 'listitem' }, [el('div', {}, ['Alice']), el('div', {}, ['the venue moved to the north ', el('b', {}, ['annex']), ' this week'])]),
      ]),
      el('button', { 'aria-label': 'Pinned: the budget is' }),
      el('button', { 'aria-label': 'Open the shared folder' }),
      el('button', { 'aria-label': 'Reply: see you after' }),
      el('button', { 'aria-label': 'Pinned: the venue moved to the north' }),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=5 menuitem=0 editable=0 listitem=2 messageid=1 names=Send message');
    for (const quoted of ['budget', 'folder', 'see you', 'venue']) expect(line).not.toContain(quoted);
  });

  // a tile's text holds whatever its elements draw beside the participant's name, the word an icon font draws an icon
  // from among them (`more_vert`, `mic_off`), and textContent joins the name's last word to it (`Smithmic_off`): the
  // tile's text is also read with each element in it as a word apart, so a name that holds a word of the participant's
  // name is dropped
  it("reads a tile's text with each element in it as a word apart, so a name holding a word of a participant's name drawn beside an icon is dropped", async () => {
    const { el } = fakeTree();
    const main = el('body', {}, [
      el('button', { 'aria-label': 'Chat with everyone' }),
      el('div', { 'data-participant-id': 'p1' }, [el('span', {}, ['Sam']), el('button', { 'aria-label': 'More options' }, [el('i', {}, ['more_vert'])])]),
      el('div', { 'data-participant-id': 'p2' }, [el('span', {}, ['Alice Smith']), el('i', {}, ['mic_off'])]),
    ]);
    const chat = el('body', {}, [
      el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }),
      el('button', { 'aria-label': 'Reply to Sam' }),
      el('button', { 'aria-label': 'Message Smith' }),
      el('button', { 'aria-label': 'Send message' }),
    ]);
    const outline = await panelOutline(fakeMeetPage({}, undefined, [{ url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat }], main), 'composer:role,textarea,editable', 200);
    expect(outline).toBe('panel: frames=2; f1 meet.google.com textbox=0 combobox=0 button=2 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:none; f2 chat.google.com textbox=1 combobox=0 button=3 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=History is on|Send message; tried=composer:role,textarea,editable');
    for (const quoted of ['Sam', 'Smith']) expect(outline).not.toContain(quoted);
  });

  // in the scripts whose words run together with no space between them (Chinese, Japanese, Korean, Thai), a name runs
  // into the words around it (`回复王伟`, `田中さんに返信`) and a message's words are not set apart: a short text in such
  // a script is matched anywhere in a name, a short name in another script beside it (`回复Al`) as a word, and three of
  // a message's characters in a row count as a run of its words
  it("drops a name that holds a participant's name or quotes a message in a script whose words run together", () => {
    const people = ['王伟', 'Al', '田中 太郎', 'Li Na'];
    const message = '预算在共享文件夹里';
    const names = ['回复王伟', '回复Al', '田中さんに返信', 'Alさんに返信', 'Pinned message: 预算在共享文\u2026', 'Delivery options', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, textbox: 1, button: 6 }, names, roster: [...people, message], people, truncated: false };
    const line = frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f2 chat.google.com textbox=1 combobox=0 button=6 menuitem=0 editable=0 listitem=0 messageid=0 names=Delivery options|Send message');
    expect(line).toMatch(RECORD_LINE);
  });

  // reading a script's letters as words of a run adds runs and takes none away: a run of whole words between spaces
  // still counts, so a name that holds one inside words of its own (`xsend 消息 nowy` beside `please send 消息 now`)
  // is dropped as before
  it('keeps the runs of whole words beside the runs of letters, so a name holding a run of whole words is still dropped', () => {
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 2 }, names: ['xsend 消息 nowy', 'Send message'], roster: ['please send 消息 now'], people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, rosterTerms(scan.roster, scan.people))).toBe('f2 chat.google.com textbox=0 combobox=0 button=2 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // an IPv6 address has no dots and, written in digits alone, no letter before its colons: bracketed or alone,
  // compressed (`::`) or whole, it is an address too
  it('drops a name that holds an IPv6 address, bracketed or alone, compressed or whole', () => {
    const names = ['[2001:4860:4860::8888]', 'Open 2001:4860:4860:0:0:0:0:8888', 'Ping ::1', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: 4 }, names, roster: [], people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, [])).toBe('f2 chat.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // the filter compares every name with every text a name must not quote, so its work is bounded: past twenty thousand
  // terms the names are withheld, never compared with a part of the texts, and a name longer than two hundred characters
  // (no control's label, and a long quote at most) is dropped without its comparison
  it('withholds the names past twenty thousand terms, and drops a name longer than two hundred characters', () => {
    const scan: FrameScan = { counts: { ...COUNTS_NONE, textbox: 1, button: 1 }, names: ['History is on', 'Send message'], roster: [], people: [], truncated: false };
    const roster = Array.from({ length: 20_001 }, (_, i) => `message ${i}`);
    expect(frameLine(2, 'chat.google.com', scan, roster)).toBe('f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 names=withheld');
    expect(frameLine(2, 'chat.google.com', scan, roster.slice(1))).toBe('f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 names=History is on|Send message');
    const long = 'Open the notes of the planning call '.repeat(6).trim();
    expect(long.length).toBeGreaterThan(200);
    expect(frameLine(2, 'chat.google.com', { ...scan, names: [long, 'Send message'] }, [])).toBe('f2 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // making the terms is bounded too: past the limit the names are withheld whatever the rest holds, so no term past the
  // limit and one more is made, from many texts or from one text whose letters are each a word of a run
  it('stops making terms one past the limit, from many texts or from one long text of letters', () => {
    const many = Array.from({ length: 50_000 }, (_, i) => `message ${i}`);
    expect(rosterTerms(many, [], 20_000)).toHaveLength(20_001);
    // thirty thousand distinct letters of scripts whose words run together: Chinese, then Korean
    const letters = Array.from({ length: 30_000 }, (_, i) => String.fromCodePoint(i < 20_000 ? 0x4e00 + i : 0xac00 + i - 20_000)).join('');
    expect(rosterTerms([letters], [], 20_000)).toHaveLength(20_001);
    expect(rosterTerms([letters])).toHaveLength(29_999);
  });

  // a link a browser reads as one need not be written in plain marks: a zero-width space or a soft hyphen inside it,
  // brackets around its dots, full-width letters and marks, or ideographic full stops between its labels hide it from a
  // test of the name as written, and cleaning the name would leave the host's and the path's words
  it('drops a name that holds a link written with invisible characters, bracketed dots, or full-width or ideographic forms', () => {
    const names = ['Open docs\u200b.example\u200b.com/q3-plan', 'Open docs\u00ad.example\u00ad.com', 'Open docs[.]example[.]com', 'Open ｄｏｃｓ．ｅｘａｍｐｌｅ．ｃｏｍ／ｑ３', 'Open docs。example。com', 'Call ｔｅｌ：＋１５５５１２３４５６７', 'Write to someone＠example', 'Send message'];
    const scan: FrameScan = { counts: { ...COUNTS_NONE, button: names.length }, names, roster: [], people: [], truncated: false };
    expect(frameLine(2, 'chat.google.com', scan, [])).toBe('f2 chat.google.com textbox=0 combobox=0 button=8 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
  });

  // a format character before a scheme's colon was dropped before the link test (a zero-width space, a soft hyphen),
  // and a mark that is no format character was not: a combining grapheme joiner (U+034F), a variation selector
  // (U+FE0F) or a combining dot above (U+0307, which composes with no `l`) stayed between `tel` and its colon in the
  // reading a browser gives, the clean dropped the mark and the colon with it, and `Call tel` U+034F `:+15551234567`
  // was shown as `Call tel15551234567`, a number with no scheme. Every invisible or combining mark is now dropped
  // before the test, in the name's decomposed form, so a mark composed with the letter before the colon (`mailtȯ:`)
  // hides nothing either. A mark between the scheme's letters leaves its last letter before the colon, a scheme by
  // itself, and an `https` link's `//` and host are read on their own, so those were dropped already
  for (const [what, mark] of [
    ['a combining grapheme joiner', '\u034f'],
    ['a variation selector', '\ufe0f'],
    ['a combining dot above', '\u0307'],
    ['a zero-width space', '\u200b'],
    ['a word joiner', '\u2060'],
    ['a zero-width no-break space', '\ufeff'],
    ['the Mongolian vowel separator', '\u180e'],
    ['a soft hyphen', '\u00ad'],
  ] as const) {
    it(`drops a name that holds a scheme with ${what} before its colon or between its letters`, () => {
      const names = [`Call tel${mark}:+15551234567`, `Call te${mark}l:+15551234567`, `Write mailto${mark}:someone`, `Open https${mark}://example.com/x`, 'Send message'];
      const scan: FrameScan = { counts: { ...COUNTS_NONE, button: names.length }, names, roster: [], people: [], truncated: false };
      const line = frameLine(2, 'chat.google.com', scan, []);
      expect(line).toBe('f2 chat.google.com textbox=0 combobox=0 button=5 menuitem=0 editable=0 listitem=0 messageid=0 names=Send message');
      expect(line).not.toContain('1555');
    });
  }

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
    expect(outline).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:none; f2 chat.google.com unread; f3 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=withheld; tried=composer:role,textarea,editable');
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
    expect(outline).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:none; f2 about:blank unread; f3 chat.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=withheld; tried=composer:role,textarea,editable');
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
    expect(read).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:none; f2 chat.google.com textbox=1 combobox=0 button=2 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=History is on|Send message; f3 about:blank textbox=0 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0; tried=composer:role,textarea,editable');
    expect(read).toMatch(RECORD_LINE);
    // a frame that never answers is written as unread, and the names are withheld with it: the texts they must not
    // quote may be in it
    const unread = await panelOutline(fakeMeetPage({}, undefined, [
      { url: 'https://chat.google.com/embed/space/AAAA?hl=en', present: {}, root: chat },
      { url: 'about:blank', present: {}, silent: true },
    ], main), 'composer:role,textarea,editable', 200);
    expect(unread).toBe('panel: frames=3; f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:none; f2 chat.google.com textbox=1 combobox=0 button=2 menuitem=0 editable=1 listitem=0 messageid=0 cands=div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:history,chat:0,land:none,words:history-on names=withheld; f3 about:blank unread; tried=composer:role,textarea,editable');
    expect(unread).toMatch(RECORD_LINE);
  });

  // the nightly check's Meet run of 26 October 2026 (40388896254, bot image 0.1.6) left with chat_input_missing and an
  // outline whose main frame counted one textbox, no editable and no name, with no frame on chat.google.com: the counts
  // cannot tell a composer Playwright's reads pass over (no box, visibility hidden, under an aria-hidden element, named
  // another way) from another control, a disabled composer from a missing one, nor a panel that never opened on its
  // key from one that did. Each composer-shaped control is listed by fixed facts alone, the drawn ones first, and the
  // Chat key by its pressed and expanded state; a name is read for its kind and its start and never written.
  it("lists each composer-shaped control by fixed facts, the drawn ones first and at most four, and the Chat key's state, never a name", () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('button', { 'aria-label': 'Chat with everyone', 'aria-pressed': 'true' }, ['Chat']),
      el('aside', { 'aria-label': 'Chat with everyone' }, [
        el('div', { 'aria-hidden': 'true' }, [el('textarea', { 'aria-label': 'Send a message to everyone', disabled: '', 'aria-disabled': 'true' })]),
        el('div', { role: 'textbox', contenteditable: '', 'aria-label': 'History is on' }, [], { box: false }),
      ]),
      el('section', { role: 'region', 'aria-label': 'People' }, [el('div', { contenteditable: 'true', title: 'Notes' }, [], { visibility: 'hidden' })]),
      el('input', { id: 'name' }, [], { labels: ['Your name'] }),
      el('section', {}, [el('textarea', { placeholder: 'Reply' })], { hidden: true }),
      el('input', { type: 'search' }),
    ]);
    const scan = collectFrameOutline({ ...limits, buttonNames: false, root });
    expect(scan.key).toEqual({ pressed: 'true', expanded: 'none' });
    expect(scan.candidates).toEqual([
      { tag: 'textarea', role: 'textbox', editable: false, disabled: true, readOnly: false, ariaDisabled: true, drawn: true, box: true, visibility: 'visible', ariaHidden: true, named: 'aria', label: 'send', chat: true, landmark: 'complementary', words: ['send', 'message', 'everyone'] },
      { tag: 'div', role: 'textbox', editable: true, disabled: false, readOnly: false, ariaDisabled: false, drawn: true, box: false, visibility: 'visible', ariaHidden: false, named: 'aria', label: 'history', chat: true, landmark: 'complementary', words: ['history', 'on'] },
      { tag: 'div', role: 'none', editable: true, disabled: false, readOnly: false, ariaDisabled: false, drawn: true, box: true, visibility: 'hidden', ariaHidden: false, named: 'title', label: 'other', chat: false, landmark: 'region', words: [] },
      { tag: 'input', role: 'textbox', editable: false, disabled: false, readOnly: false, ariaDisabled: false, drawn: true, box: true, visibility: 'visible', ariaHidden: false, named: 'label', label: 'other', chat: false, landmark: 'none', words: [] },
    ]);
    expect(scan.moreCandidates).toBe(2);
    // the counts are the drawn controls' as before: the aria-hidden textarea and the boxless editable are drawn, the textarea under the hidden section is not
    expect(scan.counts).toEqual({ ...COUNTS_NONE, textbox: 4, button: 1, editable: 2 });
    const line = frameLine(1, 'meet.google.com', scan, []);
    expect(line).toBe(
      'f1 meet.google.com textbox=4 combobox=0 button=1 menuitem=0 editable=2 listitem=0 messageid=0 key=pressed:true,expanded:none pbtn=0,on:0 cands=textarea,textbox,ce:0,dis:1,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:1,name:aria,lbl:send,chat:1,land:complementary,words:send-message-everyone|div,textbox,ce:1,dis:0,ro:0,ad:0,drawn:1,box:0,vis:visible,ah:0,name:aria,lbl:history,chat:1,land:complementary,words:history-on|div,none,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:hidden,ah:0,name:title,lbl:other,chat:0,land:region,words:none|input,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:label,lbl:other,chat:0,land:none,words:none|more:2 names=Send a message to everyone|History is on|Notes',
    );
    expect(line).toMatch(RECORD_LINE);
    // the label element's text and the placeholder name the kind of naming alone
    expect(line).not.toContain('Your name');
    expect(line).not.toContain('Reply');
  });

  // the composer of the nightly check's Meet run of 27 October 2026 was drawn disabled under a label the outline dropped,
  // in a side panel whose controls were counted and never named: what the panel offers is written in fixed words alone,
  // the allow-listed words a name holds (in the name's order, a plural read as its word, an apostrophe dropped) and
  // the side panel's buttons by those words, each with how many are drawn and how many of them enabled
  it("writes which allow-listed words each composer-shaped control's name holds, in the name's order, and the side panel's buttons by those words, never a name", () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('button', { 'aria-label': 'Chat with everyone', 'aria-expanded': 'true' }, ['Chat']),
      el('button', {}, ['Join now']),
      el('aside', {}, [
        el('textarea', { 'aria-label': 'Chat has been turned off by the host. Join the chat to send messages.', disabled: '', 'aria-disabled': 'true' }),
        el('input', { 'aria-label': 'You can\u2019t send messages' }),
        el('button', {}, ['Join chat']),
        el('button', { 'aria-label': 'Send message', disabled: '' }),
        el('div', { 'aria-disabled': 'true' }, [el('button', {}, ['Accept invitation'])]),
        el('button', { 'aria-label': 'Close' }),
        el('div', {}, [el('button', {}, ['Continue'])], { hidden: true }),
      ]),
    ]);
    const scan = collectFrameOutline({ ...limits, buttonNames: false, root });
    expect(scan.candidates?.map((candidate) => candidate.words)).toEqual([['chat', 'turned', 'off', 'host', 'join', 'send', 'message'], ['cant', 'send', 'message']]);
    // the drawn buttons inside the panel alone: the key and Join now outside it, and the hidden Continue, count for nothing
    expect(scan.panelButtons).toEqual({
      drawn: 4,
      enabled: 2,
      words: [{ word: 'join', drawn: 1, enabled: 1 }, { word: 'accept', drawn: 1, enabled: 0 }, { word: 'invitation', drawn: 1, enabled: 0 }, { word: 'chat', drawn: 1, enabled: 1 }, { word: 'message', drawn: 1, enabled: 0 }, { word: 'send', drawn: 1, enabled: 0 }],
    });
    const line = frameLine(1, 'meet.google.com', scan, []);
    const [facts, names] = line.split(' names=');
    expect(facts).toBe(
      'f1 meet.google.com textbox=2 combobox=0 button=6 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:true pbtn=4,on:2,join:1(1),accept:1(0),invitation:1(0),chat:1(1),message:1(0),send:1(0) cands=textarea,textbox,ce:0,dis:1,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:chat-turned-off-host-join-send-message|input,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:cant-send-message',
    );
    expect(names).toBe('Chat has been turned off by the host. Jo|You cant send messages');
    expect(line).toMatch(RECORD_LINE);
    // the buttons of the main frame are never named, inside the panel or outside it
    for (const name of ['Join now', 'Join chat', 'Send message', 'Accept invitation', 'Close', 'Continue']) expect(line).not.toContain(name);
  });

  it('adds only a none token for a name that holds none of the words, and writes no panel token for a frame that draws no side panel', () => {
    const { el } = fakeTree();
    const closed = collectFrameOutline({ ...limits, root: el('body', {}, [el('textarea', { 'aria-label': 'Type a note' }), el('aside', {}, [el('button', {}, ['Join chat'])], { hidden: true })]) });
    expect(closed.candidates?.[0]?.words).toEqual([]);
    expect(closed.panelButtons).toBeUndefined();
    const line = frameLine(1, 'meet.google.com', closed, []);
    expect(line).toBe('f1 meet.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 cands=textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:none,words:none names=Type a note');
    expect(line).not.toContain('pbtn=');
    // a drawn side panel with no button in it says so
    const empty = collectFrameOutline({ ...limits, root: el('body', {}, [el('aside', {}, [el('textarea', { 'aria-label': 'Send a message' })])]) });
    expect(empty.panelButtons).toEqual({ drawn: 0, enabled: 0, words: [] });
    expect(frameLine(1, 'meet.google.com', empty, [])).toBe('f1 meet.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 pbtn=0,on:0 cands=textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:send,chat:0,land:complementary,words:send-message names=Send a message');
  });

  // the plural rule read a word's final s alone, so "replies" fell through it as "replie": a label about replies, or a
  // button about chat histories, wrote none of the word; a plural in -ies is read as its word too
  it("reads a plural in -ies as its word, replies as reply and histories as history, in a composer's label and on a panel's button", () => {
    const { el } = fakeTree();
    const scan = collectFrameOutline({
      ...limits,
      buttonNames: false,
      root: el('body', {}, [el('aside', {}, [el('textarea', { 'aria-label': 'No replies in this chat' }), el('button', {}, ['View chat histories'])])]),
    });
    expect(scan.candidates?.[0]?.words).toEqual(['reply', 'chat']);
    expect(scan.panelButtons).toEqual({ drawn: 1, enabled: 1, words: [{ word: 'chat', drawn: 1, enabled: 1 }, { word: 'view', drawn: 1, enabled: 1 }, { word: 'history', drawn: 1, enabled: 1 }] });
    const line = frameLine(1, 'meet.google.com', scan, []);
    expect(line).toContain(' pbtn=1,on:1,chat:1(1),view:1(1),history:1(1) cands=');
    expect(line).toContain(',words:reply-chat ');
    expect(line.split(' names=')[0]).not.toContain('replie');
  });

  // the nightly check's Meet run of 28 October 2026 (40641268343, meeting-browser 0.1.9) wrote words:chat for the
  // disabled composer and chat:1(0) for the side panel's one disabled button, and no other word of the list: the label
  // was worded outside it. The list reads whether the chat is available, a restriction and who sets it, the meeting and
  // its people, and a continuation in Google Chat; on a page shaped as that run's (thirteen buttons, the key expanded,
  // the disabled composer and two buttons in the side panel, an undrawn unnamed textarea, four empty frames) the
  // composer's words and the panel's tallies are written whole, a label's text is in no fact, and no button is named
  it("writes the words of a composer label that says the chat isn't available and of a disabled panel button that opens Google Chat, whole on a page shaped as the nightly run of 28 October, never their text", async () => {
    const { el } = fakeTree();
    const toolbar = ['Turn off microphone', 'Turn off camera', 'Raise hand', 'Present now', 'Meeting details', 'People', 'Activities', 'Host controls', 'More options', 'Leave call'];
    const main = el('body', {}, [
      ...toolbar.map((label) => el('button', { 'aria-label': label })),
      el('button', { 'aria-label': 'Chat with everyone', 'aria-expanded': 'true' }, ['Chat']),
      el('aside', {}, [
        el('textarea', { 'aria-label': "Chat isn't available in this call", disabled: '', 'aria-disabled': 'true' }),
        el('button', { 'aria-label': 'Open in Google Chat', disabled: '' }),
        el('button', { 'aria-label': 'Close' }),
      ]),
      el('section', {}, [el('textarea', {})], { hidden: true }),
    ]);
    const frames = [{ url: 'https://www.google.com/', present: {}, root: el('body') }, ...Array.from({ length: 3 }, () => ({ url: 'about:blank', present: {}, root: el('body') }))];
    const outline = await panelOutline(fakeMeetPage({}, undefined, frames, main), 'state:panel', 500);
    const empty = 'textbox=0 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0';
    expect(outline).toBe(
      `panel: frames=5; f1 meet.google.com textbox=1 combobox=0 button=13 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:true pbtn=2,on:1,chat:1(0),open:1(0),google:1(0) cands=textarea,textbox,ce:0,dis:1,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:chat-isnt-available-call|textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:0,box:0,vis:visible,ah:0,name:none,lbl:none,chat:0,land:none,words:none names=Chat isnt available in this call; f2 www.google.com ${empty}; f3 about:blank ${empty}; f4 about:blank ${empty}; f5 about:blank ${empty}; tried=state:panel`,
    );
    expect(outline.length).toBeLessThanOrEqual(OUTLINE_MAX_LENGTH);
    expect(outline).toMatch(RECORD_LINE);
    // the facts hold the listed words alone; the composer's label stands in its kept name, as any composer's does
    const facts = outline.replace(/ names=[^;]*/g, '');
    for (const raw of ["isn't", 'Chat isnt', 'available in this call']) expect(facts).not.toContain(raw);
    // the main frame's buttons are never named, in the panel or on the toolbar, and a toolbar button's words are no panel's
    for (const name of ['Open in Google Chat', 'Google Chat', 'Close', ...toolbar]) expect(outline).not.toContain(name);
    for (const word of ['turn', 'off', 'meeting', 'people', 'host', 'call']) expect(outline).not.toContain(`,${word}:`);
  });

  // each word the list adds, read as a name is read for the words: a plural as its word (settings as setting, attendees
  // as attendee, policies as policy), an apostrophe dropped, straight or curly, and a possessive with it (isn't, won't,
  // admin's), and news, whose final s is no plural's, never as new; a side panel's button is read for the same words,
  // written in the list's order, and the facts are the fixed tokens alone
  it('reads the words that say whether the chat is available, who restricts it, the meeting and its people and a continuation in Google Chat, a plural as its word and an apostrophe dropped', () => {
    const { el } = fakeTree();
    const cases: Array<[string, string[]]> = [
      ['Chat is turned off by the meeting organizer', ['chat', 'turned', 'off', 'meeting', 'organizer']],
      ["Chat isn't available during this call", ['chat', 'isnt', 'available', 'during', 'call']],
      ['Your admin\u2019s settings won\u2019t let participants send messages', ['admin', 'setting', 'wont', 'participant', 'send', 'message']],
      ['Chat is restricted by your organisation\u2019s policies for this account', ['chat', 'restricted', 'organisation', 'policy', 'account']],
      ['Only attendees and members can start a new conversation here', ['only', 'attendee', 'member', 'start', 'new', 'conversation', 'here']],
      ['Messages are limited to people in this workspace before and after the meeting', ['message', 'limited', 'people', 'workspace', 'before', 'after', 'meeting']],
      ['Chat was locked by the owner when it started', ['chat', 'locked', 'owner', 'started']],
      ['Unable to send: blocked by an administrator of the domain', ['unable', 'send', 'blocked', 'administrator', 'domain']],
      ['Chat opened in a Google Chat space for the group', ['chat', 'opened', 'google', 'space', 'group']],
      ['Enable chat in Settings', ['enable', 'chat', 'setting']],
      ['Chat is enabled for organisers and owners', ['chat', 'enabled', 'organiser', 'owner']],
      ['Chat is unavailable until you have permission to open it', ['chat', 'unavailable', 'permission', 'open']],
      ['Latest news', []],
    ];
    for (const [label, words] of cases) {
      const scan = collectFrameOutline({ ...limits, buttonNames: false, root: el('body', {}, [el('aside', {}, [el('textarea', { 'aria-label': label }), el('button', { 'aria-label': label, disabled: '' })])]) });
      expect(scan.candidates?.[0]?.words, label).toEqual(words);
      const inOrder = LABEL_WORDS.filter((word) => words.includes(word));
      expect(scan.panelButtons, label).toEqual({ drawn: 1, enabled: 0, words: inOrder.map((word) => ({ word, drawn: 1, enabled: 0 })) });
      expect(frameLine(1, 'meet.google.com', scan, []).split(' names=')[0], label).toBe(
        `f1 meet.google.com textbox=1 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 pbtn=1,on:0${inOrder.map((word) => `,${word}:1(0)`).join('')} cands=textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:${words.join('-') || 'none'}`,
      );
    }
  });

  // Google's help page on Meet's chat and its Workspace Updates post of November 2025 call the chat carried into Google
  // Chat "continuous meeting chat", which a host can turn off for a meeting: a composer label that names it is read for
  // continuous with the other listed words, in the name's order, where the list's order would put it last
  it("reads continuous in a composer label that names continuous meeting chat, in the name's order", () => {
    const { el } = fakeTree();
    const scan = collectFrameOutline({
      ...limits,
      buttonNames: false,
      root: el('body', {}, [el('aside', {}, [el('textarea', { 'aria-label': 'Continuous chat is off for you', disabled: '', 'aria-disabled': 'true' })])]),
    });
    expect(scan.candidates?.[0]?.words).toEqual(['continuous', 'chat', 'off']);
    expect(frameLine(1, 'meet.google.com', scan, []).split(' names=')[0]).toBe(
      'f1 meet.google.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 pbtn=0,on:0 cands=textarea,textbox,ce:0,dis:1,ro:0,ad:1,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:other,chat:0,land:complementary,words:continuous-chat-off',
    );
  });

  // the chat's messages are drawn inside the same side panel: a key beside a message (Pin, a reaction) and a chip a
  // message draws, whose name may be the message's own text, were counted among the panel's buttons and read for the
  // words, so a message that says "accept the invite" could write an accept tally, the very sign of a step to take
  // first; a button inside a message, or carrying a message's id, is left out of the panel's buttons as it is out of
  // the names
  it("leaves a button inside a message, or one carrying a message's id, out of the side panel's buttons and their words", () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('aside', {}, [
        el('div', { 'data-message-id': 'm1', 'data-sender-name': 'Sam' }, [el('span', {}, ['please accept the invite']), el('button', {}, ['Join'])]),
        el('button', { 'data-message-id': 'm1', 'aria-label': 'Pin message' }),
        el('li', {}, [el('button', {}, ['Accept'])]),
        el('button', { 'aria-label': 'Close' }),
      ]),
    ]);
    const scan = collectFrameOutline({ ...limits, buttonNames: false, root });
    expect(scan.panelButtons).toEqual({ drawn: 1, enabled: 1, words: [] });
    const line = frameLine(1, 'meet.google.com', scan, rosterTerms(scan.roster, scan.people));
    expect(line).toBe('f1 meet.google.com textbox=0 combobox=0 button=4 menuitem=0 editable=0 listitem=1 messageid=2 pbtn=1,on:1');
    for (const word of ['join', 'accept', 'invite', 'message']) expect(line).not.toContain(`,${word}:`);
    expect(line).not.toContain('Sam');
  });

  // the side panel's buttons were counted by their nearest landmark, so a button the panel draws under a header, a
  // form or a region of its own (the nearest landmark then a banner, a form or a region) was left out, and a panel that
  // offered a join step under one read as offering none (pbtn=0,on:0); a button counts when any element above it is
  // a complementary landmark, as the adapter's panel lookup finds a composer (`aside textarea`); a candidate's `land`
  // stays the nearest landmark above it
  it('counts a button of the side panel under a header, a form or a region inside it, by any complementary element above it', () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('aside', {}, [
        el('header', {}, [el('button', { 'aria-label': 'Close' })]),
        el('form', {}, [el('textarea', { 'aria-label': 'Send a message' }), el('button', {}, ['Join chat'])]),
        el('div', { role: 'region' }, [el('button', {}, ['Accept'])]),
      ]),
      el('div', { role: 'region' }, [el('button', {}, ['Join now'])]),
    ]);
    const scan = collectFrameOutline({ ...limits, buttonNames: false, root });
    expect(scan.panelButtons).toEqual({ drawn: 3, enabled: 3, words: [{ word: 'join', drawn: 1, enabled: 1 }, { word: 'accept', drawn: 1, enabled: 1 }, { word: 'chat', drawn: 1, enabled: 1 }] });
    expect(scan.candidates?.[0]?.landmark).toBe('form');
    expect(frameLine(1, 'meet.google.com', scan, [])).toContain(' pbtn=3,on:3,join:1(1),accept:1(1),chat:1(1) cands=textarea,textbox,');
  });

  it("reads the Chat key's pressed and expanded state from the first drawn key, in the fixed words alone, and writes no key for a frame without one", () => {
    const { el } = fakeTree();
    const expanded = collectFrameOutline({ ...limits, buttonNames: false, root: el('body', {}, [el('div', { role: 'button', 'aria-label': 'Chat with everyone (Ctrl+Alt+c)', 'aria-expanded': 'FALSE' })]) });
    expect(expanded.key).toEqual({ pressed: 'none', expanded: 'false' });
    expect(frameLine(1, 'meet.google.com', expanded, [])).toBe('f1 meet.google.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:none,expanded:false');
    // a hidden key is passed over for the drawn one; a value outside the attribute's words is written as other
    const mixed = collectFrameOutline({ ...limits, root: el('body', {}, [el('button', { 'aria-label': 'Chat with everyone', 'aria-pressed': 'true' }, [], { hidden: true }), el('button', { 'aria-label': 'Chat with everyone', 'aria-pressed': 'mixed' })]) });
    expect(mixed.key).toEqual({ pressed: 'mixed', expanded: 'none' });
    const odd = collectFrameOutline({ ...limits, root: el('body', {}, [el('button', { 'aria-label': 'Chat with everyone', 'aria-pressed': 'yes' })]) });
    expect(odd.key).toEqual({ pressed: 'other', expanded: 'none' });
    expect(collectFrameOutline({ ...limits, root: el('body', {}, [el('button', { 'aria-label': 'People' })]) }).key).toBeUndefined();
    expect(frameLine(1, 'meet.google.com', collectFrameOutline({ ...limits, root: el('body') }), [])).toBe('f1 meet.google.com textbox=0 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0');
  });

  // the lookups tried are what a failed night is read by: an outline whose frames' counts alone pass its length drops
  // the frames at its end whole, never the lookups tried, and never a part of a frame's line
  it('keeps the lookups tried at the end of an outline cut to its length, dropping whole frames from its end', async () => {
    const { el } = fakeTree();
    const frames = Array.from({ length: 30 }, () => ({ url: 'about:blank', present: {}, root: el('body', {}, [el('textarea', { 'aria-label': 'Send a message' })]) }));
    const outline = await panelOutline(fakeMeetPage({}, undefined, frames, el('body')), 'composer:role,textarea,editable', 500);
    expect(outline.length).toBeLessThanOrEqual(OUTLINE_MAX_LENGTH);
    expect(outline.length).toBeGreaterThan(OUTLINE_MAX_LENGTH - 120);
    expect(outline).toMatch(/^panel: frames=31; f1 meet\.google\.com /);
    expect(outline).toMatch(/; tried=composer:role,textarea,editable$/);
    expect(outline).toMatch(RECORD_LINE);
    // the frames written are whole lines of counts, in order from the first, and fewer than the page holds
    const lines = outline.slice('panel: frames=31; '.length, -'; tried=composer:role,textarea,editable'.length).split('; ');
    expect(lines.length).toBeGreaterThan(10);
    expect(lines.length).toBeLessThan(31);
    for (const [i, line] of lines.entries()) expect(line).toMatch(new RegExp(`^f${i + 1} (meet\\.google\\.com|about:blank) textbox=[01] combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0$`));
  });

  // the first 64 controls in document order were kept before the drawn ones were put first, so a drawn composer behind
  // 64 undrawn fields was counted and never listed: the drawn and the undrawn are kept apart, each to the limit
  it('keeps a drawn composer among the candidates whatever number of undrawn controls come before it', () => {
    const { el } = fakeTree();
    const root = el('body', {}, [
      el('section', {}, Array.from({ length: 70 }, (_, i) => el('input', { 'aria-label': `Field ${i + 1}` })), { hidden: true }),
      el('textarea', { 'aria-label': 'Send a message to everyone' }),
    ]);
    const scan = collectFrameOutline({ ...limits, root });
    expect(scan.candidates?.[0]).toMatchObject({ tag: 'textarea', drawn: true, label: 'send' });
    expect(scan.candidates?.slice(1).every((candidate) => candidate.tag === 'input' && !candidate.drawn)).toBe(true);
    expect(scan.candidates).toHaveLength(4);
    expect(scan.moreCandidates).toBe(67);
  });

  // the adapter clicks the key by its accessible name, which reads aria-labelledby before aria-label: the outline reads
  // the key, and every name, in that order too, so a key the adapter clicked is never left out of the line
  it("reads the Chat key, and each name, by the accessible name's order, aria-labelledby before aria-label", () => {
    const { el } = fakeTree();
    const byReference = collectFrameOutline({ ...limits, root: el('body', {}, [el('span', { id: 'chat-key' }, ['Chat with everyone']), el('button', { 'aria-label': 'Open the side panel', 'aria-labelledby': 'chat-key', 'aria-pressed': 'true' })]) });
    expect(byReference.key).toEqual({ pressed: 'true', expanded: 'none' });
    expect(byReference.names).toEqual(['Chat with everyone']);
    // a key whose reference names it otherwise is not the one the adapter clicked, whatever its aria-label says
    const otherwise = collectFrameOutline({ ...limits, root: el('body', {}, [el('span', { id: 'people-key' }, ['People']), el('button', { 'aria-label': 'Chat with everyone', 'aria-labelledby': 'people-key', 'aria-pressed': 'true' })]) });
    expect(otherwise.key).toBeUndefined();
    expect(otherwise.names).toEqual(['People']);
  });

  // a role written on an editable is the client's text, not one of the roles the outline knows: it is written as other
  it("writes a candidate's role in the fixed words alone, never the role attribute's own text", () => {
    const { el } = fakeTree();
    const scan = collectFrameOutline({ ...limits, root: el('body', {}, [el('div', { contenteditable: 'true', role: 'message content', 'aria-label': 'Send a message' }), el('div', { contenteditable: 'true' })]) });
    expect(scan.candidates?.map((candidate) => candidate.role)).toEqual(['other', 'none']);
    const line = frameLine(2, 'chat.google.com', scan, []);
    expect(line).toContain('cands=div,other,ce:1,');
    // the candidates' tokens hold the fixed words alone, the role attribute's text in none of them; the word message
    // stands elsewhere in the line by right, in the counts' messageid, in the composer's kept name and in its words token
    // (the allow-listed word its name holds), and the attribute's other word in none of it
    const candidates = line.match(/ cands=(\S+)/)?.[1] ?? '';
    expect(candidates).toBe('div,other,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:send,chat:0,land:none,words:send-message|div,none,ce:1,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:none,lbl:none,chat:0,land:none,words:none');
    expect(candidates).not.toContain('message content');
    expect(candidates.replace('words:send-message', '')).not.toContain('message');
    expect(line).not.toContain('content');
    expect(line).toContain(' messageid=0 cands=');
    expect(line).toMatch(/ names=Send a message$/);
  });

  // a frame with many composer-shaped controls must not use up the outline before the frame that holds the composer is
  // written: every frame's counts and key come first, then each frame's first candidate, then each frame's second, and so
  // on while they fit, then each frame's names while they fit, and no token is cut
  it("writes every frame's counts before any frame's candidates and names, and cuts no token, when the frames' lines would pass the outline's length", async () => {
    const { el } = fakeTree();
    const crowded = () => el('body', {}, [
      ...Array.from({ length: 6 }, (_, i) => el('textarea', { 'aria-label': `Field ${i + 1} ${'x'.repeat(30)}` })),
      ...Array.from({ length: 8 }, (_, i) => el('button', { 'aria-label': `Key ${i + 1} ${'y'.repeat(30)}` })),
    ]);
    const frames = [
      ...['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((space) => ({ url: `https://chat.google.com/embed/space/${space}?hl=en`, present: {}, root: crowded() })),
      { url: 'https://chat.google.com/embed/space/EEEE?hl=en', present: {}, root: el('body', {}, [el('textarea', { 'aria-label': 'Send a message' })]) },
    ];
    const main = el('body', {}, [el('button', { 'aria-label': 'Chat with everyone', 'aria-pressed': 'true' })]);
    const outline = await panelOutline(fakeMeetPage({}, undefined, frames, main), 'composer:role,textarea,editable', 500);
    expect(outline.length).toBeLessThanOrEqual(OUTLINE_MAX_LENGTH);
    expect(outline).toMatch(RECORD_LINE);
    // every frame's counts, in order, and the last frame's one candidate whole
    expect(outline).toMatch(/^panel: frames=6; f1 meet\.google\.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:true,expanded:none; f2 chat\.google\.com textbox=6 combobox=0 button=8 menuitem=0 editable=0 listitem=0 messageid=0 cands=[^;]*; f3 chat\.google\.com textbox=6 [^;]*; f4 chat\.google\.com textbox=6 [^;]*; f5 chat\.google\.com textbox=6 [^;]*; f6 chat\.google\.com textbox=1 combobox=0 button=0 menuitem=0 editable=0 listitem=0 messageid=0 cands=textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:send,chat:0,land:none,words:send-message( names=Send a message)?; tried=composer:role,textarea,editable$/);
    // the crowded frames keep fewer than the four candidates their scans hold, the rest counted, and every token kept is whole
    const CANDIDATE = /^(textarea|input|div),(textbox|combobox|other|none),ce:[01],dis:[01],ro:[01],ad:[01],drawn:[01],box:[01],vis:(visible|hidden|collapse|unknown),ah:[01],name:(labelledby|aria|label|title|placeholder|none),lbl:(send|history|other|none),chat:[01],land:[a-z]+,words:(none|[a-z-]+)$/;
    const crowdedMore: number[] = [];
    for (const match of outline.matchAll(/; (f[2-5]) chat\.google\.com [^;]*? cands=([^ ;]+)/g)) {
      const tokens = match[2].split('|');
      const more = tokens[tokens.length - 1]?.startsWith('more:') ? tokens.pop() : undefined;
      for (const token of tokens) expect(token).toMatch(CANDIDATE);
      expect(more).toMatch(/^more:\d+$/);
      crowdedMore.push(Number(more?.slice('more:'.length)));
      expect(tokens.length + Number(more?.slice('more:'.length))).toBe(6);
    }
    expect(crowdedMore).toHaveLength(4);
    // the scans hold four of the six and count two more; a frame whose candidates the room did not take counts more
    expect(crowdedMore.some((more) => more > 2)).toBe(true);
    // a crowded frame's names did not fit; the names are never cut in part
    expect(outline).not.toMatch(/names=[^;]*xxx/);
  });

  // the panel's tallies by word sat in a frame's base, which the fitting writes whole before any candidate: a page whose
  // panels' buttons held many of the words could use the room up with its bases, and the composer's facts, which the
  // outline exists for, went with the frames dropped at the end; the base keeps the panel's totals, and the tallies are
  // fitted by word in rounds after each frame's first candidate, before the other candidates and the names
  it("fits the panels' tallies by word after each frame's first candidate, keeping the composer's facts when the tallies would pass the outline's length", async () => {
    const { el } = fakeTree();
    const wordy = () => el('body', {}, [el('aside', {}, [el('textarea', { 'aria-label': 'Send a message' }), ...LABEL_WORDS.map((word) => el('button', { 'aria-label': word }))])]);
    const frames = ['AAAA', 'BBBB', 'CCCC', 'DDDD'].map((space) => ({ url: `https://chat.google.com/embed/space/${space}?hl=en`, present: {}, root: wordy() }));
    const main = el('body', {}, [el('button', { 'aria-label': 'Chat with everyone', 'aria-pressed': 'true' })]);
    const outline = await panelOutline(fakeMeetPage({}, undefined, frames, main), 'composer:role,textarea,editable', 500);
    expect(outline.length).toBeLessThanOrEqual(OUTLINE_MAX_LENGTH);
    expect(outline).toMatch(RECORD_LINE);
    expect(outline).toMatch(/^panel: frames=5; f1 meet\.google\.com textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 key=pressed:true,expanded:none; f2 /);
    expect(outline).toMatch(/; tried=composer:role,textarea,editable$/);
    // every frame's base with the panel's totals, and every frame's first candidate, the composer, whole
    const lines = outline.slice('panel: frames=5; '.length, -'; tried=composer:role,textarea,editable'.length).split('; ');
    expect(lines).toHaveLength(5);
    const tallied: number[] = [];
    // each chat frame's panel holds one enabled button for every word of the list
    const buttons = LABEL_WORDS.length;
    for (const [i, line] of lines.slice(1).entries()) {
      const match = line.match(new RegExp(`^f(\\d) chat\\.google\\.com textbox=1 combobox=0 button=${buttons} menuitem=0 editable=0 listitem=0 messageid=0 pbtn=${buttons},on:${buttons}((?:,[a-z]+:1\\(1\\))*) cands=textarea,textbox,ce:0,dis:0,ro:0,ad:0,drawn:1,box:1,vis:visible,ah:0,name:aria,lbl:send,chat:0,land:complementary,words:send-message( names=[^;]+)?$`));
      expect(match?.[1]).toBe(String(i + 2));
      // the tallies a frame keeps are the first of the list, in its order, each whole, and fewer than the list, since all of them would not fit
      const words = (match?.[2] ?? '').split(',').filter(Boolean).map((tally) => tally.slice(0, tally.indexOf(':')));
      expect(words).toEqual(LABEL_WORDS.slice(0, words.length));
      tallied.push(words.length);
    }
    expect(Math.max(...tallied)).toBeGreaterThan(0);
    expect(Math.max(...tallied)).toBeLessThan(LABEL_WORDS.length);
    // the rounds go frame by frame, so the frames' tallies differ by one at most
    expect(Math.max(...tallied) - Math.min(...tallied)).toBeLessThanOrEqual(1);
    // when the counts alone pass the length, the frames at the end are dropped whole, and each base kept carries the panel's totals and no tally
    const many = Array.from({ length: 30 }, () => ({ url: 'about:blank', present: {}, root: el('body', {}, [el('aside', {}, [el('button', { 'aria-label': 'Join chat' })])]) }));
    const cut = await panelOutline(fakeMeetPage({}, undefined, many, el('body')), 'composer:role,textarea,editable', 500);
    expect(cut.length).toBeLessThanOrEqual(OUTLINE_MAX_LENGTH);
    const kept = cut.slice('panel: frames=31; '.length, -'; tried=composer:role,textarea,editable'.length).split('; ');
    expect(kept.length).toBeGreaterThan(10);
    expect(kept.length).toBeLessThan(31);
    for (const line of kept.slice(1)) expect(line).toMatch(/^f\d+ about:blank textbox=0 combobox=0 button=1 menuitem=0 editable=0 listitem=0 messageid=0 pbtn=1,on:1$/);
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
