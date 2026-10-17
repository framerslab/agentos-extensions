# @framers/agentos-ext-github

## 0.4.2

### Patch Changes

- [#278](https://github.com/framerslab/agentos-extensions/pull/278) [`64c47f1`](https://github.com/framerslab/agentos-extensions/commit/64c47f130c0a95f83a526a01d1bdb14686d12494) Thanks [@jddunn](https://github.com/jddunn)! - A body still being read when its call ends at the deadline or the caller's cancel is cancelled there, so nothing more of it is read through a fetch that leaves the body open past its signal: a JSON answer, a raw file, a refusal read to tell a rate limit and the code exchange's token answer, where the call answered `GitHubNoAnswer` and the read under it went on. A body the pack lets go (a refusal told by its status and headers, such as a 429 or a 5xx, and the answer to an uninstall or a redelivery) is released without waiting on its cancel, so a body whose cancel never settles no longer holds the call past its deadline.

## 0.4.1

### Patch Changes

- [#274](https://github.com/framerslab/agentos-extensions/pull/274) [`5141a30`](https://github.com/framerslab/agentos-extensions/commit/5141a30e5f8eb7d652a20630cf8bc784a84cca27) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubAppUserFlow.revoke` takes GitHub's 204 alone as a deleted token: a 200, a 202 or any other answer throws `OAuthGrantRefused` (reason `revoke`, its status), where any 2xx resolved before. The answer is told by its status alone and its body released unread, so a refusal with a body past 64 KiB throws `OAuthGrantRefused` rather than the size cap's error, and a refusal whose body stays open no longer holds the revocation. Every call of the pack (the REST calls, the code exchange and the revocation) now ends at its deadline or its caller's cancel with `GitHubNoAnswer` even when the injected `fetch` leaves the request or the answer's body open past the signal it was handed; an answer that comes after the deadline has its body released unread.

## 0.4.0

### Minor Changes

- [#269](https://github.com/framerslab/agentos-extensions/pull/269) [`260c22c`](https://github.com/framerslab/agentos-extensions/commit/260c22ce18cd10eb678d8e660dd3ea14f04f4c5f) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubDocumentsConnector` refuses, before any request, what it cannot answer whole. `changesSince` takes exactly one repository a call: it compared only the first id of a selection and answered a cursor that stood for that repository alone, so the other repositories' changes were never reported. It also refuses an empty `after`, and a `listing` passed without the `after` commit it was read at, whose files it labelled with the head it read in its place. `list` checks every selected id before it reads any repository, and refuses a repository named twice. A repository id must be a positive integer in decimal: `077`, `0x4d` and ` 77` named repository 77, and an empty id named 0. `read` refuses an item id without a path, or whose path has an empty, `.` or `..` segment, whose contents address named the repository's root listing or another endpoint. A call whose signal is already aborted throws `GitHubNoAnswer` (`cancelled`). Each refusal is a `TypeError`, except an `Error` for a repository outside the link and the cancel; none quotes a cursor, an item id or a path. A caller that passed several repositories to `changesSince` calls it once per repository, each with that repository's cursor. `read` takes an item whose version is `<blob>@` with no commit after it at the default branch, as it takes one with no version: it sent an empty `ref` and linked a `blob//` address before. This is a minor release because the refusals throw for calls 0.3.1 answered (several repositories to `changesSince`, a `listing` without its `after`, a repository id such as `077`): a host on a `^0.3` range takes them when it raises its range, never on a reinstall.

### Patch Changes

- [#273](https://github.com/framerslab/agentos-extensions/pull/273) [`233393c`](https://github.com/framerslab/agentos-extensions/commit/233393c4f17ac892a4aba309643b3154f1cc4e21) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubDocumentsConnector` checks a call's signal before its inputs: `list`, `read`, `changesSince`, `head` and `listing` throw `GitHubNoAnswer` (`cancelled`) for an already aborted signal whatever the inputs, where an input they refuse (an id that is not a repository id, a repository outside the link, a cursor they did not answer) threw that input's `TypeError` or `Error` first. Every aborted call now answers alike, before any request.

## 0.3.1

### Patch Changes

- [#262](https://github.com/framerslab/agentos-extensions/pull/262) [`36d3dac`](https://github.com/framerslab/agentos-extensions/commit/36d3dac8e09cfee79080e7c68cb03816f8db2af4) Thanks [@jddunn](https://github.com/jddunn)! - `manifest.json` lists the 26 tools by the names the pack registers them under (`github_search`, `github_issue_list` and the rest) instead of `githubSearch` and the like, so the extension registry's listing and AgentOS's capability discovery offer names a model can call. The pack reports its package's version instead of `0.1.0`.

- [#258](https://github.com/framerslab/agentos-extensions/pull/258) [`d647d74`](https://github.com/framerslab/agentos-extensions/commit/d647d74514a7c6add8452024f9d0c79850194d14) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubDocumentsConnector.read` throws `GitHubApiError` when GitHub refuses the installation token (404 for an installation it no longer has) instead of answering the file `removed`, so a lost installation never reads as every file gone; only the contents read's own 404 answers a file removed. `GitHubAppCredential.installationToken` takes `{ signal, timeoutMs }` as an optional third argument: the connector's calls pass their signal on to the token request, and `reconcileInstallations` its `timeoutMs`. A refused call whose body stops while it is read to tell a rate limit (at the deadline, the caller's cancel or a dropped connection) throws `GitHubNoAnswer` with its reason instead of a `GitHubApiError` told by its status alone. `changesSince` refuses a cursor it did not answer for a push to another branch too.

- [#263](https://github.com/framerslab/agentos-extensions/pull/263) [`660fe06`](https://github.com/framerslab/agentos-extensions/commit/660fe060232e813ffa48795c87541647cbedd538) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubAppUserFlow.revoke(token)` deletes a user access token at GitHub (`DELETE /applications/{client_id}/token`, authenticated as the app with its client id and secret), so a server done with a person's token can end it at once instead of leaving it valid until it expires. It threw before, since the flow names no revocation endpoint. GitHub answers 204; any other answer throws `OAuthGrantRefused` (reason `revoke`, its status), a redirect is refused unfollowed, and the call ends at the flow's deadline with `GitHubNoAnswer`. `GitHubAppUserFlowOptions` takes `apiBase`.

## 0.3.0

### Minor Changes

- [#248](https://github.com/framerslab/agentos-extensions/pull/248) [`aa1890c`](https://github.com/framerslab/agentos-extensions/commit/aa1890cf393b2b0edb3fa191e1a66abdc1236896) Thanks [@jddunn](https://github.com/jddunn)! - Read a GitHub App's webhook deliveries as typed events with `readWebhookDelivery` and `readWebhookRequest`: after the size cap, the `X-Hub-Signature-256` check and the `X-GitHub-Delivery` id, a delivery is answered as a `push` (with `toDefaultBranch`), an `installation` action, the repositories an installation gains or loses, an account renamed, a `ping`, or `other`, and a refused one throws `WebhookDeliveryRefused` with its reason. Every call of the `./documents` entry now runs under a deadline (`GITHUB_TIMEOUT_MS`, `timeoutMs` in the options) and the caller's signal, a call that gets no answer throws `GitHubNoAnswer`, a JSON answer is read under a 16 MiB cap, and `GitHubApiError` carries `rateLimited` and `retryAt` from GitHub's `retry-after` and `x-ratelimit-*` headers. `changesSince` refuses a cursor it did not answer without quoting it, and `GitHubAppUserFlow` refuses a redirect from the token address instead of following it, so the code and the client secret are sent to that address alone.
  
  Install `@framers/agentos-ext-account-sources` 0.7.0 or later beside the pack: it is a peer dependency in place of the `^0.1.0` dependency, so a host keeps one copy of it. The `@framers/agentos` peer floor rises to 0.13.144.

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
