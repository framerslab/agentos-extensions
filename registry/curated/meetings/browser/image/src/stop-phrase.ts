/**
 * Whether a chat message asks the bot to stop: it holds the run's stop phrase, case ignored.
 *
 * @param text - The message as the chat panel shows it.
 * @param stopPhrase - The run's stop phrase.
 */
export function isStopPhrase(text: string, stopPhrase: string): boolean {
  return text.toLowerCase().includes(stopPhrase.toLowerCase());
}
