/**
 * A message's text read from its whole element, for a client that draws no element for the message's body.
 *
 * @param elementText - The message element's text as the page shows it.
 * @param _sender - The sender's name as the adapter read it.
 */
export function bodyOfElementText(elementText: string, _sender: string): string {
  return elementText;
}
