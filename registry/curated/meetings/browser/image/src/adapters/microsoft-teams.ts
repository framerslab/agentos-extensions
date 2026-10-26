import type { Page } from 'playwright';
import { messageKey } from './message-key.js';
import type { ChatMessage, ChatObserver, JoinOutcome, PlatformAdapter } from './types.js';

/**
 * The Microsoft Teams web client's selectors: a first reading of the client, which the nightly real-join check
 * settles; each failure it finds updates this table and the adapter's `selectorsVersion`. Every entry is one Playwright
 * selector: CSS (a comma list of CSS selectors included) or one `text=` selector, never the two mixed in one string.
 * The chat's composer and a message's body are as open-source Teams clients read them: the composer is CKEditor's
 * editable, which some builds draw inside `[data-tid="ckeditor"]` and others as that element itself, and a message
 * card's text is in its body, apart from the author's name and the time the card also shows.
 */
export const SELECTORS = {
  continueInBrowser: 'button[data-tid="joinOnWeb"], button:has-text("Continue on this browser")',
  nameInput: '#prejoin-display-name-input',
  joinNow: 'button[data-tid="prejoin-join-button"]',
  lobbyText: 'text=/Someone in the meeting should let you in|When the meeting starts/i',
  callStage: '[data-tid="calling-stage"]',
  chatButton: 'button[aria-label*="Chat" i]',
  chatInput: '[data-tid="ckeditor"][contenteditable="true"], [data-tid="ckeditor"] [contenteditable="true"]',
  chatMessages: '[data-tid="chat-pane-message"]',
  chatMessageSender: '[data-tid="message-author-name"]',
  chatMessageText: '[data-tid="messageBodyContent"]',
  participantsButton: 'button[aria-label*="People" i]',
  participantCount: 'button[aria-label*="People" i]',
  leaveButton: 'button[data-tid="hangup-main-btn"], button[aria-label*="Leave" i]',
};

/** How long one read of the page waits for its element: a missing element is a failed read, never a long stall. */
const READ_MS = 2_000;

/**
 * The Microsoft Teams adapter: a guest join through the web client, with the name the person gave the bot. A join link
 * may open Teams' launcher first, which offers the app or this browser; the adapter takes the browser. Its checks read
 * what is visible, a read waits briefly for its element, and the chat is read only while its panel is open.
 */
export const microsoftTeamsAdapter: PlatformAdapter = {
  platform: 'microsoft_teams',
  selectorsVersion: '2026-10-11',
  joinHosts: ['teams.microsoft.com', 'teams.live.com'],
  // the writer's first reading of what the Teams client loads; a host the nightly check logs as blocked is added here by a pull request
  allowedHosts: ['teams.microsoft.com', '*.teams.microsoft.com', 'teams.live.com', '*.teams.live.com', '*.microsoft.com', '*.live.com', '*.office.net', '*.office.com', '*.skype.com', '*.microsoftonline.com', '*.msecnd.net', '*.sharepointonline.com', '*.cloud.microsoft', '*.trafficmanager.net', '*.azureedge.net', '*.msftauth.net'],
  async join(page, { meetingUrl, botName }): Promise<JoinOutcome> {
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded' });
    const name = page.locator(SELECTORS.nameInput).first();
    const inBrowser = page.locator(SELECTORS.continueInBrowser).first();
    await name.or(inBrowser).first().waitFor({ timeout: 30_000 }).catch(() => {
      throw new Error('join_control_missing');
    });
    if (await inBrowser.isVisible()) await inBrowser.click();
    await name.waitFor({ timeout: 30_000 }).catch(() => {
      throw new Error('join_control_missing');
    });
    await name.fill(botName); // a guest join: the name the person gave the bot
    await page.locator(SELECTORS.joinNow).first().click({ timeout: 30_000 });
    const lobby = page.locator(SELECTORS.lobbyText);
    const stage = page.locator(SELECTORS.callStage);
    // one wait on either screen: two waits raced against each other would leave the loser's timeout rejecting unheard
    await lobby.or(stage).first().waitFor({ timeout: 30_000 }).catch(() => {
      throw new Error('join_outcome_missing');
    });
    return { state: (await stage.first().isVisible()) ? 'in_call' : 'waiting_room' };
  },
  async waitForCall(page, timeoutMs) {
    try {
      await page.locator(SELECTORS.callStage).first().waitFor({ timeout: timeoutMs });
    } catch {
      throw new Error('not_admitted');
    }
  },
  async postChat(page, text) {
    const input = page.locator(SELECTORS.chatInput).first();
    if (!(await input.isVisible())) await page.locator(SELECTORS.chatButton).first().click(); // the panel opens on its button
    await input.fill(text);
    await input.press('Enter');
    await page.locator(SELECTORS.chatMessages).filter({ hasText: text.slice(0, 40) }).first().waitFor({ timeout: 10_000 });
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
    const text = await page.locator(SELECTORS.participantCount).first().innerText({ timeout: READ_MS }).catch(() => '');
    const n = Number.parseInt(text.replace(/\D/g, ''), 10);
    return Number.isFinite(n) ? Math.max(0, n - 1) : undefined; // the client's count holds the bot
  },
  async leave(page) {
    await page.locator(SELECTORS.leaveButton).first().click({ timeout: 5_000 }).catch(() => undefined);
  },
  async needsReauth() {
    return false; // a guest join: no identity to sign in again
  },
};
