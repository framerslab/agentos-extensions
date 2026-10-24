import type { Locator, Page } from 'playwright';
import { messageKey } from './message-key.js';
import type { ChatMessage, ChatObserver, JoinOutcome, PlatformAdapter } from './types.js';

/**
 * The Google Meet web client's selectors. Every entry is one Playwright selector engine: CSS (a comma list of CSS
 * selectors included), one `text=` selector, or one `role=` selector, which finds an element by its role and its
 * accessible name and so survives a suffix on a label and a wrapper the label sits on; never two engines in one string,
 * which Playwright reads as CSS and refuses.
 *
 * The pre-join screen and the call's grid are a first reading of the client. The chat is read as open-source Meet
 * clients read it in 2026, after the nightly real-join check's Meet run of 24 October 2026 found no textarea to type
 * the notice into: the toolbar's Chat key is a button named "Chat with everyone"; the composer is a `<textarea>`
 * labelled "Send a message" in a meeting whose chat is Meet's own, and Google Chat's editable in a meeting whose chat
 * is a Google Chat conversation (Workspace's Chat in Meet: the chat of a meeting scheduled in Calendar, for the host's
 * own domain), a `contenteditable` div with the textbox role labelled "History is on", which one reading of April 2026
 * found under a wrapper that carries the "Send a message" label instead; a message is the element that carries its
 * `data-message-id` (in a Google Chat conversation, the message's name, `spaces/…/messages/…`), an attribute the Pin
 * key drawn beside the message carries too. A failure the nightly check finds updates this table and the adapter's
 * `selectorsVersion`.
 */
export const SELECTORS = {
  nameInput: 'input[aria-label="Your name"]',
  cameraOff: 'div[role="button"][aria-label*="camera" i][data-is-muted="false"]',
  microphoneOff: 'div[role="button"][aria-label*="microphone" i][data-is-muted="false"]',
  joinNow: 'button:has-text("Join now")',
  askToJoin: 'button:has-text("Ask to join")',
  waitingText: 'text=/Asking to join|Someone will let you in|You.ll join the call when someone lets you in/i',
  callGrid: 'div[data-participant-id], div[data-self-name]',
  /** The toolbar's Chat key by its role and the start of its name, so a suffix on the label still matches. */
  chatButton: 'role=button[name=/^chat with everyone/i]',
  /** The same key by its markup, as the client drew it before: a button, or a div with the button role. */
  chatButtonLegacy: 'button[aria-label^="Chat with everyone" i], div[role="button"][aria-label^="Chat with everyone" i]',
  /** The composer by its role and its name: the textarea named "Send a message", or Google Chat's editable named for the chat's history. */
  chatInput: 'role=textbox[name=/^(send a message|history is o)/i]',
  /** The textarea by its markup, whatever follows "Send a message" in its label. */
  chatInputLegacy: 'textarea[aria-label^="Send a message" i]',
  /** Google Chat's editable by its shape, whatever language its label is in: an editable textbox, or the editable under the wrapper that carries the label. */
  chatInputEditable: '[role="textbox"][contenteditable]:not([contenteditable="false"]), [aria-label^="Send a message" i] [contenteditable]:not([contenteditable="false"])',
  /** The composer's Send key, pressed when Enter left the message in the composer. */
  chatSendButton: 'role=button[name=/^send (a )?message/i]',
  /** A message: the element carrying the client's id for it, never the Pin key beside it that carries the same id, or an element with its sender's name. The bot reads its own message back from these, the shapes its observer reads. */
  chatMessages: '[data-message-id]:not(button):not([role="button"]), div[jsname][data-sender-name]',
  chatMessageSender: '[data-sender-name]',
  chatMessageText: '[data-message-text], div[jsname] > div:last-child',
  /** A tip the client lays over the call once the bot is in it, closed by its one key before the chat is opened. */
  dismissButton: 'role=button[name=/^(got it|dismiss|not now|no thanks)$/i]',
  participantsButton: 'button[aria-label*="People" i]',
  participantCount: 'div[aria-label*="People" i] span, button[aria-label*="People" i] div[class]',
  leaveButton: 'button[aria-label="Leave call"]',
  signInEmail: 'input[type="email"]',
  signInText: 'text=/Sign in|Verify it.s you/i',
};

/** How long one read of the page waits for its element: a missing element is a failed read, never a long stall. */
const READ_MS = 2_000;

/**
 * How long each step of posting a message waits, so no step waits out Playwright's own thirty seconds unnamed:
 * `stepMs` for the Chat key's click and for the composer to show after it, `shortcutMs` for the composer to show after
 * the keyboard shortcut, `echoMs` for the message to be read back from the panel, and `pollMs` between two reads of the
 * page. The adapter's tests shorten them.
 */
export const MEET_CHAT_TIMING = { stepMs: 10_000, shortcutMs: 5_000, echoMs: 10_000, pollMs: 250 };

/** The composer's shapes, in the order they are tried: by role and name, then the textarea, then the editable by its shape. */
const COMPOSER = [SELECTORS.chatInput, SELECTORS.chatInputLegacy, SELECTORS.chatInputEditable];
/** The Chat key's shapes: by role and name, then by markup. */
const CHAT_KEY = [SELECTORS.chatButton, SELECTORS.chatButtonLegacy];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Locators on the first element of each of the selectors, in the selectors' order. */
const each = (page: Page, selectors: readonly string[]): Locator[] => selectors.map((selector) => page.locator(selector).first());

/** The first of the candidates that shows an element, or undefined when none does; each read is immediate. */
async function shown(candidates: readonly Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) if (await candidate.isVisible()) return candidate;
  return undefined;
}

/** Waits up to `timeoutMs` for one of the candidates to show an element, reading them every `pollMs`. */
async function shownWithin(candidates: readonly Locator[], timeoutMs: number): Promise<Locator | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await shown(candidates);
    if (found || Date.now() >= deadline) return found;
    await sleep(MEET_CHAT_TIMING.pollMs);
  }
}

/** Waits up to `timeoutMs` for the locator to find more than `than` elements, counting them every `pollMs`. */
async function moreWithin(locator: Locator, than: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await locator.count()) > than) return true;
    if (Date.now() >= deadline) return false;
    await sleep(MEET_CHAT_TIMING.pollMs);
  }
}

/** The action's result, or, when the action fails, an error named for its step: the run's report carries the step, never Playwright's words. */
function step<T>(action: Promise<T>, code: string): Promise<T> {
  return action.catch(() => {
    throw new Error(code);
  });
}

/** The text a composer holds: a textarea's value, an editable's content; empty when it cannot be read within the step's wait (a locator's read waits for its element without limit unless told one). */
function composerText(input: Locator): Promise<string> {
  return input
    .evaluate((el: { value?: unknown; textContent: string | null }) => (typeof el.value === 'string' ? el.value : el.textContent) ?? '', undefined, { timeout: MEET_CHAT_TIMING.stepMs })
    .catch(() => '');
}

/** Whether the page shows a sign-in challenge: Google's sign-in form, or a sign-in or verification prompt. */
async function signInShown(page: Page): Promise<boolean> {
  return page.locator(SELECTORS.signInEmail).or(page.locator(SELECTORS.signInText)).first().isVisible();
}

/** Closes the tips the client lays over the call once the bot is in it, each by its one key; a tip that stays is left to the step that follows. */
async function dismissTips(page: Page): Promise<void> {
  for (const tip of await page.locator(SELECTORS.dismissButton).all()) {
    if (await tip.isVisible()) await tip.click({ timeout: READ_MS }).catch(() => undefined);
  }
}

/**
 * Opens the chat panel and resolves with its composer: the toolbar's Chat key, else Meet's keyboard shortcut for showing
 * the chat window (Ctrl+Alt+c). The way that failed is named: `chat_button_missing` when no key was shown and the
 * shortcut opened nothing, `chat_button_blocked` when the key would not take the click (a dialog over it) and the
 * shortcut opened nothing, `chat_input_missing` when the panel opened on the key without a composer the adapter knows.
 */
async function openChat(page: Page): Promise<Locator> {
  await dismissTips(page);
  const composer = each(page, COMPOSER);
  const key = await shown(each(page, CHAT_KEY));
  let failed = 'chat_button_missing';
  if (key) {
    const clicked = await key.click({ timeout: MEET_CHAT_TIMING.stepMs }).then(() => true, () => false);
    if (clicked) {
      const input = await shownWithin(composer, MEET_CHAT_TIMING.stepMs);
      if (input) return input;
      throw new Error('chat_input_missing');
    }
    failed = 'chat_button_blocked';
  }
  await page.keyboard.press('Control+Alt+c'); // show or hide the meeting chat window, Meet's own shortcut
  const input = await shownWithin(composer, MEET_CHAT_TIMING.shortcutMs);
  if (input) return input;
  throw new Error(failed);
}

/**
 * The Google Meet adapter. Its checks read what is visible, since the client keeps screens it is not showing in the
 * page; a read waits briefly for its element, and the chat is read only while its panel is open.
 */
export const googleMeetAdapter: PlatformAdapter = {
  platform: 'google_meet',
  // the chat read from open-source Meet clients' readings of 2026 and the nightly check of that night, not from the live client itself
  selectorsVersion: '2026-10-24',
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
    // the composer, whichever shape the client drew; the panel is opened when none shows
    const input = (await shown(each(page, COMPOSER))) ?? (await openChat(page));
    // the message is read back as a new message among those the observer reads: one the panel held before the send,
    // the bot's own notice after a rejoin among them, never stands for the one being sent
    const echoes = page.locator(SELECTORS.chatMessages).filter({ hasText: text.slice(0, 40) });
    const before = await echoes.count();
    await step(input.fill(text, { timeout: MEET_CHAT_TIMING.stepMs }), 'chat_input_blocked'); // a textarea or an editable alike
    await step(input.press('Enter', { timeout: MEET_CHAT_TIMING.stepMs }), 'chat_enter_blocked'); // both composers send on Enter
    if (await moreWithin(echoes, before, MEET_CHAT_TIMING.echoMs)) return;
    // nothing new read back and the text still in the composer: Enter did not send it, and its Send key is pressed once
    if ((await composerText(input)).includes(text.slice(0, 40))) {
      const send = await shown(each(page, [SELECTORS.chatSendButton]));
      if (send) {
        await send.click({ timeout: MEET_CHAT_TIMING.stepMs }).catch(() => undefined);
        if (await moreWithin(echoes, before, MEET_CHAT_TIMING.echoMs)) return;
      }
    }
    throw new Error('chat_echo_missing');
  },
  async observeChat(page, onMessage: (message: ChatMessage) => void): Promise<ChatObserver> {
    const seen = new Set<string>();
    let lastGood: number | undefined;
    let polling = false;
    const poll = async (): Promise<void> => {
      // the panel must be open to be read: a closed panel's messages can sit in the page with nobody reading new ones
      if (!(await shown(each(page, COMPOSER)))) throw new Error('chat_panel_closed');
      for (const node of await page.locator(SELECTORS.chatMessages).all()) {
        const id = await messageKey(node, 'data-message-id', READ_MS);
        if (seen.has(id)) continue;
        const sender = (await node.locator(SELECTORS.chatMessageSender).first().innerText({ timeout: READ_MS }).catch(() => '')).trim() || 'participant';
        // a message without a text element is read from its whole element, the sender's name on a line of its own
        const body = await node.locator(SELECTORS.chatMessageText).first().innerText({ timeout: READ_MS }).catch(() => '');
        const text = body || (await node.innerText({ timeout: READ_MS }));
        seen.add(id); // a message counts as seen once it is read through: one whose read failed is read again next time
        // every message goes on, the bot's own among them: a sender shown as You can be a participant of that name, and
        // the bot skips the texts it posted itself
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
  async needsReauth(page) {
    return signInShown(page);
  },
};
