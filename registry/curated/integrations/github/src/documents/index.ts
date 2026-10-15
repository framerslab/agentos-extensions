/**
 * @fileoverview The `./documents` entry: a GitHub App's installation mode (its JWT and installation tokens, the user's
 * web flow, what a user token reaches, the webhook signature and its deliveries read as typed events, the daily
 * reconcile, the uninstall) and `GitHubDocumentsConnector`, a repository's documentation as an account source. Every
 * call goes to GitHub's REST API over an injected `fetch`, under a deadline, its answer read under a cap.
 * @module agentos-ext-github/documents
 */

/** The documentation connector and the shape of a push it compares. */
export { GitHubDocumentsConnector, type GitHubChangesSelection, type LinkedRepository } from './GitHubDocumentsConnector.js';
/** A repository's tree within a request budget, and the filter that keeps its documentation. */
export {
  readTree,
  pathFilter,
  extensionOf,
  TreeTooLarge,
  DOCUMENT_EXTENSIONS,
  SKIPPED_FOLDERS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TREE_REQUESTS,
  type ReadTreeOptions,
  type TreeBlob,
  type TreeFilter,
} from './tree.js';
/** The app's JWT and installation tokens. */
export { appJwt, GitHubAppCredential, type GitHubAppIdentity } from '../app/credential.js';
/** The user's web flow on the auth module's redirect flow. */
export {
  GitHubAppUserFlow,
  GITHUB_OAUTH_ENDPOINTS,
  type GitHubAppClient,
  type GitHubAppUserFlowOptions,
  type GitHubOAuthEndpoints,
} from '../app/userFlow.js';
/** What a user token reaches, and the app's own installations. */
export {
  userOfToken,
  installationsOfUser,
  repositoriesOfUser,
  listInstallations,
  uninstallInstallation,
  type GitHubAccount,
  type GitHubInstallation,
  type GitHubUser,
  type UserRepository,
} from '../app/installations.js';
/** A webhook delivery's signature. */
export { verifyWebhookSignature } from '../app/webhook.js';
/** A webhook delivery read as a typed event once its signature holds. */
export {
  readWebhookDelivery,
  readWebhookRequest,
  WebhookDeliveryRefused,
  DEFAULT_MAX_DELIVERY_BYTES,
  type GitHubDelivery,
  type GitHubEvent,
  type GitHubEventRepository,
  type GitHubInstallationEvent,
  type GitHubInstallationRepositoriesEvent,
  type GitHubInstallationTargetEvent,
  type GitHubOtherEvent,
  type GitHubPingEvent,
  type GitHubPushEvent,
  type ReadWebhookOptions,
  type WebhookDeliveryInput,
  type WebhookRefusalReason,
  type WebhookRequestInput,
} from '../app/events.js';
/** The daily reconcile. */
export {
  reconcileInstallations,
  type DeliveriesOutcome,
  type MovedRepository,
  type ReconcileLink,
  type ReconcileOptions,
  type ReconcileOutcome,
  type ReconcileRepository,
  type RefusedRedelivery,
  type UnreadableRepository,
} from '../app/reconcile.js';
/**
 * The API version every call pins, GitHub's address, a call's deadline and an answer's cap, the error of an answer
 * outside 2xx with its rate limit timing, and the error of a call that got no answer.
 */
export {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GITHUB_MAX_ANSWER_BYTES,
  GITHUB_TIMEOUT_MS,
  GitHubApiError,
  GitHubNoAnswer,
  type GitHubApiOptions,
  type GitHubNoAnswerReason,
  type GitHubRefusalTiming,
} from '../app/http.js';
