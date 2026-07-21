/**
 * @fileoverview Attach-session state machine + operation deadlines.
 *
 * Encodes the legal lifecycle of an attach session so a wedged transport can
 * never be "recovered" by silently replaying an operation that may already
 * have taken effect in the user's browser (Codex spec review F14). Transitions
 * are explicit; illegal ones throw. `withDeadline` bounds every transport call
 * and maps expiry to a stable `NAV_TIMEOUT`-class failure instead of hanging.
 *
 * @module browser-automation/attach/state
 */
import { AttachError } from './errors.js';

/** Legal attach-session states. */
export type AttachState =
  | 'disconnected'
  | 'connecting'
  | 'ready'
  | 'navigating'
  | 'reading'
  | 'failed';

const LEGAL: Readonly<Record<AttachState, readonly AttachState[]>> = Object.freeze({
  disconnected: ['connecting'],
  connecting: ['ready', 'failed', 'disconnected'],
  ready: ['navigating', 'reading', 'disconnected', 'failed'],
  navigating: ['ready', 'failed'],
  reading: ['ready', 'failed'],
  failed: ['disconnected'],
});

/**
 * Minimal explicit state machine for one attach session.
 *
 * No auto-replay: once an operation moves the machine into `navigating` or
 * `reading`, a failure lands in `failed` and the ONLY way forward is an
 * explicit `disconnected` reset by the owner — never a silent retry.
 */
export class AttachStateMachine {
  private current: AttachState = 'disconnected';

  /** The current state. */
  get state(): AttachState {
    return this.current;
  }

  /**
   * Transition to `next`.
   * @throws {AttachError} `UNKNOWN`-coded error on an illegal transition.
   */
  to(next: AttachState): AttachState {
    if (!LEGAL[this.current].includes(next)) {
      throw new AttachError('UNKNOWN', `illegal attach-state transition ${this.current} → ${next}`);
    }
    this.current = next;
    return this.current;
  }

  /** True when an operation is in flight (no new ops may start). */
  get busy(): boolean {
    return this.current === 'connecting' || this.current === 'navigating' || this.current === 'reading';
  }
}

/**
 * Bound a transport promise with a hard deadline.
 *
 * @param p         The operation.
 * @param ms        Deadline in milliseconds.
 * @param label     Operation label for the failure message.
 * @throws {AttachError} `NAV_TIMEOUT` when the deadline expires first.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttachError('NAV_TIMEOUT', `${label} exceeded ${ms}ms deadline`)), ms);
  });
  try {
    return await Promise.race([p, gate]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
