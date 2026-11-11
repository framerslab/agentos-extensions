/**
 * @fileoverview What the pack refuses on its own: an option, an input or an address it will not take, and a token
 * answer from Linear without the fields the flow needs. A call the tracker or the client makes throws the account
 * sources library's tracker faults instead (`TrackerFault` and the faults that extend it). A `LinearFault` carries its
 * reason alone, never Linear's text, a token or a person's words.
 * @module agentos-ext-linear/faults
 */

/**
 * Why the pack refused:
 * - `configuration`: an option, an input or an address refused before any call;
 * - `invalid_response`: a token answer past the pack's cap, or one without a refresh token, which every grant Linear
 *   issues carries.
 */
export type LinearFaultReason = 'configuration' | 'invalid_response';

/** A refusal of the pack's own; its message is the reason alone. */
export class LinearFault extends Error {
  /** @param reason Why the pack refused. */
  constructor(readonly reason: LinearFaultReason) {
    super(reason);
    this.name = 'LinearFault';
  }
}
