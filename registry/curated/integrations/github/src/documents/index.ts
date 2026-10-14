/**
 * @fileoverview The `./documents` entry: a GitHub App's installation mode (its JWT and installation tokens, the user's
 * web flow, what a user token reaches, the webhook signature, the daily reconcile, the uninstall) and
 * `GitHubDocumentsConnector`, a repository's documentation as an account source. Every call goes to GitHub's REST API
 * over an injected `fetch`.
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
export { GitHubAppUserFlow, GITHUB_OAUTH_ENDPOINTS, type GitHubAppClient, type GitHubOAuthEndpoints } from '../app/userFlow.js';
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
/** The daily reconcile. */
export {
  reconcileInstallations,
  type MovedRepository,
  type ReconcileLink,
  type ReconcileOptions,
  type ReconcileOutcome,
  type ReconcileRepository,
  type UnreadableRepository,
} from '../app/reconcile.js';
/** The API version every call pins, GitHub's address, and the error of an answer outside 2xx. */
export { GITHUB_API_BASE, GITHUB_API_VERSION, GitHubApiError, type GitHubApiOptions } from '../app/http.js';
