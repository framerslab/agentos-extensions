/**
 * @fileoverview A read-only Gmail source's grant: Google's read-only scope on the AgentOS redirect OAuth flow and
 * sealed-token store, with capped, cancellable OAuth calls and fixed failures.
 * @module agentos-ext-gmail-source
 */

export { GmailOAuthFlow } from './GmailOAuthFlow.js';
export {
  GMAIL_READONLY_SCOPE, GmailOAuthFault, type GmailOAuthFailure, type GmailGrantCleanup,
  type GmailOAuthClient, type GmailOAuthEndpoints, type GmailOAuthOptions,
} from './types.js';
