/** A fake clock the package reads through `OpsOptions.now`: the tests move it, nothing else does. */
export interface FakeClock {
  now(): number;
  advance(ms: number): void;
  set(ms: number): void;
}

/** A clock standing at `start` (noon UTC on 22 October 2026 by default) until a test moves it. */
export function fakeClock(start: number = Date.UTC(2026, 9, 22, 12, 0, 0)): FakeClock {
  let at = start;
  return {
    now: () => at,
    advance(ms) {
      at += ms;
    },
    set(ms) {
      at = ms;
    },
  };
}
