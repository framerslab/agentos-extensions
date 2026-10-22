import type { Page } from 'playwright';
import { messageKey } from './message-key.js';
import type { ChatMessage, ChatObserver, JoinOutcome, PlatformAdapter } from './types.js';

/**
 * The Google Meet web client's selectors: a first reading of the client, which the nightly real-join check settles;
 * each failure it finds updates this table and the adapter's `selectorsVersion`. Every entry is one Playwright
 * selector: CSS (a comma list of CSS selectors included) or one `text=` selector, never the two mixed in one string,
 * which Playwright reads as CSS and refuses.
 */
export const SELECTORS = {
  nameInput: 'input[aria-label="Your name"]',
  cameraOff: 'div[role="button"][aria-label*="camera" i][data-is-muted="false"]',
  microphoneOff: 'div[role="button"][aria-label*="microphone" i][data-is-muted="false"]',
  joinNow: 'button:has-text("Join now")',
  askToJoin: 'button:has-text("Ask to join")',
  waitingText: 'text=/Asking to join|Someone will let you in|You.ll join the call when someone lets you in/i',
  callGrid: 'div[data-participant-id], div[data-self-name]',
  chatButton: 'button[aria-label="Chat with everyone"]',
  chatInput: 'textarea[aria-label="Send a message"]',
  chatMessages: 'div[data-message-id], div[jsname][data-sender-name]',
  chatMessageSender: '[data-sender-name]',
  chatMessageText: '[data-message-text], div[jsname] > div:last-child',
  participantsButton: 'button[aria-label*="People" i]',
  participantCount: 'div[aria-label*="People" i] span, button[aria-label*="People" i] div[class]',
  leaveButton: 'button[aria-label="Leave call"]',
  signInEmail: 'input[type="email"]',
  signInText: 'text=/Sign in|Verify it.s you/i',
};

/** How long one read of the page waits for its element: a missing element is a failed read, never a long stall. */
const READ_MS = 2_000;

/** Whether the page shows a sign-in challenge: Google's sign-in form, or a sign-in or verification prompt. */
async function signInShown(page: Page): Promise<boolean> {
  return page.locator(SELECTORS.signInEmail).or(page.locator(SELECTORS.signInText)).first().isVisible();
}

/**
 * The Google Meet adapter. Its checks read what is visible, since the client keeps screens it is not showing in the
 * page; a read waits briefly for its element, and the chat is read only while its panel is open.
 */
export const googleMeetAdapter: PlatformAdapter = {
  platform: 'google_meet',
  selectorsVersion: '2026-10-11',
  // Google's sign-in host is on it so that a challenge to the identity loads, where needsReauth can see it
  joinHosts: ['meet.google.com', 'accounts.google.com'],
  // the writer's first reading of what the Meet client loads; a host the nightly check logs as blocked is added here by a pull request
  allowedHosts: ['meet.google.com', 'accounts.google.com', '*.google.com', '*.googleapis.com', '*.gstatic.com', '*.googleusercontent.com', '*.googlevideo.com', '*.ggpht.com'],
  async join(page, { meetingUrl, botName, signedIn }): Promise<JoinOutcome> {
    await page.goto(meetingUrl, { waitUntil: 'domcontentloaded' });
    const joinNow = page.locator(SELECTORS.joinNow).first();
    const ask = page.locator(SELECTORS.askToJoin).first();
    // the client draws its pre-join screen after the document has loaded: its join control is the sign that it is ready
    const ready = await joinNow.or(ask).first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (signedIn && (await signInShown(page))) throw new Error('needs_reauth'); // a signed-out identity never knocks as a guest
    if (!ready) throw new Error('join_control_missing');
    const name = page.locator(SELECTORS.nameInput).first();
    if (await name.isVisible()) await name.fill(botName); // a guest join; a signed-in identity shows no name field
    for (const control of [SELECTORS.cameraOff, SELECTORS.microphoneOff]) {
      const button = page.locator(control).first();
      if (await button.isVisible()) await button.click();
    }
    if (await joinNow.isVisible()) await joinNow.click();
    else await ask.click();
    const waiting = page.locator(SELECTORS.waitingText);
    const grid = page.locator(SELECTORS.callGrid);
    // one wait on either screen: two waits raced against each other would leave the loser's timeout rejecting unheard
    await waiting.or(grid).first().waitFor({ timeout: 30_000 }).catch(() => {
      throw new Error('join_outcome_missing');
    });
    return { state: (await grid.first().isVisible()) ? 'in_call' : 'waiting_room' };
  },
  async waitForCall(page, timeoutMs) {
    try {
      await page.locator(SELECTORS.callGrid).first().waitFor({ timeout: timeoutMs });
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
        const id = await messageKey(node, 'data-message-id', READ_MS);
        if (seen.has(id)) continue;
        const sender = (await node.locator(SELECTORS.chatMessageSender).first().innerText({ timeout: READ_MS }).catch(() => '')).trim() || 'participant';
        const text = (await node.locator(SELECTORS.chatMessageText).first().innerText({ timeout: READ_MS }).catch(() => '')) || (await node.innerText({ timeout: READ_MS }));
        seen.add(id); // a message counts as seen once it is read through: one whose read failed is read again next time
        // every message goes on, the bot's own among them: a sender shown as You can be a participant of that name, and
        // the bot skips the texts it posted itself
        onMessage({ sender, text, bodyRead: true });
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
  async needsReauth(page) {
    return signInShown(page);
  },
};
