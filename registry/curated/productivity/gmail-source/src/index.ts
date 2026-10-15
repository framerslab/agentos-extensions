/**
 * @fileoverview A read-only Gmail source's grant: Google's read-only scope on the AgentOS redirect OAuth flow and
 * sealed-token store, with capped, cancellable OAuth calls and fixed failures; its text helpers: bounded
 * pre-storage sanitization of mail text, allow-listed headers and metadata, and conservative trimming of reply history
 * and signatures; and its thread mapper: bounded MIME reading of one thread into a sanitized account-source document
 * with message provenance, attachment listings and an explicit cache decision.
 * @module agentos-ext-gmail-source
 */

export { GmailOAuthFlow } from './GmailOAuthFlow.js';
export {
  GMAIL_READONLY_SCOPE, GmailOAuthFault, type GmailOAuthFailure, type GmailGrantCleanup,
  type GmailOAuthClient, type GmailOAuthEndpoints, type GmailOAuthOptions,
} from './types.js';
export {
  GmailTextFault, sanitizeMailText, sanitizeMailMetadata, sanitizeMailHeaders,
  type GmailTextPolicy, type GmailSanitizedText, type GmailHeaderInput,
  type GmailSanitizedHeaders, type GmailTextFailure,
} from './mailSanitize.js';
export { messageText, type GmailMessageText } from './messageText.js';
export { GmailThreadMapper, type GmailMapThreadOptions } from './mapThread.js';
export { GmailMappingFault, type GmailMappingBounds } from './mime.js';
