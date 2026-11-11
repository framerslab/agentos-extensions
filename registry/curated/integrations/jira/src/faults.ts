/**
 * @fileoverview The pack's own fixed faults, for what it refuses before a call or cannot read from Atlassian's token
 * address. A refused exchange, refresh or state is the core's `OAuthGrantRefused`; a REST call's failure is one of the
 * account sources' tracker faults. Neither message carries Atlassian's text, a token or a person's words.
 * @module agentos-ext-jira/faults
 */

/**
 * Why the pack stopped:
 * - `configuration`: a client, an option, an address, a site or an input the pack refuses before any call, and a
 *   revocation asked of Atlassian, which has no revocation endpoint;
 * - `invalid_response`: a token answer past the cap or without the fields the grant needs (a refresh token on an
 *   exchange, a lifetime);
 * - `no_answer`: a token call that ended without an answer (the deadline, the caller's cancellation, a failed
 *   connection).
 */
export type JiraFailure = 'configuration' | 'invalid_response' | 'no_answer';

/** A fixed failure of the pack; its message is `jira_<reason>`. */
export class JiraFault extends Error {
  /**
   * @param reason Why the pack stopped.
   * @param noAnswer For `no_answer`, how the call ended: its deadline passed, its caller cancelled it, or the connection
   * failed.
   */
  constructor(
    readonly reason: JiraFailure,
    readonly noAnswer?: 'timeout' | 'cancelled' | 'network',
  ) {
    super(`jira_${reason}`);
    this.name = 'JiraFault';
  }
}
