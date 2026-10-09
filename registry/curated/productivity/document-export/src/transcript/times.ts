/**
 * @fileoverview Times as each format writes them.
 * @module document-export/transcript/times
 */

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
