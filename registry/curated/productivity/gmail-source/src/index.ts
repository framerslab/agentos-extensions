/**
 * @fileoverview A read-only Gmail source's grant: Google's read-only scope on the AgentOS redirect OAuth flow and
 * sealed-token store, with capped, cancellable OAuth calls and fixed failures; its text helpers: bounded
 * pre-storage sanitization of mail text, allow-listed headers and metadata, and conservative trimming of reply history
 * and signatures; its thread mapper: bounded MIME reading of one thread into a sanitized account-source document
 * with message provenance, attachment listings and an explicit cache decision; its read-only API client: capped
 * profile, label, list, history and thread calls through the host's grant and quota services, with fixed failures;
 * and its connector: the bounded selected-id account-source interface and the resumable sync provider, with private
 * mailbox verification, composed with the released durable coordinator and a one-time identity probe.
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
export {
  GmailApi, GmailApiFault, type GmailApiOptions, type GmailApiLimits,
  type GmailProfile, type GmailLabels, type GmailReadOptions, type GmailTokenHolder,
} from './gmail.js';
export { classifyGmailHttp, gmailOAuthFault, type GmailHttpDisposition } from './retry.js';
export {
  GmailSourceConnector, GmailConnectorFault,
  type GmailMailboxBinding, type GmailSourceConnectorOptions,
} from './GmailSourceConnector.js';
export {
  runGmailSourceSync, verifyGmailSource,
  type GmailSourceRunOptions, type GmailSourceVerification,
} from './sync.js';
