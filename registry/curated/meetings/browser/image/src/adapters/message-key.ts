import type { Locator } from 'playwright';

/**
 * The key a chat message is remembered by between reads of the panel. A message whose element carries the client's own
 * id in `idAttribute` is keyed by that id, which a panel drawn again keeps. Any other message is keyed by its element
 * and its text: the page numbers each message element the first time it is read, so the same text sent twice is two
 * messages, and an element the client reuses for another message is read again.
 *
 * @param node - One message element of the chat panel.
 * @param idAttribute - The attribute that holds the client's id for a message.
 * @param timeoutMs - How long each read of the element waits for it.
 */
export async function messageKey(node: Locator, idAttribute: string, timeoutMs: number): Promise<string> {
  const { id, element } = await node.evaluate(
    (el: { getAttribute(name: string): string | null }, attribute: string) => {
      // the numbers live in the page, beside the elements: each read hands the bot a new locator, never the element itself
      const page = globalThis as unknown as { meetingBotChatElements?: { numbers: WeakMap<object, number>; next: number } };
      const store = (page.meetingBotChatElements ??= { numbers: new WeakMap<object, number>(), next: 0 });
      let numbered = store.numbers.get(el);
      if (numbered === undefined) {
        numbered = store.next += 1;
        store.numbers.set(el, numbered);
      }
      return { id: el.getAttribute(attribute), element: numbered };
    },
    idAttribute,
    { timeout: timeoutMs },
  );
  return id ?? `${element}:${(await node.innerText({ timeout: timeoutMs })).slice(0, 80)}`;
}
