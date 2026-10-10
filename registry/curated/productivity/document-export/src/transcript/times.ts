/**
 * @fileoverview Times as each format writes them, and each turn's start looked up by its `seq`.
 * @module document-export/transcript/times
 */

import type { ExportTurn } from './types.js';

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `mm:ss`, or `h:mm:ss` from an hour, for reading. */
export function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** `HH:MM:SS<separator>mmm`, as SRT (`,`) and VTT (`.`) write a cue's time. */
export function cueTime(ms: number, separator: ',' | '.'): string {
  const whole = Math.max(0, Math.round(ms));
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor((whole % 3_600_000) / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}${separator}${pad(whole % 1000, 3)}`;
}

/**
 * Each turn's start by its `seq`, read from the turns once, so a writer finds the time of the turn a quote names
 * without searching the turns for every quote. When two turns share a `seq`, the first one's start is kept, as a
 * search from the first turn would find it.
 */
export function startsBySeq(turns: readonly ExportTurn[]): Map<number, number | null> {
  const starts = new Map<number, number | null>();
  for (const turn of turns) {
    const seq = turn.seq;
    if (!starts.has(seq)) starts.set(seq, turn.startMs);
  }
  return starts;
}
