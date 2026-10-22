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
 * The bot's report of a chat message: its text and sender cut to the protocol's ceilings, and whether it is a stop,
 * decided on the text as reported, which is the text the meeting manager reads. A message read from its body element is
 * a stop when it is the phrase. One read from its whole element (the client drew no body element) holds the sender's
 * name and the time on lines of their own, and is also a stop when one of its lines is the phrase: another bot's notice
 * is one line that holds the phrase among other words, and stays no stop.
 *
 * @param message - The message as the adapter read it.
 * @param stopPhrase - The run's stop phrase.
 */
export function chatReport(message: ChatMessage, stopPhrase: string): ChatReport {
  const text = message.text.slice(0, MAX_TEXT);
  const stop = isStopPhrase(text, stopPhrase) || (!message.bodyRead && text.split(/\r?\n/).some((line) => isStopPhrase(line, stopPhrase)));
  return { text, sender: message.sender.slice(0, MAX_SENDER), stop };
}
