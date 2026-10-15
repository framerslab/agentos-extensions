# GitHub

This pack gives an agent tools for repository search, issues, pull requests, files, branches, commits, releases, workflow dispatch, gists, and repository indexing. It uses the GitHub API through `@octokit/rest`.

Its second entry, `@framers/agentos-ext-github/documents`, is for a server that reads people's repositories through a GitHub App: the app's JWT and installation tokens, the user's web flow, the installations and repositories a person can reach, webhook deliveries checked and read as typed events, a daily reconcile, and `GitHubDocumentsConnector`, which reads a repository's documentation as account sources. See [GitHub App installation mode](#github-app-installation-mode).

## Installation

```bash
npm install @framers/agentos-ext-github @framers/agentos @framers/agentos-ext-account-sources
```

Peer dependencies: `@framers/agentos` with range `>=0.13.144`, whose auth module's `RedirectOAuthFlow` refuses a token answer that is JSON but not an object, and `@framers/agentos-ext-account-sources` with range `>=0.7.0`, whose connector types, capped reads and retry timing the `./documents` entry uses. A host keeps one copy of each; only the `./documents` entry loads `@framers/agentos-ext-account-sources`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-github',
        options: { token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `github.token` | `GITHUB_TOKEN`, then `GH_TOKEN` | Yes | Token from `gh auth token` |
| `secrets` in options or context | `github.token` | None | No | `options.secrets ?? context.secrets` |
| `priority` | None | None | No | `30` |

Token resolution checks `options.token`, the `github.token` entry in the selected secrets map, `GITHUB_TOKEN`, `GH_TOKEN`, then `gh auth token`. The manifest declares `github.token` as required.

## Tools

| Tool | What it does |
| --- | --- |
| `github_search` | Searches GitHub repositories, code, issues, or users. |
| `github_issue_list` | Lists repository issues with state and label filters. |
| `github_issue_create` | Creates an issue in a GitHub repository. |
| `github_issue_update` | Updates the provided fields of an existing GitHub issue. |
| `github_comment_list` | Lists comments on an issue or pull request. |
| `github_pr_list` | Lists pull requests with state, head, and base branch filters. |
| `github_pr_create` | Creates a pull request in a GitHub repository. |
| `github_pr_diff` | Gets changed files and optional patches for a pull request. |
| `github_pr_review` | Creates a pull request review with optional inline comments. |
| `github_pr_merge` | Merges a pull request using merge, squash, or rebase. |
| `github_pr_comment_list` | Lists inline review comments on a pull request. |
| `github_pr_comment_create` | Adds a top-level comment to a pull request. |
| `github_file_read` | Reads repository file contents as decoded UTF-8 text. |
| `github_gist_create` | Creates a GitHub gist containing files. |
| `github_repo_list` | Lists repositories for a GitHub user or organisation. |
| `github_repo_info` | Gets repository metadata including stars, forks, topics, license, and default branch. |
| `github_repo_create` | Creates a repository for the authenticated user. |
| `github_repo_index` | Fetches repository metadata, file tree, README, documentation, and `package.json` as text chunks. |
| `github_release_list` | Lists repository releases with tag, name, status, and publish date. |
| `github_release_create` | Creates a release with draft, prerelease, and generated release notes options. |
| `github_actions_list` | Lists workflow runs with an optional workflow filter. |
| `github_actions_trigger` | Triggers a workflow dispatch with optional inputs and target ref. |
| `github_file_write` | Creates or updates a repository file using an existing file SHA for updates. |
| `github_branch_list` | Lists branches with commit SHA and protection status. |
| `github_branch_create` | Creates a branch and resolves a named source branch to its HEAD SHA. |
| `github_commit_list` | Lists commits with branch, path, author, and date filters. |

`manifest.json` lists each tool under the name in this table, which is the name the pack registers it with. The extension registry's listing and AgentOS's capability discovery read the tools from the manifest, so the names a model finds there are the names it can call.

### `github_search`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | `string` | Yes | Search query (GitHub search syntax supported) |
| `type` | `string: repositories, code, issues, users` | No | Search type (default: repositories) |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_issue_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `state` | `string: open, closed, all` | No | Issue state filter (default: open) |
| `labels` | `string` | No | Comma-separated label names to filter by |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_issue_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `title` | `string` | Yes | Issue title |
| `body` | `string` | No | Issue body (Markdown supported) |
| `labels` | `array of string` | No | Labels to apply |
| `assignees` | `array of string` | No | GitHub usernames to assign |

### `github_issue_update`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `issue_number` | `number` | Yes | Issue number to update |
| `title` | `string` | No | New issue title |
| `body` | `string` | No | New issue body (Markdown supported) |
| `state` | `string: open, closed` | No | Set issue state |
| `labels` | `array of string` | No | Replace labels (full set, not additive) |
| `assignees` | `array of string` | No | Replace assignees (full set, not additive) |

### `github_comment_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `issue_number` | `number` | Yes | Issue or PR number |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_pr_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `state` | `string: open, closed, all` | No | PR state filter (default: open) |
| `head` | `string` | No | Filter by head branch (user:branch format) |
| `base` | `string` | No | Filter by base branch |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_pr_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `title` | `string` | Yes | PR title |
| `head` | `string` | Yes | Head branch name (source) |
| `base` | `string` | Yes | Base branch name (target, e.g. "main") |
| `body` | `string` | No | PR description (Markdown supported) |
| `draft` | `boolean` | No | Create as draft PR (default: false) |

### `github_pr_diff`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `pull_number` | `number` | Yes | Pull request number |
| `include_patch` | `boolean` | No | Include patch/diff text per file (default: false). Patches are truncated to 3000 chars. |

### `github_pr_review`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `pull_number` | `number` | Yes | Pull request number |
| `event` | `string: APPROVE, COMMENT, REQUEST_CHANGES` | Yes | Review action: APPROVE, COMMENT, or REQUEST_CHANGES |
| `body` | `string` | No | Review body/summary (required for REQUEST_CHANGES) |
| `comments` | `array of object` | No | Inline review comments |
| `comments[].path` | `string` | Yes, within each comment | File path relative to repo root |
| `comments[].line` | `number` | Yes, within each comment | Line number in the diff to comment on |
| `comments[].body` | `string` | Yes, within each comment | Comment body |

### `github_pr_merge`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `pull_number` | `number` | Yes | Pull request number |
| `merge_method` | `string: merge, squash, rebase` | No | Merge strategy (default: merge) |
| `commit_title` | `string` | No | Custom merge commit title |
| `commit_message` | `string` | No | Custom merge commit message body |

### `github_pr_comment_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `pull_number` | `number` | Yes | Pull request number |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_pr_comment_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `pull_number` | `number` | Yes | Pull request number |
| `body` | `string` | Yes | Comment body (Markdown supported) |

### `github_file_read`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `path` | `string` | Yes | File path within the repository |
| `ref` | `string` | No | Branch, tag, or commit SHA (default: default branch) |

### `github_gist_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `description` | `string` | No | Gist description |
| `files` | `object with string values` | Yes | Map of filename to content. Example: {"main.py": "print('hello')"} |
| `public` | `boolean` | No | Whether the gist is public (default: false) |

### `github_repo_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `username` | `string` | Yes | GitHub username or organisation name |
| `type` | `string: user, org` | No | Account type: "user" (default) or "org" |
| `sort` | `string: created, updated, pushed, full_name` | No | Sort field (default: updated) |
| `per_page` | `number` | No | Results per page (max 100, default 30) |

### `github_repo_info`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |

### `github_repo_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | `string` | Yes | Repository name |
| `description` | `string` | No | Short description of the repository |
| `private` | `boolean` | No | Whether the repo is private (default: false) |
| `auto_init` | `boolean` | No | Initialize with a README (default: false) |
| `gitignore_template` | `string` | No | Gitignore template name (e.g. "Node", "Python") |
| `license_template` | `string` | No | License template (e.g. "mit", "apache-2.0") |

### `github_repo_index`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `ref` | `string` | No | Branch, tag, or SHA (default: default branch) |
| `max_doc_files` | `number` | No | Max number of doc files to fetch (default: 10) |

### `github_release_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_release_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `tag_name` | `string` | Yes | Tag name for the release. |
| `name` | `string` | No | Release title |
| `body` | `string` | No | Release notes body (Markdown supported) |
| `draft` | `boolean` | No | Create as draft release (default: false) |
| `prerelease` | `boolean` | No | Mark as prerelease (default: false) |
| `target_commitish` | `string` | No | Branch or commit SHA to tag (default: default branch) |
| `generate_release_notes` | `boolean` | No | Auto-generate release notes from commits (default: false) |

### `github_actions_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `workflow_id` | `string` | No | Workflow ID or filename (e.g. "ci.yml") to filter by |
| `per_page` | `number` | No | Results per page (max 30, default 10) |

### `github_actions_trigger`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `workflow_id` | `string` | Yes | Workflow ID or filename (e.g. "deploy.yml") |
| `ref` | `string` | No | Git ref to run the workflow on (default: "master") |
| `inputs` | `object with string values` | No | Key-value input parameters for the workflow |

### `github_file_write`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `path` | `string` | Yes | File path within the repository |
| `content` | `string` | Yes | File content (plain text, will be base64-encoded automatically) |
| `message` | `string` | Yes | Commit message |
| `branch` | `string` | No | Target branch (default: repo default branch) |
| `sha` | `string` | No | SHA of the file being replaced (required for updates, omit for new files) |

### `github_branch_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `protected` | `boolean` | No | Filter to only protected branches |
| `per_page` | `number` | No | Results per page (max 100, default 30) |

### `github_branch_create`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `branch` | `string` | Yes | New branch name to create |
| `from` | `string` | No | Source branch name or commit SHA to branch from (default: repo default branch) |

### `github_commit_list`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `owner` | `string` | Yes | Repository owner (user or org) |
| `repo` | `string` | Yes | Repository name |
| `sha` | `string` | No | Branch name or commit SHA to list from (default: default branch) |
| `path` | `string` | No | Only include commits touching this file path |
| `author` | `string` | No | GitHub login or email to filter by author |
| `since` | `string` | No | ISO 8601 date, only commits after this date |
| `until` | `string` | No | ISO 8601 date, only commits before this date |
| `per_page` | `number` | No | Results per page (max 100, default 30) |

## Notes

Node.js with range `>=22` is required. Activation initializes Octokit and fetches the authenticated user. Missing credentials cause the factory to throw after the CLI fallback fails. The CLI fallback needs an installed, authenticated `gh` executable and uses a timeout of `5000` milliseconds.

Creation, update, review, comment, merge, file write, release, and workflow dispatch tools change GitHub resources. Gists and repositories default to non-public and public visibility respectively. Issue updates replace supplied label and assignee sets.

List and search tools fetch a page of results and cap `per_page` as described in their schemas. Pull request patches are truncated when requested. Repository indexing returns text chunks and skips unreadable documentation; it does not create embeddings or write to a vector store. File reads also return directory entries when the path refers to a directory.

Top-level pull request comments use the issues API. `github_pr_comment_list` returns inline review comments; `github_comment_list` returns top-level comments.

`GitHubRepoIndexer` indexes the repositories its constructor is given, `new GitHubRepoIndexer(service, { repositories: [{ owner, repo }] })`, and the six repositories of `ECOSYSTEM_REPOS` when it is given none. The package's entry exports both, with the types `IndexedRepository` and `GitHubRepoIndexerOptions`.

## GitHub App installation mode

The `./documents` entry reads repositories through a GitHub App instead of one personal token. Every call goes to GitHub's REST API over the `fetch` you pass (the global `fetch` by default) with `X-GitHub-Api-Version: 2026-03-10`, so tests point it at a stand-in with `{ fetchImpl, apiBase }`.

```ts
import { readFileSync } from 'node:fs';
import {
  GitHubAppCredential,
  GitHubAppUserFlow,
  GitHubDocumentsConnector,
  installationsOfUser,
  repositoriesOfUser,
  userOfToken,
} from '@framers/agentos-ext-github/documents';

const credential = new GitHubAppCredential({
  clientId: process.env.GITHUB_APP_CLIENT_ID!,
  privateKey: readFileSync('/run/secrets/github_app_key', 'utf8'),
});
const flow = new GitHubAppUserFlow({
  clientId: process.env.GITHUB_APP_CLIENT_ID!,
  clientSecret: readFileSync('/run/secrets/github_app_client_secret', 'utf8').trim(),
});
const redirectUri = 'https://example.com/github/callback';

// Where GitHub sends the installer: keep `state` and `codeVerifier` (in a row keyed by a cookie), then redirect.
const { url, state, codeVerifier } = flow.begin({ redirectUri });

// The callback: check the state, exchange the code, and link only what this person's token reaches.
const { accessToken } = await flow.complete({ code, state: returnedState, expectedState: state, codeVerifier, redirectUri });
const person = await userOfToken(accessToken);
const reachable = (await installationsOfUser(accessToken)).some((installation) => installation.id === installationId);
const repositories = reachable ? await repositoriesOfUser(accessToken, installationId) : [];
// Done with the person's token: delete it at GitHub, so it stops working now rather than when it expires.
await flow.revoke(accessToken);

// Read the documentation at the default branch's head.
const connector = new GitHubDocumentsConnector(credential, installationId, repositories);
for (const repository of repositories) {
  const commit = await connector.head(repository.id);
  for (const blob of await connector.listing(repository.id, commit)) {
    const read = await connector.read({ id: `${repository.id}:${blob.path}`, title: blob.path, size: blob.size, version: `${blob.sha}@${commit}` });
    if ('reason' in read) continue;
    // read.content is { text } or { bytes, mediaType }; read.ref links the file at the commit.
  }
}
```

A delivery arrives at the app's webhook. `readWebhookRequest` reads its body under a cap, checks its signature on the raw bytes, reads its id, and only then parses it into a typed event. Answer GitHub at once (it expects a 2xx within 10 seconds), apply each delivery id once (a redelivery carries the id of the delivery it repeats), and do the reading in a job:

```ts
import { readWebhookRequest, WebhookDeliveryRefused } from '@framers/agentos-ext-github/documents';

const REFUSALS = { too_large: 413, signature: 401, delivery: 400, body: 400 } as const;

export async function POST(request: Request): Promise<Response> {
  let delivery;
  try {
    delivery = await readWebhookRequest(request, webhookSecret, { maxBytes: 5 * 1024 * 1024 });
  } catch (error) {
    if (error instanceof WebhookDeliveryRefused) return new Response(null, { status: REFUSALS[error.reason] });
    throw error;
  }
  if (!(await firstSight(delivery.id))) return new Response(null, { status: 200 });
  const event = delivery.event;
  if (event.kind === 'push' && event.toDefaultBranch) await owe(event.installationId, event.repository.id, event.after);
  if (event.kind === 'installation' && event.action === 'deleted') await unlink(event.installationId);
  if (event.kind === 'installation_repositories') await drop(event.installationId, event.removed.map((repository) => repository.id));
  return new Response(null, { status: 200 });
}

// The job compares the tree at the push's after commit with the blobs read before.
const changes = await connector.changesSince(cursor, { ids: [String(repositoryId)], after });
// Read changes.changed again, delete changes.gone, keep changes.cursor for the next push.
```

| Event | Answered as |
| --- | --- |
| `push` | `{ kind: 'push', installationId, repository: { id, fullName, defaultBranch }, ref, before, after, created, deleted, forced, toDefaultBranch }`; `toDefaultBranch` is true when `ref` is `refs/heads/<default branch>` and the push did not delete it |
| `installation` | `{ kind: 'installation', action, installationId, account, repositories }` for `created`, `deleted`, `suspend`, `unsuspend` and `new_permissions_accepted`; `repositories` lists what a new installation on selected repositories can access |
| `installation_repositories` | `{ kind: 'installation_repositories', action: 'added' \| 'removed', installationId, selection: 'all' \| 'selected', added, removed }`; when an installation goes from all repositories to a selection, GitHub lists none of the repositories that left, so read the installation's repositories again |
| `installation_target` | `{ kind: 'installation_target', action: 'renamed', installationId, account }`, the account under its new login or slug |
| `ping` | `{ kind: 'ping' }` |
| anything else | `{ kind: 'other' }`, as is a payload without the fields above; `delivery.name` holds the event's name |

A delivery is refused with `WebhookDeliveryRefused`, checked in this order: `too_large` past `maxBytes` (25 MiB by default; the request's stream is cancelled at the cap, and a `Content-Length` past it is refused unread), `signature` when `X-Hub-Signature-256` does not hold under the secret, `delivery` without a usable `X-GitHub-Delivery`, `body` for a signed body that is not a JSON object. An empty secret throws a `TypeError`. `readWebhookDelivery({ headers, body }, secret, options)` does the same for a body already read. No error quotes a payload.

Every call runs under a deadline, 30 seconds by default (`GITHUB_TIMEOUT_MS`), its answer's body included, joined with the caller's signal where a method takes one. The functions that take `{ fetchImpl, apiBase }` take `timeoutMs` beside them, `GitHubAppUserFlow` takes `{ timeoutMs, apiBase }` as its fourth argument, for the code exchange and `revoke`, and `installationToken(installationId, repositoryIds, { signal, timeoutMs })` takes both: the connector's calls pass their signal on to the token request, and `reconcileInstallations` its `timeoutMs`; the connector's own calls keep the default deadline. A call that gets no answer throws `GitHubNoAnswer` with its `reason`: `timeout`, `cancelled` or `network`, and so does a refused call whose body stops while it is read to tell a rate limit. A JSON answer is read under 16 MiB (`GITHUB_MAX_ANSWER_BYTES`). An answer outside 2xx throws `GitHubApiError` with `status`, `rateLimited` and `retryAt`, following GitHub's [rules for a refused call](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit): a 429, or a 403 with `retry-after`, `x-ratelimit-remaining: 0` or a body naming a rate limit, is a rate limit, and `retryAt` (epoch milliseconds) is `retry-after` first, then `x-ratelimit-reset` when the remaining count is 0, else a minute on. Do not call again before `retryAt`: GitHub may ban an integration that keeps calling while rate limited. A 5xx's `retry-after` sets `retryAt` too.

| Export | What it does |
| --- | --- |
| `appJwt(identity, nowSeconds?)` | The app's JWT: RS256, `iat` 60 seconds back, `exp` nine minutes ahead, `iss` the client id |
| `GitHubAppCredential` | Mints installation tokens narrowed to the repositories asked for (`repository_ids`), each request under the caller's `signal` and `timeoutMs`, and holds each token until five minutes before its hour ends; an empty list throws a `TypeError`, since GitHub answers it with a token for every repository of the installation |
| `GitHubAppUserFlow` | The user's web flow on the auth module's `RedirectOAuthFlow`: GitHub's authorize address with `state` and PKCE and no `scope`, and the code exchange under a deadline (`new GitHubAppUserFlow(client, fetchImpl, endpoints, { timeoutMs, apiBase })`), which never follows a redirect from the token address: the redirect is refused with `OAuthGrantRefused` and its status, so the code and the client secret reach that address alone; it has no store, so the user token is used once; `revoke(token)` deletes it at GitHub with the app's client id and secret (`DELETE /applications/{client_id}/token`, Basic authentication), throwing `OAuthGrantRefused` (reason `revoke`, its status) for any answer but 204 and refusing a redirect unfollowed |
| `userOfToken`, `installationsOfUser`, `repositoriesOfUser` | The person a user token belongs to, the app's installations they can access, and the repositories of an installation they can read, across every page |
| `listInstallations`, `uninstallInstallation` | The app's installations, and its uninstall, which takes 202 (GitHub removes it in the background), 204 and 404 as done |
| `verifyWebhookSignature(body, header, secret)` | Checks `X-Hub-Signature-256` against the HMAC SHA-256 of the raw body in constant time; an empty or missing secret throws a `TypeError`, since anyone can sign a delivery under an empty key |
| `readWebhookRequest(request, secret, { maxBytes })`, `readWebhookDelivery({ headers, body }, secret, { maxBytes })` | Read a delivery under a cap, check its signature and id, and answer it as a typed event, or throw `WebhookDeliveryRefused` with its reason |
| `reconcileInstallations(credential, links, { since })` | Answers the linked installations GitHub no longer lists, the repositories whose default branch moved past the head last read, the repositories it could not read, and asks again for each event since `since` that no delivery attempt delivered, reporting GitHub's refusals of that step in `deliveries` |
| `GitHubDocumentsConnector` | An `AccountSourceConnector` of `@framers/agentos-ext-account-sources` over one installation's linked repositories |
| `readTree`, `pathFilter`, `TreeTooLarge` | A tree at a commit within a request budget, and the filter that keeps documentation |
| `GitHubApiError` | An answer outside 2xx; carries the status, `rateLimited` and `retryAt`, and nothing of the body |
| `GitHubNoAnswer` | A call that got no answer, by its `reason`: `timeout`, `cancelled` or `network` |

The reconcile leaves failed a delivery whose newest attempt the receiving route answered with a 4xx other than 408 and 429, such as a 413 for a body past the route's size cap: that refusal answers the same on every attempt. A 408, a 429, a 5xx or any other failed attempt is asked for again. When GitHub answers the deliveries listing outside 2xx, `deliveries.listingStatus` holds its status and no delivery is asked for again, since a delivery's other attempts may lie on the pages not read; a redelivery GitHub refuses is listed in `deliveries.refused` with its status, and the others are still asked for. Either way the outcome carries `gone`, `moved` and `unreadable`.

The connector's filter, `new GitHubDocumentsConnector(credential, installationId, repositories, filter)`:

| Field | Default |
| --- | --- |
| `extensions` | `.md`, `.markdown`, `.txt`, `.rst`, `.html`, `.htm`, `.pdf`, `.docx` |
| `skipFolders` | `node_modules`, `vendor`, `dist`, `build`, `.git`, `third_party`, at any depth |
| `maxFiles` | `2000`, in path order: a listing keeps the first `maxFiles` documentation paths, so when a new path sorts before them, the last one kept leaves the listing and `changesSince` answers it gone |
| `maxFileBytes` | `10485760` (10 MiB): larger files are left out of a listing, and a read past it is answered gone |
| `maxTreeRequests` | `50` tree requests to list one commit |

An item's id is `<repositoryId>:<path>` and its version `<blob>@<commit>`. A tree is asked for recursively; when GitHub answers it truncated (past 100,000 entries or 7 MB), its top level is read and each subtree is asked for the same way, never walking a skipped folder, and `TreeTooLarge` is thrown rather than pass `maxTreeRequests`. Files are read through the contents endpoint's raw media type as a stream cut at `maxFileBytes`: PDF, Word and HTML as bytes with their media type, the rest as UTF-8 text, each with a `github` source reference whose `url` is the file at the commit. An item whose version names no commit (none, or no `@<commit>` part) is read at the default branch, and its reference names the branch. `changesSince` takes the cursor it answered last (each documentation path's blob), never reads a push's commit list, so a force push is read like any other, and answers a push to another branch than the default with no change. `listing(repositoryId, commit)` lets a caller keep a commit's listing and pass it to `changesSince` as `listing`, with that commit as `after`; it then reads no tree. A cursor `changesSince` did not answer throws a `TypeError` that quotes none of it, whatever the push's branch. A file read GitHub refuses for a rate limit throws `GitHubApiError` with its `retryAt`, never an answer that the file is gone, and so does a refused installation token (404 for an installation GitHub no longer has): only the contents read's own 404 answers a file `removed`, so a lost installation never reads as every file gone.

The connector refuses, before any request, what it cannot answer whole, and no refusal quotes a cursor, an item id or a path. A repository id, in a selection or in an item id, is a positive integer in decimal (`77`; never `077`, `0x4d` or ` 77`), else a `TypeError`. `list` checks every id of its selection before it reads any repository, so a selection is listed whole or not at all: a repository named twice is a `TypeError`, and one outside the link an `Error` naming its number. `read` throws a `TypeError` for an item id that names no file: one without a path, or whose path has an empty, `.` or `..` segment. `changesSince` compares one repository a call: a selection of none or several, an empty `after`, or a `listing` without the `after` commit it was read at is a `TypeError`, so call it once per repository, each with that repository's own cursor. A call whose signal is already aborted throws `GitHubNoAnswer` (`cancelled`).

## License

Apache-2.0
