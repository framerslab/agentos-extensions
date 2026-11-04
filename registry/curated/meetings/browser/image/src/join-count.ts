const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The promise's value, or `undefined` once `ms` has passed without one; the timer is cleared either way. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeUp = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  return Promise.race([promise, timeUp]).finally(() => clearTimeout(timer));
}

/**
 * The participant count when the bot is let into the call. A client can draw its count a few seconds after the call's
 * grid, or under a dialog it lays over the call, so a count that does not show is read again every `everyMs` until one
 * shows or `withinMs` has passed by the clock, a read still under way then included. A read that fails is no count.
 * `stopped` ends the wait at once, before a read and after a pause: the bot is leaving. Gives `undefined`, the count
 * unknown and never zero, when none showed; the heartbeat's reads take over from there.
 */
export async function countAtJoin(
  read: () => Promise<number | undefined>,
  { withinMs, everyMs, stopped = () => false }: { withinMs: number; everyMs: number; stopped?: () => boolean },
): Promise<number | undefined> {
  const deadline = Date.now() + withinMs;
  while (!stopped()) {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    const count = await within(read().catch(() => undefined), left);
    if (count !== undefined || stopped()) return stopped() ? undefined : count;
    if (Date.now() + everyMs >= deadline) return undefined;
    await pause(everyMs);
  }
  return undefined;
}
