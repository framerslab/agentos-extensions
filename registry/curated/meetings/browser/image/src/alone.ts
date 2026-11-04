/** What one heartbeat tick read of who else is in the call. */
export interface AloneReading {
  /** The others by the client's count, or `undefined` when the count went unread. */
  count: number | undefined;
  /** The others by the call's tiles, read only while the count is unread, or `undefined` when they cannot tell. */
  tiles: number | undefined;
}

/**
 * The alone limit's clock after one tick: the time since which the bot has been read alone, or `undefined` when this
 * tick did not read it alone. The count rules when it was read; the tiles only while it was not. A tick that cannot tell
 * stops the clock as one that reads someone else does, so the limit is time read alone without a break: someone whose
 * tile the page hides is never counted as gone for as long as they stay.
 */
export function aloneSinceAfter(since: number | undefined, reading: AloneReading, now: number): number | undefined {
  const others = reading.count ?? reading.tiles;
  if (others === 0) return since ?? now;
  return undefined;
}
