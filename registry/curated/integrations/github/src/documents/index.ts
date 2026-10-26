/**
 * @fileoverview The `./documents` entry: a GitHub App's installation mode (its JWT and installation tokens, the user's
 * web flow, what a user token reaches, the webhook signature and its deliveries read as typed events, the daily
 * reconcile, the uninstall), `GitHubDocumentsConnector`, a repository's documentation as an account source at its
 * default branch or at a named branch or commit, and `parseGitHubLink`, the GitHub addresses a person pastes, read
 * without a request. Every call goes to GitHub's REST API over an injected `fetch`, under a deadline, its answer read
 * under a cap.
 * @module agentos-ext-github/documents
 */

/**
 * The documentation connector, the selections it lists and compares at a branch or a commit and within a folder, the
 * options of a folder's listing, and the ref a link's text names, settled as a branch, a tag or a commit.
 */
export {
  GitHubDocumentsConnector,
  type GitHubChangesSelection,
  type GitHubListingOptions,
  type GitHubListSelection,
  type LinkedRepository,
  type ResolvedRef,
} from './GitHubDocumentsConnector.js';
/**
 * A repository's tree within a request budget, the filter that keeps its documentation, and its code when asked, and
 * the plan of every file with what becomes of it.
 */
export {
  readTree,
  pathFilter,
  planTree,
  extensionOf,
  isGeneratedCode,
  TreeTooLarge,
  type TreeTooLargeReason,
  DOCUMENT_EXTENSIONS,
  CODE_EXTENSIONS,
  GENERATED_CODE_ENDINGS,
  IMAGE_EXTENSIONS,
  SKIPPED_FOLDERS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TREE_REQUESTS,
  type PlannedBlob,
  type PlanSkipReason,
  type PlanTreeOptions,
  type ReadTreeOptions,
  type TreeBlob,
  type TreeFilter,
} from './tree.js';
/** The GitHub addresses a person pastes, read without a request. */
export { parseGitHubLink, type GitHubLink } from './links.js';
/** The app's JWT and installation tokens. */
export { appJwt, GitHubAppCredential, type GitHubAppIdentity, type InstallationTokenOptions } from '../app/credential.js';
/** The user's web flow on the auth module's redirect flow. */
export {
  GitHubAppUserFlow,
  GITHUB_OAUTH_ENDPOINTS,
  type GitHubAppClient,
  type GitHubAppUserFlowOptions,
  type GitHubOAuthEndpoints,
} from '../app/userFlow.js';
/**
 * What a user token reaches, the app's own installations (each with when it was suspended), the repositories an
 * installation reaches, and those of them a caller holds that it no longer reaches.
 */
export {
  userOfToken,
  installationsOfUser,
  repositoriesOfUser,
  repositoriesOfInstallation,
  repositoriesLost,
  listInstallations,
  getInstallation,
  uninstallInstallation,
  GitHubListingChanged,
  type AppInstallation,
  type GitHubAccount,
  type GitHubInstallation,
  type GitHubUser,
  type InstallationRepository,
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
