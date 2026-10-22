/** Chat text as the stop phrase is compared with it: each run of whitespace one space, trimmed and lowercased. */
function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** What may follow the phrase in a message that is the phrase: closing punctuation and whitespace, or nothing. */
const TAIL = /^[.!?\s]*$/;

/**
 * Whether a chat message is the run's stop phrase, by the rule AgentOS's meeting manager applies to `chat_message`
 * reports: both are compared with each run of whitespace folded to one space, trimmed and lowercased, and the message
 * may close with punctuation (`.`, `!`, `?`) after the phrase. A message that holds the phrase among other words is not
 * a stop: a bot's notice tells people to type the phrase, and with two bots in one meeting each reads the other's notice
 * in the chat. A phrase that folds to nothing matches no message.
 *
 * @param text - The message as the chat panel shows it.
 * @param stopPhrase - The run's stop phrase.
 */
export function isStopPhrase(text: string, stopPhrase: string): boolean {
  const phrase = fold(stopPhrase);
  if (!phrase) return false;
  const message = fold(text);
  return message.startsWith(phrase) && TAIL.test(message.slice(phrase.length));
}
