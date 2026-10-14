import type { Page } from 'playwright';

/** Where a join left the bot. */
export interface JoinOutcome {
  /** `waiting_room` when the client shows its waiting screen or lobby, `in_call` when the call's grid is present. */
  state: 'waiting_room' | 'in_call';
}

/** One chat message as the panel shows it. */
export interface ChatMessage {
  /** The sender's name as the panel shows it, or `participant` when it cannot be read. */
  sender: string;
  /** The message's text. */
  text: string;
}

/** The chat observer: stopped at the end; `lastGoodPollAt` is when the panel was last read through, the fact a heartbeat rests on. */
export interface ChatObserver {
  /** Stops observing. */
  stop(): void;
  /** When the open panel was last read through, in epoch milliseconds, or `undefined` before the first such read. */
  lastGoodPollAt(): number | undefined;
}

/** What an adapter does to one platform's web client. Each carries `selectorsVersion`, the date its selectors were last read against the live client. */
export interface PlatformAdapter {
  /** The platform the adapter joins. */
  readonly platform: 'google_meet' | 'microsoft_teams';
  /** The date its selectors were last read against the live client. */
  readonly selectorsVersion: string;
  /** The hosts a join link and the client's own navigation may be on: a top-level document anywhere else (a redirect off the platform) is refused. */
  readonly joinHosts: readonly string[];
  /** The hosts the client's other requests may reach, exact or `*.suffix`: the first reading of the platform's client, extended from the nightly check's blocked-host log. */
  readonly allowedHosts: readonly string[];
  /** Whether plain http is allowed besides https: `true` for the test fixture alone, which a test stack serves over http; every platform's adapter is https only. */
  readonly allowHttp?: boolean;
  /**
   * Opens the link, sets the name, turns the camera off, presses Join or Ask to join. With `signedIn` (the run joins as
   * a signed-in identity), a sign-in challenge on the pre-join screen ends the join with the error `needs_reauth`
   * before any knock, so a signed-out identity never asks to join as a guest.
   */
  join(page: Page, input: { meetingUrl: string; botName: string; signedIn?: boolean }): Promise<JoinOutcome>;
  /** Resolves when the call's grid is present (admitted), or throws `not_admitted` after `timeoutMs`. */
  waitForCall(page: Page, timeoutMs: number): Promise<void>;
  /** Posts the text in the chat and resolves when the adapter has read its own message back from the panel. */
  postChat(page: Page, text: string): Promise<void>;
  /**
   * Reads the chat panel once now (throws when it cannot), then keeps observing it; `onMessage` is called for each new
   * message the client does not mark as the bot's own. A client that marks none passes the bot's messages on too, and
   * the bot skips the texts it posted itself.
   */
  observeChat(page: Page, onMessage: (message: ChatMessage) => void): Promise<ChatObserver>;
  /** The number of participants besides the bot, as the client shows it, or `undefined` when the client shows no count it can read: an unread count is unknown, never zero. */
  participantCount(page: Page): Promise<number | undefined>;
  /** Presses Leave. */
  leave(page: Page): Promise<void>;
  /** Whether the client shows a sign-in challenge (Meet: the identity needs reauthentication). */
  needsReauth(page: Page): Promise<boolean>;
}
