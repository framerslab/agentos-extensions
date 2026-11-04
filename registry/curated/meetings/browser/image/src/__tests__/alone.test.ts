import { describe, expect, it } from 'vitest';
import { aloneSinceAfter } from '../alone.js';

describe('the alone limit clock', () => {
  it('starts on the first tick that reads the bot alone and keeps that start while it stays alone', () => {
    expect(aloneSinceAfter(undefined, { count: 0, tiles: undefined }, 1_000)).toBe(1_000);
    expect(aloneSinceAfter(1_000, { count: 0, tiles: undefined }, 11_000)).toBe(1_000);
    expect(aloneSinceAfter(undefined, { count: undefined, tiles: 0 }, 1_000)).toBe(1_000);
    expect(aloneSinceAfter(1_000, { count: undefined, tiles: 0 }, 11_000)).toBe(1_000);
  });

  it('stops when a tick reads anyone else, by the count or by the tiles', () => {
    expect(aloneSinceAfter(1_000, { count: 1, tiles: undefined }, 11_000)).toBeUndefined();
    expect(aloneSinceAfter(1_000, { count: undefined, tiles: 2 }, 11_000)).toBeUndefined();
  });

  it('reads the count before the tiles', () => {
    expect(aloneSinceAfter(undefined, { count: 1, tiles: 0 }, 1_000)).toBeUndefined();
    expect(aloneSinceAfter(undefined, { count: 0, tiles: 1 }, 1_000)).toBe(1_000);
  });

  it('stops on a tick that cannot tell, so the limit is time read alone without a break', () => {
    // someone joins with a tile the page hides: the tiles cannot tell for as long as they stay
    let since = aloneSinceAfter(undefined, { count: undefined, tiles: 0 }, 0);
    since = aloneSinceAfter(since, { count: undefined, tiles: undefined }, 10_000);
    expect(since).toBeUndefined();
    since = aloneSinceAfter(since, { count: undefined, tiles: undefined }, 300_000);
    // once they leave, the clock starts again from the first tick that reads the bot alone
    expect(aloneSinceAfter(since, { count: undefined, tiles: 0 }, 310_000)).toBe(310_000);
  });
});
