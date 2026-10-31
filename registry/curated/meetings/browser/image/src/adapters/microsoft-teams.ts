import type { Page } from 'playwright';
import { messageKey } from './message-key.js';
import type { ChatMessage, ChatObserver, JoinOutcome, PlatformAdapter } from './types.js';

/**
 * The Microsoft Teams web client's selectors, as the client Microsoft serves an anonymous guest drew its pages on 30
 * October 2026 (teams.microsoft.com/light-meetings, after the launcher's "Continue on this browser"); each failure the
 * nightly real-join check finds updates this table and the adapter's `selectorsVersion`. Every entry is one Playwright
 * selector: CSS (a comma list of CSS selectors included), one `text=` selector or one `xpath=` selector, never two
 * engines mixed in one string. The name field is known by its data-tid, since its id is generated. The lobby is the
 * pre-join screen's place under `calling-lobby-screen` (the pre-join screen's own is `calling-prejoin-screen`) with the
 * lobby's words. The call draws no calling stage: its Leave key, `button#hangup-button` named by its title alone, is
 * drawn in the call and not in the lobby, so it stands for the call. The composer is CKEditor's editable, which that
 * client draws as `[data-tid="ckeditor"]` itself and other builds inside it. A message's element
 * (`[data-tid="chat-pane-message"]`, the message's id in its own id) holds the text in `div#content-<id>`, and the
 * author's name and the time sit beside it in the message's item, so the author is read from the item. The People key
 * is the roster key, read at its first shown match: a client may keep a hidden copy of it in the page, and draws keys
 * that name people without being it (Invite people), neither of which may stand for its count. The client the bot's
 * browser was served on 31 October 2026 finds no microphone or camera there and lays a dialog over the pre-join screen
 * ("Are you sure you don't want audio or video?") whose backdrop takes every click until its one key, Continue without
 * audio or video, is pressed; and it draws the bot's own message at once, reading "Sending..." where a message's time
 * goes, until the chat service takes it and gives it its time. It draws a message "Failed to send." for a moment even
 * when the service took it, then gives it its time about half a second later, as it drew every message a guest sent on
 * 31 October 2026 while the meeting's other side read each one once; a message the service refused keeps reading it.
 * Each message's item names its author, the bot's own messages under the name it joined with, and the client gives a
 * message a new id when the chat service takes it.
 */
export const SELECTORS = {
  continueInBrowser: 'button[data-tid="joinOnWeb"], button:has-text("Continue on this browser")',
  nameInput: '[data-tid="prejoin-display-name-input"], #prejoin-display-name-input',
  joinNow: 'button[data-tid="prejoin-join-button"]',
  /** The one key of the dialog laid over the pre-join screen in a browser with no microphone or camera. */
  deviceDialogContinue: 'button:has-text("Continue without audio or video")',
  /** The lobby's words: before the meeting has started, "Someone will let you in when the meeting starts." */
  lobbyText: 'text=/Someone in the meeting should let you in|When the meeting starts/i',
  /** The lobby screen, whatever its words say. */
  lobbyScreen: '[data-tid="calling-lobby-screen"]',
  callStage: '[data-tid="calling-stage"], #hangup-button',
  chatButton: 'button[aria-label*="Chat" i]',
  chatInput: '[data-tid="ckeditor"][contenteditable="true"], [data-tid="ckeditor"] [contenteditable="true"]',
  chatMessages: '[data-tid="chat-pane-message"]',
  /** The author's name, read from the message's item, which holds it beside the message's element. */
  chatMessageSender: 'xpath=ancestor::*[@data-tid="chat-pane-item"][1]//*[@data-tid="message-author-name"]',
  chatMessageText: '[data-tid="messageBodyContent"], [id^="content-"]',
  /** A message's item: the message's element, its author's name and, once the chat service took the message, its time. */
  chatMessageItem: '[data-tid="chat-pane-item"]',
  /** The author's name in a message's item: the bot's own messages carry the name it joined with. */
  chatMessageAuthor: '[data-tid="message-author-name"]',
  /** A message the chat service took: its time, in its item. */
  chatMessageSent: 'time[id^="timestamp-"]',
  /** A message drawn failed: "Failed to send." where its time goes, the client's Retry key beside it; for good when refused. */
  chatMessageFailed: '[data-tid="message-send-failed-title"], [data-tid="message-failed-retry"], [data-tid="message-sending-title"]:has-text("Failed to send")',
  /** The People key: the roster key, or a key named People and nothing else, never one that only names people. */
  participantsButton: '#roster-button, button[aria-label="People" i]',
  participantCount: '#roster-button, button[aria-label="People" i]',
  leaveButton: '#hangup-button, button[data-tid="hangup-main-btn"], button[aria-label*="Leave" i]',
};

/** How long one read of the page waits for its element: a missing element is a failed read, never a long stall. */
const READ_MS = 2_000;

/** How long the client may take to lay its device dialog over the pre-join screen once the name is in the field. */
const DIALOG_MS = 3_000;

/**
 * How long Join now is pressed for, and how many times at most: each press a short one of two seconds, so a device
 * dialog laid over it late is closed before the next, and each press, the dialog key's included, bounded by the time
 * left, so a dialog whose key takes no press never holds the join past it.
 */
const JOIN_MS = 30_000;
const JOIN_TRIES = 15;

/**
 * How long one send waits for the chat service's answer: the message's time, or "Failed to send.". A message with no
 * answer by then is not sent again, since the service may still take it and a second send would post the words twice.
 */
const ANSWER_MS = 15_000;

/**
 * How many times a message is sent before it is named refused, each send after a refusal waiting longer.
 */
const SENDS = 3;

/**
 * How long a message drawn failed is watched for its time before it is sent again, this many times the number of sends
 * so far (once, after the last send): the client draws a message the chat service took "Failed to send." for a moment.
 */
const RESEND_MS = 5_000;

/** The name each page's bot joined under, which marks its own messages in the chat. */
const botNames = new WeakMap<Page, string>();

/**
 * A join step that could not go on: its code, `join_<step>_<what held it>` or the adapter's own, and the outline of the
 * page the run's error report carries after it.
 */
class JoinStepError extends Error {
  constructor(
    code: string,
    readonly outline: string,
  ) {
    super(code);
    this.name = 'JoinStepError';
  }
}

/**
 * What held an action that did not happen, read from the last line Playwright's call log wrote for it: an element over
 * the control (`covered`, with the element's name), the control disabled (`disabled`), not editable (`readonly`), not
 * shown (`hidden`), found and never ready (`unready`), or never found (`missing`). The log's lines quote the page's
 * markup, so only Playwright's own words are read from them.
 */
function heldBy(err: unknown): { reason: string; cover?: string } {
  const log = err instanceof Error ? err.message : '';
  for (const line of log.split('\n').reverse()) {
    if (line.includes('intercepts pointer events')) return { reason: 'covered', cover: coverName(line) };
    if (line.includes('element is not enabled')) return { reason: 'disabled' };
    if (line.includes('element is not editable')) return { reason: 'readonly' };
    if (line.includes('element is not visible') || line.includes('element is outside of the viewport')) return { reason: 'hidden' };
    if (line.includes('element is not stable')) return { reason: 'unready' };
  }
  return { reason: log.includes('locator resolved to') ? 'unready' : 'missing' };
}

/**
 * The name of the element that covered a control, from the first element of Playwright's description of it: its
 * `data-tid`, the client's own name for it, else its Fluent UI class (`fui-DialogSurface__backdrop`), else its tag.
 * Never its text, its id or any other attribute.
 */
function coverName(line: string): string {
  const tag = /<([a-z][a-z0-9-]*)([^>]*)>/i.exec(line);
  if (!tag) return 'unread';
  const tid = /\bdata-tid="([a-z0-9][a-z0-9-]{0,59})"/i.exec(tag[2])?.[1];
  if (tid) return tid;
  const fui = /\bclass="(?:[^"]*\s)?(fui-[A-Za-z]+(?:__[A-Za-z]+)?)(?:[\s"])/.exec(tag[2])?.[1];
  return fui ?? tag[1].toLowerCase();
}

/**
 * The outline a failed join step leaves beside its code: the page's host and its path's first part, whether the device
 * dialog's key was pressed, what covered the control, and the hosts of the page's frames, such as the sign-in page the
 * launcher opens in one. Hosts, the client's own names and fixed words alone: never a query, a path past its first
 * part, nor a word the page shows.
 */
function joinOutline(page: Page, dialogPressed: boolean, cover?: string): string {
  const where = (url: string): { host: string; first: string } | undefined => {
    try {
      const parsed = new URL(url);
      if (!/^[a-z0-9.-]{1,253}$/i.test(parsed.hostname)) return undefined;
      const first = parsed.pathname.split('/').find(Boolean) ?? '';
      return { host: parsed.hostname.toLowerCase(), first: /^[a-z][a-z0-9_-]{0,30}$/i.test(first) ? first : '-' };
    } catch {
      return undefined;
    }
  };
  let top: { host: string; first: string } | undefined;
  let frames = 'unread';
  try {
    top = where(page.url());
    const main = page.mainFrame();
    const hosts = page
      .frames()
      .filter((frame) => frame !== main)
      .map((frame) => where(frame.url())?.host)
      .filter((host): host is string => host !== undefined);
    frames = [...new Set(hosts)].slice(0, 6).join(' ') || 'none';
  } catch {
    // a page closed under the step: its outline says what it could not read
  }
  return `page: ${top ? `${top.host} ${top.first}` : 'unread'}, dialog ${dialogPressed ? 'pressed' : 'none'}, cover ${cover ?? 'none'}, frames ${frames}`;
}

/**
 * Presses Join now, first pressing the key of the device dialog the client lays over the pre-join screen in a browser
 * with no microphone or camera, as the bot's has none: the dialog's backdrop takes every click until that key is
 * pressed. Each press of Join now is a short one, so a dialog laid over it after the first look is closed on the next.
 * `pressed.dialog` says whether the dialog's key was pressed, for the outline of a join that stops here.
 */
async function pressJoinNow(page: Page, pressed: { dialog: boolean }): Promise<void> {
  const joinNow = page.locator(SELECTORS.joinNow).first();
  const dialogKey = page.locator(SELECTORS.deviceDialogContinue).filter({ visible: true }).first();
  await dialogKey.waitFor({ timeout: DIALOG_MS }).catch(() => undefined); // a browser with a device is shown no dialog
  const deadline = Date.now() + JOIN_MS;
  const left = () => Math.max(1, deadline - Date.now()); // a timeout of 0 would wait without end
  for (let tries = 1; ; tries += 1) {
    // a dialog gone between the look and the press leaves the press to run out: the next round goes on to Join now
    if (await dialogKey.isVisible()) {
      await dialogKey.click({ timeout: Math.min(5_000, left()) }).then(
        () => {
          pressed.dialog = true;
        },
        () => undefined,
      );
    }
    try {
      await joinNow.click({ timeout: Math.min(2_000, left()) }); // enabled once the name is in the field
      return;
    } catch (err) {
      if (tries >= JOIN_TRIES || Date.now() >= deadline) throw err;
    }
  }
}

/**
 * The Microsoft Teams adapter: a guest join through the web client, with the name the person gave the bot. A join link
 * may open Teams' launcher first, which offers the app or this browser; the adapter takes the browser. Its checks read
 * what is visible, a read waits briefly for its element, and the chat is read only while its panel is open.
 */
export const microsoftTeamsAdapter: PlatformAdapter = {
  platform: 'microsoft_teams',
  selectorsVersion: '2026-10-31',
  joinHosts: ['teams.microsoft.com', 'teams.live.com'],
  // what the Teams client loads, with the hosts Microsoft's list of Microsoft 365 URLs and IP address ranges names as
  // required (https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges): its static CDN,
  // *.static.microsoft and *.usercontent.microsoft (ID 193), from which the launcher and the light-meetings client load
  // their scripts, and *.lync.com among the Teams hosts (ID 12); and Microsoft's sign-in CDN, *.msauth.net,
  // *.msauthimages.net and *.msftauthimages.net beside *.msftauth.net (ID 59), from which the sign-in page the launcher
  // opens in a frame, looking for a signed-in user, loads its scripts and images. A host the nightly check logs as
  // blocked is added here by a pull request
  allowedHosts: ['teams.microsoft.com', '*.teams.microsoft.com', 'teams.live.com', '*.teams.live.com', '*.microsoft.com', '*.live.com', '*.office.net', '*.office.com', '*.skype.com', '*.lync.com', '*.microsoftonline.com', '*.msecnd.net', '*.sharepointonline.com', '*.cloud.microsoft', '*.static.microsoft', '*.usercontent.microsoft', '*.trafficmanager.net', '*.azureedge.net', '*.msftauth.net', '*.msauth.net', '*.msauthimages.net', '*.msftauthimages.net'],
  async join(page, { meetingUrl, botName }): Promise<JoinOutcome> {
    // each step that cannot go on is named, with what held it and the page's outline: a join that fails explains itself
    const pressed = { dialog: false };
    const stopped = (code: string, cover?: string) => new JoinStepError(code, joinOutline(page, pressed.dialog, cover));
    const held = (step: string) => (err: unknown) => {
      const why = heldBy(err);
      throw stopped(`join_${step}_${why.reason}`, why.cover);
    };
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded' }).catch((err: unknown) => {
      throw stopped(err instanceof Error && err.name === 'TimeoutError' ? 'join_page_timeout' : 'join_page_failed');
    });
    const name = page.locator(SELECTORS.nameInput).first();
    const inBrowser = page.locator(SELECTORS.continueInBrowser).first();
    await name.or(inBrowser).first().waitFor({ timeout: 30_000 }).catch(() => {
      throw stopped('join_control_missing');
    });
    if (await inBrowser.isVisible()) await inBrowser.click({ timeout: 15_000 }).catch(held('continue'));
    await name.waitFor({ timeout: 30_000 }).catch(() => {
      throw stopped('join_control_missing');
    });
    await name.fill(botName, { timeout: 15_000 }).catch(held('name')); // a guest join: the name the person gave the bot
    botNames.set(page, botName);
    await pressJoinNow(page, pressed).catch(held('now'));
    const lobby = page.locator(SELECTORS.lobbyText).or(page.locator(SELECTORS.lobbyScreen));
    const stage = page.locator(SELECTORS.callStage).filter({ visible: true });
    // one wait on either screen, on the first of them shown: two waits raced against each other would leave the loser's
    // timeout rejecting unheard, and a screen the client keeps in the page unshown would hold a wait on its first match
    await lobby.or(stage).filter({ visible: true }).first().waitFor({ timeout: 30_000 }).catch(() => {
      throw stopped('join_outcome_missing');
    });
    return { state: (await stage.first().isVisible()) ? 'in_call' : 'waiting_room' };
  },
  async waitForCall(page, timeoutMs) {
    try {
      await page.locator(SELECTORS.callStage).filter({ visible: true }).first().waitFor({ timeout: timeoutMs });
    } catch {
      throw new Error('not_admitted');
    }
  },
  async postChat(page, text) {
    const input = page.locator(SELECTORS.chatInput).first();
    if (!(await input.isVisible())) await page.locator(SELECTORS.chatButton).first().click(); // the panel opens on its button
    // the bot's own messages with these words, in the order the chat draws them: each send draws one more, at the end.
    // A participant may post the same words, so the bot's own are those under its name, and the message a send drew is
    // known by its place among them, since the client gives a message a new id when the chat service takes it
    const name = botNames.get(page);
    let items = page.locator(SELECTORS.chatMessageItem).filter({ hasText: text.slice(0, 40) });
    if (name) items = items.filter({ has: page.locator(SELECTORS.chatMessageAuthor, { hasText: name }) });
    for (let send = 1; send <= SENDS; send += 1) {
      const before = await items.count();
      await input.fill(text);
      await input.press('Enter');
      const item = items.nth(before); // the message this send drew
      const sent = item.locator(SELECTORS.chatMessageSent);
      // the chat service's answer: the message's time when it took it, "Failed to send." when it refused it, which
      // reached nobody. A message still "Sending..." when the wait runs out is never sent again: the service may take it
      // later, and a second send would put the words in the chat twice
      const answered = await sent
        .or(item.locator(SELECTORS.chatMessageFailed))
        .first()
        .waitFor({ timeout: ANSWER_MS })
        .then(
          () => true,
          () => false,
        );
      if (!answered) throw new Error('chat_send_unanswered');
      if ((await sent.count()) > 0) return; // posted: the service took it
      // drawn failed: the client draws "Failed to send." for a moment on a message the service took, and its time a
      // moment later, so the message is watched for its time through the pause before the next send, and is sent again
      // only when it still reads failed; a second send of a message the service took would post its words twice
      const pause = RESEND_MS * (send < SENDS ? send : 1);
      const late = await sent.first().waitFor({ timeout: pause }).then(
        () => true,
        () => false,
      );
      if (late) return;
    }
    throw new Error('chat_send_failed');
  },
  async observeChat(page, onMessage: (message: ChatMessage) => void): Promise<ChatObserver> {
    const seen = new Set<string>();
    let lastGood: number | undefined;
    let polling = false;
    const poll = async (): Promise<void> => {
      // the panel must be open to be read: a closed panel's messages can sit in the page with nobody reading new ones
      if (!(await page.locator(SELECTORS.chatInput).first().isVisible())) throw new Error('chat_panel_closed');
      for (const node of await page.locator(SELECTORS.chatMessages).all()) {
        const id = await messageKey(node, 'id', READ_MS);
        if (seen.has(id)) continue;
        const sender = (await node.locator(SELECTORS.chatMessageSender).first().innerText({ timeout: READ_MS }).catch(() => '')).trim() || 'participant';
        // the body alone: the card's own text holds the author's name and the time too, so a card without a body element
        // gives its own text, marked as not read from a body
        const body = await node.locator(SELECTORS.chatMessageText).first().innerText({ timeout: READ_MS }).catch(() => '');
        const text = body || (await node.innerText({ timeout: READ_MS }));
        seen.add(id); // a message counts as seen once it is read through: one whose read failed is read again next time
        onMessage({ sender, text, bodyRead: body !== '' });
      }
      lastGood = Date.now(); // a poll that read the panel through is the fact a heartbeat rests on
    };
    await poll(); // the first observation, now: the heartbeat that opens capture is reported from it
    const timer = setInterval(() => {
      if (polling) return; // one poll at a time: a slow read never overlaps the next
      polling = true;
      void poll()
        .catch(() => undefined) // a failed poll leaves lastGood where it was, which is how the bot learns the chat went unread
        .finally(() => {
          polling = false;
        });
    }, 1_000);
    return { stop: () => clearInterval(timer), lastGoodPollAt: () => lastGood };
  },
  async participantCount(page) {
    // the first People key shown: a copy of it the client keeps hidden in the page is never read
    const key = page.locator(SELECTORS.participantCount).filter({ visible: true }).first();
    const text = await key.innerText({ timeout: READ_MS }).catch(() => undefined);
    if (text === undefined) return undefined; // a key not read is no count
    const digits = text.replace(/\D/g, '');
    // the client writes no number on its People key while one person, the bot, is in the call ("People", then "2 People");
    // other words with no number count no one, so they never read as the bot alone, which would make it leave a call
    // that still has people in it
    if (digits === '') return /^people$/i.test(text.trim()) ? 0 : undefined;
    return Math.max(0, Number.parseInt(digits, 10) - 1); // the client's count holds the bot
  },
  async leave(page) {
    await page.locator(SELECTORS.leaveButton).first().click({ timeout: 5_000 }).catch(() => undefined);
  },
  async needsReauth() {
    return false; // a guest join: no identity to sign in again
  },
};
