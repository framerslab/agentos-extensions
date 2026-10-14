# @framers/agentos-ext-github

## 0.2.2

### Patch Changes

- [#208](https://github.com/framerslab/agentos-extensions/pull/208) [`355fe06`](https://github.com/framerslab/agentos-extensions/commit/355fe068a5e68c0f4f4f3f29d849123924414da2) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubAppCredential.installationToken` refuses an empty repository list and `verifyWebhookSignature` an empty secret with a `TypeError`, `reconcileInstallations` keeps the lists it computed when GitHub refuses its deliveries listing or a redelivery, reporting the refusal in its new `deliveries` field, and leaves failed a delivery its route refused with a 4xx other than 408 or 429, and the package's entry exports `ECOSYSTEM_REPOS`, `IndexedRepository` and `GitHubRepoIndexerOptions`.

## 0.2.1

### Patch Changes

- Updated dependencies [[`03d31a2`](https://github.com/framerslab/agentos-extensions/commit/03d31a251d0d0ca3c90489a12a6901c1c38b07fc)]:
  - @framers/agentos-ext-account-sources@0.2.0

## 0.2.0

### Minor Changes

- [#202](https://github.com/framerslab/agentos-extensions/pull/202) [`1d9766a`](https://github.com/framerslab/agentos-extensions/commit/1d9766a72b176a105b2635310dd601f141f67f16) Thanks [@jddunn](https://github.com/jddunn)! - Add a `./documents` entry with a GitHub App's installation mode and a typed documents connector: the app's JWT and installation tokens narrowed to the repositories asked for, the user's web flow on the auth module's `RedirectOAuthFlow`, the installations and repositories a user token reaches, the webhook signature check, a daily reconcile of installations, heads and failed deliveries, the uninstall, and `GitHubDocumentsConnector`, an account source connector that reads a repository's documentation by tree within a request budget, reads each file raw under a cap, and compares a push by the tree at its `after` commit. `GitHubRepoIndexer` indexes the repositories its caller gives. The peer floor on `@framers/agentos` rises to 0.13.40.

## 0.1.5

### Patch Changes

- [#166](https://github.com/framerslab/agentos-extensions/pull/166) [`a9ed390`](https://github.com/framerslab/agentos-extensions/commit/a9ed390e1035b8a7efcc14aa2465b76953f0962e) Thanks [@dependabot](https://github.com/apps/dependabot)! - The GitHub pack runs on `@octokit/rest` 22. Version 22.0.0 drops Node.js 18 and removes the deprecated Projects and Copilot usage metrics endpoints (https://github.com/octokit/rest.js/releases/tag/v22.0.0); the pack calls none of them, and every endpoint it calls, `search.issuesAndPullRequests` included, is in the endpoint methods that 22 bundles.

## 0.1.4

### Patch Changes

- [#153](https://github.com/framerslab/agentos-extensions/pull/153) [`ca5be51`](https://github.com/framerslab/agentos-extensions/commit/ca5be5157e296d730363027d40605f428fd04935) Thanks [@jddunn](https://github.com/jddunn)! - Adds a README: installation, configuration, the tools the pack registers and what they do.

## 0.1.3

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.2

### Patch Changes

- [#77](https://github.com/framerslab/agentos-extensions/pull/77) [`91fd410`](https://github.com/framerslab/agentos-extensions/commit/91fd4108cca945cdb37cb541b1d88e68454f76a1) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.1

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.
