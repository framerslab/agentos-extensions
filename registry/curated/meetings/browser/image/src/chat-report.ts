import type { ChatMessage } from './adapters/types.js';
import { isStopPhrase } from './stop-phrase.js';

/** The protocol's ceilings on a chat report's fields: a longer field would make the scheduler drop the whole report. */
export const MAX_TEXT = 4000;
export const MAX_SENDER = 200;

/** What the bot reports of a chat message, and whether the message is a stop. */
export interface ChatReport {
  /** The message's text, cut to {@link MAX_TEXT}. */
  text: string;
  /** The sender's name, cut to {@link MAX_SENDER}. */
  sender: string;
  /** Whether the message is the run's stop phrase. */
  stop: boolean;
}

/**
 * The bot's report of a chat message.
 *
 * @param message - The message as the adapter read it.
 * @param stopPhrase - The run's stop phrase.
 */
export function chatReport(message: ChatMessage, stopPhrase: string): ChatReport {
  return { text: message.text.slice(0, MAX_TEXT), sender: message.sender.slice(0, MAX_SENDER), stop: isStopPhrase(message.text, stopPhrase) };
}
