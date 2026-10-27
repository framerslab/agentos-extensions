import type { Frame, Locator, Page } from 'playwright';
import { ChatStepError, panelOutline } from './chat-outline.js';
import { messageKey } from './message-key.js';
import type { ChatMessage, ChatObserver, JoinOutcome, PlatformAdapter } from './types.js';

/**
 * The Google Meet web client's selectors. Every entry is one Playwright selector engine: CSS (a comma list of CSS
 * selectors included), one `text=` selector, or one `role=` selector, which finds an element by its role and its
 * accessible name and so survives a suffix on a label and a wrapper the label sits on; never two engines in one string,
 * which Playwright reads as CSS and refuses.
 *
 * The pre-join screen and the call's grid are a first reading of the client. The chat is read as open-source Meet
 * clients read it in 2026, after the nightly real-join check's Meet runs of 24 and 25 October 2026: the toolbar's Chat
 * key is a button named "Chat with everyone"; the composer is a `<textarea>` labelled "Send a message" in a meeting
 * whose chat is Meet's own, and Google Chat's editable in a meeting whose chat is a Google Chat conversation
 * (Workspace's Chat in Meet: the chat of a meeting scheduled in Calendar, for the host's own domain), a `contenteditable`
 * div with the textbox role labelled "History is on", which one reading of April 2026 found under a wrapper that carries
 * the "Send a message" label instead. A Google Chat conversation's panel draws that editable, its Send key and its
 * messages inside a frame the panel embeds, on chat.google.com, so the adapter looks for the composer in every frame of
 * the page and reads the messages from the frame the composer is in. A message is the element that carries its
 * `data-message-id` (in a Google Chat conversation, the message's name, `spaces/…/messages/…`), an attribute the Pin
 * key drawn beside the message carries too. The nightly check's Meet run of 27 October 2026 found the composer drawn
 * under another label, in the side panel the Chat key opens (a complementary landmark), disabled and aria-disabled: the
 * meeting's chat was off for the bot, a signed-in guest from another organisation. So once the panel has opened on its
 * key, the composer is also read by its shape and its place alone (`chatInputInPanel`), whatever its label, and a
 * composer the client draws disabled, read-only or aria-disabled is named for that state at once. A failure the nightly
 * check finds updates this table and the adapter's `selectorsVersion`.
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
  /**
   * The composer by its shape and its place alone, whatever its label: a textarea, a textbox or an editable inside the
   * side panel the Chat key opens, which the client draws as a complementary landmark (an `aside`, or the role written
   * on a div). Read only once the panel has opened on the key, and in the chat observer's reads, never before the key
   * is pressed: another panel's field would stand for the composer otherwise.
   */
  chatInputInPanel:
    'aside textarea, [role="complementary"] textarea, aside [role="textbox"], [role="complementary"] [role="textbox"], aside [contenteditable]:not([contenteditable="false"]), [role="complementary"] [contenteditable]:not([contenteditable="false"])',
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

/** One way of finding the composer: its name in the outline a failed step carries, and its selector. */
type Lookup = readonly [lookup: string, selector: string];
/** The composer's shapes known by their names, in the order they are tried: by role and name, then the textarea, then the editable by its shape. */
const COMPOSER: readonly Lookup[] = [
  ['role', SELECTORS.chatInput],
  ['textarea', SELECTORS.chatInputLegacy],
  ['editable', SELECTORS.chatInputEditable],
];
/** The composer's shapes once the panel is open: the known ones first, then the panel's composer by its shape and its place, whatever its label. */
const COMPOSER_IN_PANEL: readonly Lookup[] = [...COMPOSER, ['panel', SELECTORS.chatInputInPanel]];
/** The Chat key's shapes: by role and name, then by markup. */
const CHAT_KEY = [SELECTORS.chatButton, SELECTORS.chatButtonLegacy];
/** The composer's lookups as the outline names them. */
const COMPOSER_TRIED = `composer:${COMPOSER_IN_PANEL.map(([lookup]) => lookup).join(',')}`;

/** A composer the page shows: its element, the frame it is in (the messages and the Send key are in the same frame), and the lookup that found it. */
interface Composer {
  input: Locator;
  frame: Frame;
  lookup: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Locators on the first element of each of the selectors in the page's main frame, in the selectors' order. */
const each = (page: Page, selectors: readonly string[]): Locator[] => selectors.map((selector) => page.locator(selector).first());

/**
 * Every frame of the page as it holds them now: the main frame first, then the frames the page embeds, in the page's
 * order. A page-level locator is the main frame's and never enters a frame, so the composer a Google Chat conversation's
 * panel draws in its own frame is found only by looking in each frame; the frames are read anew on each call, since the
 * chat's frame attaches after the panel opens.
 */
function framesOf(page: Page): Frame[] {
  const main = page.mainFrame();
  return [main, ...page.frames().filter((frame) => frame !== main)];
}

/** The first of the candidates that shows an element, or undefined when none does; each read is immediate. */
async function shown(candidates: readonly Locator[]): Promise<Locator | undefined> {
  for (const candidate of candidates) if (await candidate.isVisible().catch(() => false)) return candidate;
  return undefined;
}

/** The first of the composer's shapes shown in any frame of the page, the main frame first, in the lookups' order; each read is immediate, and a frame between documents shows nothing. */
async function composerShown(page: Page, lookups: readonly Lookup[] = COMPOSER): Promise<Composer | undefined> {
  for (const frame of framesOf(page)) {
    for (const [lookup, selector] of lookups) {
      const input = frame.locator(selector).first();
      if (await input.isVisible().catch(() => false)) return { input, frame, lookup };
    }
  }
  return undefined;
}

/** Waits up to `timeoutMs` for one of the composer's shapes to show in any frame of the page, reading the frames every `pollMs`. */
async function composerWithin(page: Page, timeoutMs: number, lookups: readonly Lookup[] = COMPOSER): Promise<Composer | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await composerShown(page, lookups);
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

/**
 * The error a failed step of posting a message throws: its code, which the run's report carries (never Playwright's
 * words), and the panel's outline with the lookups the step tried, read within the outline's own time, so the next
 * failure explains itself.
 */
async function failed(page: Page, code: string, tried: string): Promise<ChatStepError> {
  return new ChatStepError(code, await panelOutline(page, tried).catch(() => undefined));
}

/** The action's result, or, when the action fails, the error named for its step with the panel's outline. */
async function step<T>(page: Page, action: Promise<T>, code: string, tried: string): Promise<T> {
  try {
    return await action;
  } catch {
    throw await failed(page, code, tried);
  }
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
 * Opens the chat panel and resolves with its composer, in whichever frame the panel draws it: the toolbar's Chat key,
 * else Meet's keyboard shortcut for showing the chat window (Ctrl+Alt+c). Once the panel has opened, the composer is
 * read by its known shapes and then by its shape and its place in the panel, whatever its label. The way that failed is
 * named, and its error carries the panel's outline: `chat_button_missing` when no key was shown and the shortcut opened
 * nothing, `chat_button_blocked` when the key would not take the click (a dialog over it) and the shortcut opened
 * nothing, `chat_input_missing` when the panel opened on the key without a composer-shaped control in any frame.
 */
async function openChat(page: Page): Promise<Composer> {
  await dismissTips(page);
  const key = await shown(each(page, CHAT_KEY));
  let code = 'chat_button_missing';
  if (key) {
    const clicked = await key.click({ timeout: MEET_CHAT_TIMING.stepMs }).then(() => true, () => false);
    if (clicked) {
      const composer = await composerWithin(page, MEET_CHAT_TIMING.stepMs, COMPOSER_IN_PANEL);
      if (composer) return composer;
      throw await failed(page, 'chat_input_missing', COMPOSER_TRIED);
    }
    code = 'chat_button_blocked';
  }
  await page.keyboard.press('Control+Alt+c'); // show or hide the meeting chat window, Meet's own shortcut
  const composer = await composerWithin(page, MEET_CHAT_TIMING.shortcutMs, COMPOSER_IN_PANEL);
  if (composer) return composer;
  throw await failed(page, code, `key:role,markup shortcut ${COMPOSER_TRIED}`);
}

/**
 * Whether the composer takes text, by Playwright's own reading of an editable element: enabled (no `disabled` attribute
 * on it or its fieldset, no `aria-disabled="true"` on it or above it) and not read-only (no `readonly` attribute, no
 * `aria-readonly="true"`). A read that cannot answer, an element of a kind Playwright does not read so, counts as
 * editable: the fill that follows then names the step as before.
 */
function takesText(input: Locator): Promise<boolean> {
  return input.isEditable({ timeout: MEET_CHAT_TIMING.stepMs }).catch(() => true);
}

/**
 * The Google Meet adapter. Its checks read what is visible, since the client keeps screens it is not showing in the
 * page; a read waits briefly for its element, and the chat is read only while its panel is open.
 */
export const googleMeetAdapter: PlatformAdapter = {
  platform: 'google_meet',
  // the chat read from open-source Meet clients' readings of 2026 and the nightly checks of 24 to 27 October 2026 (the 27 October run's outline of the panel), not from the live client's markup itself
  selectorsVersion: '2026-10-27',
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
    // the composer, whichever shape the client drew and whichever frame it drew it in; the panel is opened when none shows
    const { input, frame, lookup } = (await composerShown(page)) ?? (await openChat(page));
    // a composer the client draws disabled, read-only or aria-disabled (the meeting's chat is off for this participant,
    // as the nightly check's Meet run of 27 October 2026 found) takes no text: the step is named at once, with the
    // panel's outline, rather than after a fill that waits out its time on it
    if (!(await takesText(input))) throw await failed(page, 'chat_input_blocked', `state:${lookup}`);
    // the message is read back as a new message among those the observer reads, in the composer's frame: one the panel
    // held before the send, the bot's own notice after a rejoin among them, never stands for the one being sent
    const echoes = frame.locator(SELECTORS.chatMessages).filter({ hasText: text.slice(0, 40) });
    const before = await echoes.count();
    await step(page, input.fill(text, { timeout: MEET_CHAT_TIMING.stepMs }), 'chat_input_blocked', `fill:${lookup}`); // a textarea or an editable alike
    await step(page, input.press('Enter', { timeout: MEET_CHAT_TIMING.stepMs }), 'chat_enter_blocked', `enter:${lookup}`); // both composers send on Enter
    if (await moreWithin(echoes, before, MEET_CHAT_TIMING.echoMs)) return;
    // nothing new read back and the text still in the composer: Enter did not send it, and its Send key, in the same frame, is pressed once
    let sendPressed = false;
    if ((await composerText(input)).includes(text.slice(0, 40))) {
      const send = await shown([frame.locator(SELECTORS.chatSendButton).first()]);
      if (send) {
        sendPressed = true;
        await send.click({ timeout: MEET_CHAT_TIMING.stepMs }).catch(() => undefined);
        if (await moreWithin(echoes, before, MEET_CHAT_TIMING.echoMs)) return;
      }
    }
    throw await failed(page, 'chat_echo_missing', `echo:messages${sendPressed ? ',send' : ''}`);
  },
  async observeChat(page, onMessage: (message: ChatMessage) => void): Promise<ChatObserver> {
    const seen = new Set<string>();
    let lastGood: number | undefined;
    let polling = false;
    const poll = async (): Promise<void> => {
      // the panel must be open to be read: a closed panel's messages can sit in the page with nobody reading new ones;
      // the messages are read from the frame the composer is in, which is where a Google Chat conversation draws them,
      // and the composer is read by every shape the notice may have been posted through, the panel's own among them
      const composer = await composerShown(page, COMPOSER_IN_PANEL);
      if (!composer) throw new Error('chat_panel_closed');
      for (const node of await composer.frame.locator(SELECTORS.chatMessages).all()) {
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
