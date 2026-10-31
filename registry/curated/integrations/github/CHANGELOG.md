# @framers/agentos-ext-github

Releases after 0.10.0 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-github@<version>`.

## 0.10.0

### Minor Changes

- [#419](https://github.com/framerslab/agentos-extensions/pull/419) [`8388a1d`](https://github.com/framerslab/agentos-extensions/commit/8388a1d7a4b966c738519968d6b8b2e9b3417899) Thanks [@jddunn](https://github.com/jddunn)! - `parseGitHubLink` reads a tag by its full name, `refs/tags/<tag>`, under `/tree/`, `/blob/` and `/raw/` on github.com and on raw.githubusercontent.com: github.com's own Raw link for a file at a tag takes that form (`https://github.com/cli/cli/raw/refs/tags/v2.0.0/README.md`, which redirects to `raw.githubusercontent.com/cli/cli/refs/tags/v2.0.0/README.md`), and each answered `refused`. A branch's and a tag's full names now stay whole in `refAndPath` (`refs/heads/main/docs` where it answered `main/docs`), and `resolveRef` reads such a name among the branches or the tags alone, the namespace being the one form that tells a tag from a branch of the same name: with the branch `release` and the tag `release/2.0`, `.../raw/refs/heads/release/2.0/README.md` settled as the tag with the path `README.md`, and now settles as the branch with the path `2.0/README.md`. A tag named that way that the repository does not have, or one that names no commit, throws `GitHubApiError` with status 404, as GitHub answers the address. A branch named that way whose name is 40 hexadecimal characters, which `at` reads as the commit it spells, is settled at its head (`commit: true`), and so is a default branch so named that `HEAD` names. A full name with nothing after it under `/blob/` or `/raw/` is refused, as GitHub answers it 404.
  
  `list`, `listing` and `changesSince` with a `path`, and `readTree` with its new `path` option, read the tree for that folder or file alone: when GitHub truncates the recursive tree, the folders on the path are asked for one at a time and the folder is read as a whole tree is. The whole tree was read and narrowed afterwards, so in a repository with 49 or more top-level folders a folder's listing threw `TreeTooLarge` (`budget`) under the default budget of 50, though three requests reach it. A path through a skipped folder lists nothing before any request, so a cut level that leaves the folder out no longer refuses it.
  
  The pack's build leaves its tests out: 0.9.0 published `dist/__tests__`, 52 files and 537,882 of its 1,137,029 unpacked bytes.

## 0.9.0

### Minor Changes

- [#407](https://github.com/framerslab/agentos-extensions/pull/407) [`25b2b95`](https://github.com/framerslab/agentos-extensions/commit/25b2b95944adb085121a3be1939b34b4ee6696d8) Thanks [@jddunn](https://github.com/jddunn)! - `parseGitHubLink` reads a pasted address as the URL standard reads one, as a browser opens it: the C0 controls and spaces around it are dropped, and every tab and newline in it, and after `http`, `https`, `ws`, `wss` and `ftp` any run of `/` and `\` stands before the host, none included. `https:github.com/acme-team/handbook`, `https:/github.com/acme-team/handbook`, `http:github.com/acme-team/handbook`, `https:\\github.com\acme-team\handbook` and an address with a control character before it answered `null`, so a caller that reads `null` as another site's address read these GitHub addresses as web pages. An address on `ghe.com` or a host under it, where GitHub Enterprise Cloud with data residency serves an enterprise, is `refused`, where it answered `null`. After `file` and its two slashes a third slash or backslash leaves the host empty, so `file:///github.com/acme-team/handbook` names no host and answers `null`.
  
  `resolveRef` settles a tag and a short commit, as github.com serves `/tree/<tag>/` and `/tree/<short commit>/`. The branches and the tags are read (`matching-refs/heads` and `matching-refs/tags`) and the longest name of either that is the text or starts it at a slash is the ref, a branch and a tag of one name settling as the branch, so the tag `release/2.0` beside the branch `release` settles `release/2.0/docs`; the tags are not read when a branch's name is the whole text. A tag is answered at the commit it names, an annotated tag's object read for it; then a first segment of 4 to 39 hexadecimal characters is read through GitHub's commits under the `application/vnd.github.sha` media type. Both were answered as a branch, and a listing at it threw GitHub's 404. `ResolvedRef` gains `kind` (`branch`, `tag` or `commit`) and `name` (the ref as the link writes it); a tag and a short commit answer `commit: true` with `ref` the whole commit, which `list`, `head` and `changesSince` read as `at`. A first segment no ref name can begin (`a:b`, `a~1`, a control character) is a `TypeError` before any request, where it cost a request and a listing at it threw a `TypeError`, and one that is no branch name and that no branch, tag or commit settles (`-x`, `@`, `end.`) is a `TypeError` after the reads. An address naming a tag by its full name, `refs/tags/<tag>`, stays refused.
  
  `list`, `changesSince`, `listing(repositoryId, commit, { path, signal })` and `planTree` take a `path`: the files of a folder, or the one file a path names, are kept before `maxFiles` counts them. A folder was read by listing the whole repository and keeping the files under it, so in a repository with 2,000 documents sorting before `docs/` a link to `docs` listed nothing, `planTree` answered the folder's files `count`, and `changesSince` answered them gone. A `/tree/` address that names a file lists that file. A `listing` handed to `changesSince` with a `path` that holds `maxFiles` files may have been cut before the folder's files, so the folder is read afresh instead of it. A `path` with an empty, `.` or `..` segment, or one beside other than one repository in `list`, is a `TypeError` before any request.

## 0.8.0

### Minor Changes

- [#395](https://github.com/framerslab/agentos-extensions/pull/395) [`e2a1792`](https://github.com/framerslab/agentos-extensions/commit/e2a17928bb8be2adf8b68fee61361955ccc3314c) Thanks [@jddunn](https://github.com/jddunn)! - The `./documents` entry reads the GitHub addresses a person pastes and follows a named branch or commit. `parseGitHubLink(text)` answers the repository, folder or file a github.com or raw.githubusercontent.com address names, under any scheme or none, with a port, `.git`, a trailing slash, a query or a fragment, and answers `refused` for any other address on GitHub's hosts (an issue, a pull request, a wiki, a release, a gist, the API, a tag, an address carrying credentials with a scheme or without one), never `null`, so a GitHub address is never read as another site's page. `GitHubDocumentsConnector.resolveRef(repositoryId, refAndPath)` settles where a link's branch name ends: a commit and `HEAD` with no request, otherwise one request to GitHub's matching references, the longest branch that is the text or starts it at a slash. `list`, `changesSince` and `head` take `at`, a branch name or a commit, checked by git's rules before any request: a push is compared when its `ref` is `refs/heads/<at>`, and a commit never changes. `head(repositoryId, signal)` keeps its form. `planTree(blobs, options)` answers every file of a tree with its outcome under `pathFilter`'s filter, `note` or skipped with `folder`, `kind`, `image`, `code`, `generated`, `size` or `count`, with `maxCodeBytes`, which bounds a file of a code extension while code is asked for whatever `extensions` names, and `IMAGE_EXTENSIONS`.

## 0.7.0

### Minor Changes

- [#382](https://github.com/framerslab/agentos-extensions/pull/382) [`fe301ea`](https://github.com/framerslab/agentos-extensions/commit/fe301ea75b035b4152c2fc65dac81036a94fa726) Thanks [@jddunn](https://github.com/jddunn)! - `reconcileInstallations` answers an installation gone only once GitHub answers its own address 404 (`GET /app/installations/{installation_id}`, read through the new `getInstallation`): the installations listing is read a page at a time, and an installation removed while it is read can move another one past a page's end, which the reconcile used to answer gone, so a caller would drop that link and uninstall the app from an account that still had it. Any other refusal of that address throws `GitHubApiError` before anything is found, as a refusal of the listing does. The outcome gains `suspended`, the linked installations GitHub has suspended, whose repositories it no longer reads: GitHub blocks a suspended installation's API access and its webhook events, and its `suspend` and `unsuspend` deliveries can arrive out of order, so a caller sets a link's suspension from this list.
  
  `listInstallations` and `getInstallation` answer each installation with `suspendedAt` (GitHub's `suspended_at`, null while it is not suspended), as `AppInstallation`. `repositoriesOfInstallation` reads its listing again when its pages disagree on GitHub's `total_count` (a repository added or taken off between two pages, which can move another past a page's end), up to three reads, and then throws the new `GitHubListingChanged`. `repositoriesLost(credential, installationId, held)` answers which of the repositories a caller holds an installation no longer reaches: those missing from two such listings, the second read only when the first misses one, since an addition and a removal between the same two pages leave the count as it was.

## 0.6.0

### Minor Changes

- [#377](https://github.com/framerslab/agentos-extensions/pull/377) [`0134ca6`](https://github.com/framerslab/agentos-extensions/commit/0134ca6dd64e1ebf039e39aa4a10c9812827e425) Thanks [@jddunn](https://github.com/jddunn)! - `repositoriesOfInstallation(credential, installationId)` lists every repository an installation reaches (`GET /installation/repositories`, across every page) with a token that reads their metadata alone, which the credential mints and holds as `metadataToken(installationId)` (`permissions: { metadata: 'read' }`, no repository named). It is the whole of what the app may read through the installation, whoever asks, so a caller finds the repositories an owner took off the app when GitHub's `installation_repositories` delivery names none of them: GitHub sends `removed` with an empty list when an installation goes from all repositories to a selection. A held token GitHub refuses is dropped (`credential.forget(installationId)`) and one new token asked for, so a refused token request throws `GitHubApiError`, 404 for an installation GitHub no longer has, and a lost installation never reads as one that reaches no repository.
  
  A connector's filter takes `includeCode`: when true, the source files of the new `CODE_EXTENSIONS` (program source in the common languages, shell scripts, SQL, GraphQL and Protocol Buffers schemas, Terraform and style sheets) are kept beside the documentation under the same size cap and skipped folders, each read as UTF-8 text, and a code file a tool wrote is left out under any extension (`isGeneratedCode`, by the endings of `GENERATED_CODE_ENDINGS`: minified and bundled files, generated Protocol Buffers and Dart files). The documentation keeps its places under `maxFiles` first and the code takes the room left, so turning code on drops no document. It is off when absent, so a filter that does not ask reads documentation alone, as before.

## 0.5.0

### Minor Changes

- [#307](https://github.com/framerslab/agentos-extensions/pull/307) [`b800dc5`](https://github.com/framerslab/agentos-extensions/commit/b800dc54d391c42a2dca4adc59b7ec3b4b2ff6b5) Thanks [@jddunn](https://github.com/jddunn)! - `GitHubDocumentsConnector` and `reconcileInstallations` read a repository by its id, at `/repositories/<id>/branches/<branch>`, `/repositories/<id>/git/trees/<sha>` and `/repositories/<id>/contents/<path>` (the address GitHub's own redirects for a renamed or moved repository lead to), where they read it by its full name. A name can come to mean another repository: a renamed repository's old name can be taken again, and an account's old login claimed by another account, which ends GitHub's redirects; and GitHub answers a public repository's branch, tree and files to any token, the installation token narrowed to the linked repository included. Once a linked repository's name passed to another account's public repository, `list` and `read` answered that repository's files as the linked one's and `reconcileInstallations` compared its head; a private repository under the name answered every file `removed`. The full name builds the attribution link alone. `readTree` takes a repository id in place of the full name; a full name is taken as well, and reads whatever repository holds that name, and a number that is not a positive integer is a `TypeError` before any request.
  
  `reconcileInstallations` stops at the first call GitHub refuses for a rate limit, where it went on calling for every other repository and delivery: it makes no call after that refusal, keeps what it found, and answers the time to run again as the outcome's new `retryAt` (null when no call was rate limited). A repository whose head read was refused for a rate limit is no longer reported unreadable, and a rate-limited redelivery ends the redeliveries.
  
  This is a minor release because every repository read goes to a new address: a stand-in that answers `/repos/<owner>/<name>/...` for the connector or the reconcile answers `/repositories/<id>/...` instead.

### Patch Changes

- [#312](https://github.com/framerslab/agentos-extensions/pull/312) [`daa2f6e`](https://github.com/framerslab/agentos-extensions/commit/daa2f6e8a7bf1f6b981ec3c99ec6c7175c10a636) Thanks [@jddunn](https://github.com/jddunn)! - `readTree` throws `TreeTooLarge` with the new `reason: 'truncated'` when GitHub answers a level of the tree truncated even when it is asked for without recursion, before any folder under it is asked for; it took that level as whole, so the files past the cut dropped out of the listing and `changesSince` answered them `removed`. A tree past its request budget throws with `reason: 'budget'`, as before.
  
  `readWebhookDelivery` and `readWebhookRequest` throw the `TypeError` for an empty or missing secret before anything else: a body past `maxBytes` was refused as `too_large` first, and `readWebhookRequest` read the whole body before it checked the secret.
  
  A read's attribution link encodes the commit or branch segment by segment, as it does the path: a default branch named `docs#1` linked as `blob/docs#1/...`, which a browser and `sourceRefLink` cut at the `#`.
  
  `uninstallInstallation`'s documentation says what it does: any 2xx and 404 count as done.

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
