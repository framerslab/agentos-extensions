/**
 * @fileoverview `OpsLimits` with the default each decision names (D12, D13, D14, D18, D21, D27,
 * D30, whose rate cut keeps one line shape 60 times a minute; the mail numbers by the plan's P4),
 * and the check of a host's partial override.
 */
import type { OpsLimits } from './contract.js';

/** The most bytes the attachments table takes for one stored picture: both schemas' `CHECK (length(bytes) <= 1048576)` (D18). */
export const PICTURE_STORED_BYTES_MAX = 1_048_576;

/** The limits the package keeps when the host overrides none. */
export const DEFAULT_LIMITS: Readonly<OpsLimits> = Object.freeze({
  ticketsPerDay: 5,
  ticketCooldownMs: 30_000,
  messagesPerHour: 30,
  subjectMax: 200,
  bodyMax: 5_000,
  picturesPerMessage: 3,
  picturesPerTicket: 10,
  streamsPerAccount: 3,
  streamsPerProcess: 50,
  streamLifeMs: 15 * 60_000,
  pictureBytesMax: 5 * 1024 * 1024,
  pictureInputPixelsMax: 50_000_000,
  pictureLongSideMax: 2_000,
  pictureOutputBytesMax: 1_048_576,
  pictureWaitMs: 10_000,
  captureQueue: 2_000,
  lineQueue: 5_000,
  eventQueue: 5_000,
  beatQueue: 500,
  occurrenceEveryMs: 10_000,
  browserGroupsPerDay: 500,
  lineShapePerMinute: 60,
  mailUnreadMs: 5 * 60_000,
  mailGapMs: 30 * 60_000,
  exportsPerDay: 3,
});

const LIMIT_KEYS = new Set<keyof OpsLimits>(Object.keys(DEFAULT_LIMITS) as Array<keyof OpsLimits>);

/**
 * The defaults with the host's overrides laid over them. A key the contract does not name, or a
 * value that is not a safe integer of 0 or more, throws a `TypeError` naming the key; so does a
 * `pictureOutputBytesMax` above the bytes the attachments table takes for one picture, since an
 * upload inside such a bound would fail at the table's check instead of being refused.
 */
export function resolveLimits(overrides?: Partial<OpsLimits>): OpsLimits {
  const limits: OpsLimits = { ...DEFAULT_LIMITS };
  if (overrides === undefined) return limits;
  if (typeof overrides !== 'object' || overrides === null || Array.isArray(overrides)) {
    throw new TypeError('createOperations: limits must be an object of the OpsLimits keys');
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!LIMIT_KEYS.has(key as keyof OpsLimits)) {
      throw new TypeError(`createOperations: limits.${key} is not a limit the package knows`);
    }
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`createOperations: limits.${key} must be a safe integer of 0 or more`);
    }
    limits[key as keyof OpsLimits] = value;
  }
  if (limits.pictureOutputBytesMax > PICTURE_STORED_BYTES_MAX) {
    throw new TypeError(`createOperations: limits.pictureOutputBytesMax must be at most ${PICTURE_STORED_BYTES_MAX}, the bytes the attachments table takes for one picture`);
  }
  return limits;
}
