/** The clock a count read at join waits on; the tests give a fake one. */
export interface JoinCountClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: JoinCountClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The participant count when the bot is let into the call. A client can draw its count a few seconds after the call's
 * grid, or under a dialog it lays over the call, so a count that does not show is read again every `everyMs` until one
 * shows or `withinMs` has passed. A read that fails is no count. Gives `undefined`, the count unknown and never zero,
 * when none showed in that time; the heartbeat's reads take over from there.
 */
export async function countAtJoin(
  read: () => Promise<number | undefined>,
  { withinMs, everyMs, now = realClock.now, sleep = realClock.sleep }: { withinMs: number; everyMs: number } & Partial<JoinCountClock>,
): Promise<number | undefined> {
  const deadline = now() + withinMs;
  for (;;) {
    const count = await read().catch(() => undefined);
    if (count !== undefined) return count;
    if (now() + everyMs >= deadline) return undefined;
    await sleep(everyMs);
  }
}
