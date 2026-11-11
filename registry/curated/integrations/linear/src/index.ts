/**
 * @fileoverview Linear for a host that keeps its own grant: Linear's OAuth 2.0 with PKCE on the core's redirect flow
 * (`LinearOAuthFlow`), a GraphQL client over fetch (`LinearClient`, `linearGraphql`), and the account sources library's
 * issue tracker interface on that client (`LinearTracker`). A call the client or the tracker makes throws the account
 * sources library's tracker faults; a refused exchange, refresh or revocation is the core's `OAuthGrantRefused`; an
 * option, input or answer the pack refuses on its own is a `LinearFault`.
 * @module agentos-ext-linear
 */

export { LinearFault, type LinearFaultReason } from './faults.js';
export {
  LINEAR_ENDPOINTS, LINEAR_SCOPES, LinearOAuthFlow, type LinearEndpoints, type LinearOAuthClient, type LinearOAuthOptions,
  type LinearTokenHint,
} from './oauth.js';
export { LINEAR_ANSWER_BYTES, LINEAR_TIMEOUT_MS, linearGraphql, linearRetryAt, type LinearGraphqlOptions } from './graphql.js';
export {
  LINEAR_DONE_STATE_TYPES, LinearClient, type LinearClientOptions, type LinearIssue, type LinearIssueDraft,
  type LinearOrganization, type LinearTeam,
} from './client.js';
export { LinearTracker, type LinearRevoke } from './tracker.js';
