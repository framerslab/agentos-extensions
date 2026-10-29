/**
 * Explicit scheduler-owned container logging policy, with inherited defaults when absent.
 *
 * @module
 */

/** This release supports only the journal opt-in; unset is represented by undefined. */
export type MeetingLogDriver = 'journald';

/**
 * Read configuration without echoing it into a failure. Unknown explicit values fail closed; no daemon setting is changed.
 * @param value - An environment value or a runtime policy input.
 * @returns The explicit journal selection, or undefined for an absent or blank value.
 */
export function readMeetingLogDriver(value: unknown): MeetingLogDriver | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const word = value.trim();
    if (word === '') return undefined;
    if (word === 'journald') return 'journald';
  }
  throw new Error('invalid_MEETING_LOG_DRIVER');
}
