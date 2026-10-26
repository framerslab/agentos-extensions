# GitHub

This pack gives an agent tools for repository search, issues, pull requests, files, branches, commits, releases, workflow dispatch, gists, and repository indexing. It uses the GitHub API through `@octokit/rest`.

Its second entry, `@framers/agentos-ext-github/documents`, is for a server that reads people's repositories through a GitHub App: the app's JWT and installation tokens, the user's web flow, the installations and repositories a person can reach, webhook deliveries checked and read as typed events, a daily reconcile, and `GitHubDocumentsConnector`, which reads a repository's documentation as account sources. See [GitHub App installation mode](#github-app-installation-mode).

## Installation

```bash
npm install @framers/agentos-ext-github @framers/agentos @framers/agentos-ext-account-sources
```

Peer dependencies: `@framers/agentos` with range `>=0.13.144`, whose auth module's `RedirectOAuthFlow` refuses a token answer that is JSON but not an object, and `@framers/agentos-ext-account-sources`, whose connector types, capped reads and retry timing the `./documents` entry uses, at or above the floor this package's `peerDependencies` names; `npm view @framers/agentos-ext-github peerDependencies` prints the latest release's. A host keeps one copy of each; only the `./documents` entry loads `@framers/agentos-ext-account-sources`.

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

A repository is read by its id, at `/repositories/<id>/branches/<branch>`, `/repositories/<id>/git/trees/<sha>`, `/repositories/<id>/contents/<path>` and `/repositories/<id>/git/matching-refs/heads/<name>`, the address GitHub's own redirects for a renamed or moved repository lead to, and never by its name. A name can come to mean another repository: a renamed repository's old name can be taken again, and an account's old login claimed by another account, which ends GitHub's redirects to it; and GitHub answers a public repository's branch, tree and files to any token, an installation token narrowed to other repositories included. The full name builds a read's attribution link and nothing else.

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

A delivery is refused with `WebhookDeliveryRefused`, checked in this order: `too_large` past `maxBytes` (25 MiB by default; the request's stream is cancelled at the cap, and a `Content-Length` past it is refused unread), `signature` when `X-Hub-Signature-256` does not hold under the secret, `delivery` without a usable `X-GitHub-Delivery`, `body` for a signed body that is not a JSON object. An empty secret throws a `TypeError` before any of these, whatever the delivery, before its size is measured or a byte of its body read. `readWebhookDelivery({ headers, body }, secret, options)` does the same for a body already read. No error quotes a payload.

Every call runs under a deadline, 30 seconds by default (`GITHUB_TIMEOUT_MS`), its answer's body included, joined with the caller's signal where a method takes one. The functions that take `{ fetchImpl, apiBase }` take `timeoutMs` beside them, `GitHubAppUserFlow` takes `{ timeoutMs, apiBase }` as its fourth argument, for the code exchange and `revoke`, and `installationToken(installationId, repositoryIds, { signal, timeoutMs })` takes both: the connector's calls pass their signal on to the token request, and `reconcileInstallations` its `timeoutMs`; the connector's own calls keep the default deadline. A call that gets no answer throws `GitHubNoAnswer` with its `reason`: `timeout`, `cancelled` or `network`, and so does a refused call whose body stops while it is read to tell a rate limit. The deadline and the cancel hold whatever the injected `fetch` does with the signal it is handed: a fetch that leaves its request or its answer's body open past that signal still ends the call on time, and an answer it gives after the deadline has its body released unread. A body still being read when its call ends is cancelled there, so nothing more of it is read, and a body the pack lets go (a refusal told by its status and headers, the answer to an uninstall, a redelivery or a revocation) is released without waiting on its cancel. A JSON answer is read under 16 MiB (`GITHUB_MAX_ANSWER_BYTES`). An answer outside 2xx throws `GitHubApiError` with `status`, `rateLimited` and `retryAt`, following GitHub's [rules for a refused call](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit): a 429, or a 403 with `retry-after`, `x-ratelimit-remaining: 0` or a body naming a rate limit, is a rate limit, and `retryAt` (epoch milliseconds) is `retry-after` first, then `x-ratelimit-reset` when the remaining count is 0, else a minute on. Do not call again before `retryAt`: GitHub may ban an integration that keeps calling while rate limited. A 5xx's `retry-after` sets `retryAt` too.

| Export | What it does |
| --- | --- |
| `appJwt(identity, nowSeconds?)` | The app's JWT: RS256, `iat` 60 seconds back, `exp` nine minutes ahead, `iss` the client id |
| `GitHubAppCredential` | Mints installation tokens narrowed to the repositories asked for (`repository_ids`), each request under the caller's `signal` and `timeoutMs`, and holds each token until five minutes before its hour ends; an empty list throws a `TypeError`, since GitHub answers it with a token for every repository of the installation. `metadataToken(installationId, { signal, timeoutMs })` mints, and holds the same way, a token for every repository of the installation that reads their metadata alone (`permissions: { metadata: 'read' }`): enough to list them, never to read a file. `forget(installationId)` drops the tokens held for an installation, so the next call mints again |
| `GitHubAppUserFlow` | The user's web flow on the auth module's `RedirectOAuthFlow`: GitHub's authorize address with `state` and PKCE and no `scope`, and the code exchange under a deadline (`new GitHubAppUserFlow(client, fetchImpl, endpoints, { timeoutMs, apiBase })`), which never follows a redirect from the token address: the redirect is refused with `OAuthGrantRefused` and its status, so the code and the client secret reach that address alone; it has no store, so the user token is used once; `revoke(token)` deletes it at GitHub with the app's client id and secret (`DELETE /applications/{client_id}/token`, Basic authentication), throwing `OAuthGrantRefused` (reason `revoke`, its status) for any answer but 204, another 2xx included, and refusing a redirect unfollowed; the answer is told by its status alone, its body released unread however large or slow |
| `userOfToken`, `installationsOfUser`, `repositoriesOfUser` | The person a user token belongs to, the app's installations they can access, and the repositories of an installation they can read, across every page |
| `repositoriesOfInstallation(credential, installationId)` | Every repository an installation reaches (`GET /installation/repositories`), across every page, read with the credential's metadata token: the whole of what the app may read through the installation, whoever asks, so a repository its owner took off the app is missing from it. When an installation goes from all repositories to a selection, GitHub's `installation_repositories` delivery lists none of the repositories that left; this listing finds them. A held token GitHub refuses (401) is dropped and one new token asked for, once; a refused token request throws `GitHubApiError` (404 for an installation GitHub no longer has), so a lost installation never reads as one that reaches no repository. The listing is read a page at a time, and a repository added to or taken off the installation between two pages changes GitHub's `total_count` and can move another one past a page's end: a read whose pages disagree on that count is read again, up to three reads, and then `GitHubListingChanged` is thrown |
| `repositoriesLost(credential, installationId, held)` | Which of the repositories `held` an installation no longer reaches: those missing from two listings, the second read only when the first misses one, since an addition and a removal between the same two pages leave the count as it was and can still move a repository past a page's end; in the order of `held`, each id once, with no request for an empty `held`; a refused listing, or `GitHubListingChanged`, is thrown. A limit: a repository is answered lost when, in each of the two listings, an addition and a removal between the same two pages moved it past a page's end |
| `listInstallations`, `getInstallation`, `uninstallInstallation` | The app's installations, each with `suspendedAt` (GitHub's `suspended_at`, null while it is not suspended); one installation by its id (`GET /app/installations/{installation_id}`), with `suspendedAt`, or null on 404, any other refusal thrown; and its uninstall, which takes a 2xx (202 at the pinned API version, where GitHub removes it in the background; 204 at earlier versions) and 404 as done |
| `verifyWebhookSignature(body, header, secret)` | Checks `X-Hub-Signature-256` against the HMAC SHA-256 of the raw body in constant time; an empty or missing secret throws a `TypeError`, since anyone can sign a delivery under an empty key |
| `readWebhookRequest(request, secret, { maxBytes })`, `readWebhookDelivery({ headers, body }, secret, { maxBytes })` | Read a delivery under a cap, check its signature and id, and answer it as a typed event, or throw `WebhookDeliveryRefused` with its reason |
| `reconcileInstallations(credential, links, { since })` | Answers the linked installations GitHub no longer has (`gone`: missing from the listing and answered 404 at their own address, since an installation removed while the listing is read can move another past a page's end), those GitHub has suspended (`suspended`, whose repositories it does not read), the repositories whose default branch moved past the head last read, the repositories it could not read, and asks again for each event since `since` that no delivery attempt delivered, reporting GitHub's refusals of that step in `deliveries`; a rate limit ends it, with `retryAt` |
| `GitHubDocumentsConnector` | An `AccountSourceConnector` of `@framers/agentos-ext-account-sources` over one installation's linked repositories, at each one's default branch or at the branch or commit a selection's `at` names, whole or within the folder its `path` names; `resolveRef(repositoryId, refAndPath)` settles a link's ref as a branch, a tag or a commit |
| `parseGitHubLink(text)` | The repository, folder or file a GitHub address names, read without a request; `refused` for any other address on GitHub's hosts, `null` for another host's |
| `readTree`, `pathFilter`, `TreeTooLarge` | A tree at a commit within a request budget, `readTree(fetchImpl, token, repositoryId, commit)` reading the repository by its id (a full name is taken too, and reads whatever repository holds that name; a number that is not a positive integer is a `TypeError` before any request), and the filter that keeps documentation, and code when asked (`includeCode`); `TreeTooLarge` carries `reason`, `budget` or `truncated` |
| `CODE_EXTENSIONS`, `GENERATED_CODE_ENDINGS`, `isGeneratedCode(path)` | The source files a filter that includes code keeps, and the endings of the code files a tool writes (minified and bundled files, generated Protocol Buffers and Dart files), which it leaves out |
| `planTree(blobs, options)`, `IMAGE_EXTENSIONS` | Every file of a tree with its outcome under `pathFilter`'s filter: a note, or skipped with the reason it is left out |
| `GitHubApiError` | An answer outside 2xx; carries the status, `rateLimited` and `retryAt`, and nothing of the body |
| `GitHubListingChanged` | An installation's repositories changed during each of three reads of their listing (its pages disagreed on `total_count`), so no read is whole; its message names nothing of the installation |
| `GitHubNoAnswer` | A call that got no answer, by its `reason`: `timeout`, `cancelled` or `network` |

The reconcile leaves failed a delivery whose newest attempt the receiving route answered with a 4xx other than 408 and 429, such as a 413 for a body past the route's size cap: that refusal answers the same on every attempt. A 408, a 429, a 5xx or any other failed attempt is asked for again. When GitHub answers the deliveries listing outside 2xx, `deliveries.listingStatus` holds its status and no delivery is asked for again, since a delivery's other attempts may lie on the pages not read; a redelivery GitHub refuses is listed in `deliveries.refused` with its status, and the others are still asked for. Either way the outcome carries `gone`, `suspended`, `moved` and `unreadable`.

`suspended` is GitHub's word on each linked installation that is not gone: a linked installation in neither `gone` nor `suspended` is not suspended. GitHub blocks a suspended installation's API access and its webhook events, and its `suspend` and `unsuspend` deliveries can arrive out of order or be refused by a receiving route that is switched off, so a caller that keeps a link's suspension from those deliveries sets it from this list.

A call GitHub refuses for a rate limit ends the reconcile: it makes no call after that one, sets `retryAt` (epoch milliseconds) to the time GitHub gave, and answers what it found before the refusal. The gone and the suspended installations are always whole, since they are settled before any head is read; the repository whose head read was refused is not counted unreadable, and the repositories and the deliveries step it had not reached wait for the next run, which starts no sooner than `retryAt`. A refused redelivery is still listed in `deliveries.refused`. `retryAt` is null when no call was rate limited. A rate limit on the installations listing itself, or on a missing installation's own address, throws `GitHubApiError` with its `retryAt`, before anything is found, as any other refusal of those calls does (a 404 at an installation's own address apart, which answers it gone).

The connector's filter, `new GitHubDocumentsConnector(credential, installationId, repositories, filter)`:

| Field | Default |
| --- | --- |
| `extensions` | `.md`, `.markdown`, `.txt`, `.rst`, `.html`, `.htm`, `.pdf`, `.docx` |
| `includeCode` | `false`: when true, the source files of `CODE_EXTENSIONS` are kept beside `extensions` under the same bounds and skipped folders, each read as UTF-8 text, and a code file a tool wrote is left out (`isGeneratedCode`: a name ending in `.min.js`, `.min.css`, `.bundle.js`, `.bundle.css`, `.pb.go`, `_pb2.py` and the like), under an extension `extensions` names too. Data and configuration files (JSON, YAML, XML, CSV) are not code here; name their extensions in `extensions` to keep them |
| `skipFolders` | `node_modules`, `vendor`, `dist`, `build`, `.git`, `third_party`, at any depth |
| `maxFiles` | `2000`, in path order: a listing keeps the first `maxFiles` documentation paths, so when a new path sorts before them, the last one kept leaves the listing and `changesSince` answers it gone. A selection's `path` narrows a listing to a folder, or a file, before the count, so the folder's files are counted alone; a `listing` handed to `changesSince` with a `path` that holds `maxFiles` files may have been cut before the folder's files, and the folder is read afresh instead of it. With `includeCode`, the documentation keeps its places first and the code paths, in path order, take the room left, so turning code on drops no document |
| `maxFileBytes` | `10485760` (10 MiB): larger files are left out of a listing, and a read past it is answered gone |
| `maxTreeRequests` | `50` tree requests to list one commit |

An item's id is `<repositoryId>:<path>` and its version `<blob>@<commit>`. A tree is asked for recursively; when GitHub answers it truncated (past 100,000 entries or 7 MB), its top level is read and each subtree is asked for the same way, never walking a skipped folder. `TreeTooLarge` is thrown rather than pass `maxTreeRequests` (`reason: 'budget'`), and at a level GitHub answers truncated when it is asked for alone as well (`reason: 'truncated'`), before any folder under it is asked for: no part of a tree is answered, since the files it left out would read as removed. Files are read through the contents endpoint's raw media type as a stream cut at `maxFileBytes`: PDF, Word and HTML as bytes with their media type, the rest as UTF-8 text, each with a `github` source reference whose `url` is the file at the commit, the commit or branch encoded segment by segment as the path is, so a branch named `docs#1` links as `docs%231`. An item whose version names no commit (none, or no `@<commit>` part) is read at the default branch, and its reference names the branch. `changesSince` takes the cursor it answered last (each documentation path's blob), never reads a push's commit list, so a force push is read like any other, and answers a push to another branch than the one it follows with no change. `listing(repositoryId, commit)` lets a caller keep a commit's listing and pass it to `changesSince` as `listing`, with that commit as `after`; it then reads no tree. `listing(repositoryId, commit, { path, signal })` reads a folder's listing, or a file's, the same way. A cursor `changesSince` did not answer throws a `TypeError` that quotes none of it, whatever the push's branch. A file read GitHub refuses for a rate limit throws `GitHubApiError` with its `retryAt`, never an answer that the file is gone, and so does a refused installation token (404 for an installation GitHub no longer has): only the contents read's own 404 answers a file `removed`, so a lost installation never reads as every file gone.

The connector refuses, before any request, what it cannot answer whole, and no refusal quotes a cursor, an item id or a path. A repository id, in a selection or in an item id, is a positive integer in decimal (`77`; never `077`, `0x4d` or ` 77`), else a `TypeError`. `list` checks every id of its selection before it reads any repository, so a selection is listed whole or not at all: a repository named twice is a `TypeError`, and one outside the link an `Error` naming its number. `read` throws a `TypeError` for an item id that names no file: one without a path, or whose path has an empty, `.` or `..` segment. `changesSince` compares one repository a call: a selection of none or several, an empty `after`, or a `listing` without the `after` commit it was read at is a `TypeError`, so call it once per repository, each with that repository's own cursor. A `path` with an empty, `.` or `..` segment (a leading or a trailing slash among them), or one that is not text, is a `TypeError` in `list`, `listing`, `changesSince` and `planTree`, and so is a `path` beside other than one repository in `list`. A call whose signal is already aborted throws `GitHubNoAnswer` (`cancelled`) before it checks anything else, so every aborted call answers alike, whatever its inputs.

`list`, `changesSince` and `head` follow the default branch, or the branch or commit a selection's `at` names (`head(repositoryId, at, signal)`; `head(repositoryId, signal)` reads the default branch as before). A branch's head is read when the call is made; a commit, 40 hexadecimal characters in either case, is read as it is with no branch read, in lower case, and never changes. `list({ ids: [String(repositoryId)], at: 'release/1.0' })` lists one repository at that branch's head, each item's version `<blob>@<commit>` at it. `changesSince` compares at the followed branch's head when the call names no `after`, answers a push whose `ref` is not `refs/heads/<at>` with no change (the default branch's push included, while `at` names another branch), and answers any push with no change when `at` is a commit; without a push, an `after` naming another commit than `at`'s is a `TypeError`. An `at` that is neither a commit nor a branch name by [git's rules](https://git-scm.com/docs/git-check-ref-format) (no `..`, `@{`, space, control character, `~`, `^`, `:`, `?`, `*`, `[` or `\`; no part empty, starting with a dot or ending in `.lock`; not ending with a dot, not starting with a dash, neither `@` nor `HEAD`), and an `at` beside other than one repository in `list`, throw a `TypeError` before any request. A tag or a short commit is followed by the commit `resolveRef` settles it to.

A selection's `path` narrows `list` and `changesSince` to a folder of one repository, or to the one file it names, by its path with no leading or trailing slash (`resolveRef`'s `path`; `''` or none for the whole repository). The files at the path or under it are kept before `maxFiles` counts them, so a folder's files are listed and compared whatever sorts before them: over the whole repository, 2,000 documents whose paths sort before `docs/` fill the count, and the folder's files are left out of the listing and answered gone by `changesSince`. A `/tree/` address that names a file lists that file, as github.com shows it. `changesSince` narrows a `listing` handed in to the path, and compares a cursor under the path it was answered under: a path in it outside the one given is answered gone.

`parseGitHubLink(text)` reads the GitHub address a person pastes, without a request:

| Address | Answered as |
| --- | --- |
| `github.com/<owner>/<repo>`, with or without `.git`; `git@github.com:<owner>/<repo>.git` | `{ kind: 'github_repository', owner, repo }` |
| `github.com/<owner>/<repo>/tree/<ref>/<path>`, and `/blob/<ref>` with no path, which GitHub shows as the folder | `{ kind: 'github_folder', owner, repo, refAndPath }` |
| `github.com/<owner>/<repo>/blob/<ref>/<path>` and `/raw/<ref>/<path>`; `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>` | `{ kind: 'github_file', owner, repo, refAndPath, raw }`, `raw` true for the two raw forms |
| Any other address on `github.com`, `www.github.com`, `gist.github.com`, `api.github.com`, `codeload.github.com`, `uploads.github.com` or a host under `githubusercontent.com`: an account, an issue, a pull request, a wiki, a release, a commit, a tag by its full name (`refs/tags/<tag>`), a gist, GitHub's own pages, an address that carries credentials, with a scheme or without one (`<user>:<password>@github.com/...`, which a browser opens as an `https://` address); and any address on `ghe.com` or a host under it, where GitHub Enterprise Cloud with data residency serves an enterprise ([GitHub's docs](https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency)) | `{ kind: 'refused' }` |
| An address on any other host, an opaque address such as `mailto:someone@github.com`, and text that is no address | `null` |

The scheme, or its absence, a port, the dots that end a host (`github.com.`, `github.com..`), a trailing slash, a query and a fragment are ignored; `www.github.com` is read as `github.com`, and GitHub's form of a branch by its full name, `refs/heads/<branch>`, as the branch. The text is read as the [URL standard](https://url.spec.whatwg.org/#concept-basic-url-parser) reads an address, as a browser opens it: the C0 controls and spaces around it (and any other white space there) are dropped, and every tab and newline in it; after `http`, `https`, `ws`, `wss` and `ftp` any run of `/` and `\` stands before the host, none included ([special authority slashes](https://url.spec.whatwg.org/#special-authority-slashes-state)), so `https:github.com/acme-team/handbook`, `https:/github.com/...` and `https:\\github.com\acme-team\handbook` read as `https://github.com/acme-team/handbook`; after `file` two of them, and a third leaves the host [empty](https://url.spec.whatwg.org/#file-host-state), so `file:///github.com/acme-team/handbook` names no host (`null`); after any other scheme (`git://`, `ssh://`) `//`, and without it such a scheme names no host (`null`). A backslash in the path is a slash. Each segment is decoded, and an address whose path has an empty segment, an escape that does not decode, or a `.` or `..` segment or a control character once decoded is refused.

A folder's and a file's ref and path are one text, `refAndPath`, since a branch or a tag name may hold a slash. `connector.resolveRef(repositoryId, refAndPath)` settles it as `{ ref, path, commit, kind, name }`: `kind` is `branch`, `tag` or `commit`, `name` the ref as the link writes it, `ref` what `list`, `head` and `changesSince` take as `at`, and `path` the rest (`''` for the ref's root). A first segment of 40 hexadecimal characters is a commit (`commit: true`, in lower case) and `HEAD` the default branch, with no request. Otherwise GitHub's [matching references](https://docs.github.com/en/rest/git/refs#list-matching-references), which answer every reference whose name starts with that segment, are read in turn: the branches and the tags, where the longest name of either that is the text or starts it at a slash is the ref, a tag answered at the commit it names (`commit: true`; an annotated tag's object is [read](https://docs.github.com/en/rest/git/tags#get-a-tag) for it), as github.com serves `/tree/<tag>/`, and the tags not read when a branch's name is the whole text; then, for a first segment of 4 to 39 hexadecimal characters, the short commit through GitHub's [commits](https://docs.github.com/en/rest/commits/commits#get-a-commit) under the `application/vnd.github.sha` media type, which answers the whole commit, or 422 for a prefix no commit has or several have. A branch and a tag of one name settle as the branch. Git keeps no branch beside one under its name (`release` beside `release/1.0`), so at most one such branch exists, but it keeps a tag under a branch's name beside the branch, and the tag `release/2.0` beside the branch `release` settles `release/2.0/docs` as the tag. A first segment none of them settles is answered as a branch all the same, and a listing at it throws GitHub's 404 as `GitHubApiError`; so does 409 for a repository with no commit. A first segment no ref name can begin (a control character, a space, `~`, `^`, `:`, `?`, `*`, `[`, `\`, `..` or `@{`, a leading dot, a trailing `.lock`) is a `TypeError` before any request, and one that is no branch name and none of them settles (`-x`, `@`, `end.`) a `TypeError` after the reads. A `/blob/` address whose text has no slash (`/blob/main`) names its ref alone and is answered as the folder, since GitHub redirects it to `/tree/main`; one whose text has a slash is a file, and when `resolveRef` settles the whole text as the ref (`/blob/release/1.0` in a repository with a `release/1.0` branch), the path is `''`: the address names a ref and no file, which GitHub answers 404.

```ts
import { parseGitHubLink } from '@framers/agentos-ext-github/documents';

const link = parseGitHubLink('https://github.com/acme-team/handbook/tree/release/1.0/docs');
if (link?.kind === 'github_folder') {
  // repositoryId: the linked repository whose full name is `${link.owner}/${link.repo}`.
  const { ref, path, kind } = await connector.resolveRef(repositoryId, link.refAndPath); // 'release/1.0', 'docs', 'branch'
  // The folder's files, kept before maxFiles counts them; a path that names a file lists that file.
  const { items } = await connector.list({ ids: [String(repositoryId)], at: ref, path });
  // A branch's push is compared within the same folder, with the cursor answered under that path.
  const changes = await connector.changesSince(cursor, { ids: [String(repositoryId)], at: ref, path, ref: push.ref, after: push.after });
}
```

`planTree(blobs, options)` answers every file of a tree (`readTree`'s blobs) in path order, each a new object with its `path`, `sha`, `size` and `outcome`: `'note'`, or `{ skipped }` with the first reason the file is left out. `folder` under a skipped folder; `kind` for a file that is neither documentation, code nor an image (data, configuration, a binary, a file with no extension); `image` for `IMAGE_EXTENSIONS`, or the `imageExtensions` given; `code` for code while `includeCode` is off; `generated` for code a tool wrote while `includeCode` is on; `size` past `maxFileBytes`, or past `maxCodeBytes` for a file of a code extension while `includeCode` is on, whatever `extensions` names (`maxFileBytes` when absent, a non-negative integer, else a `TypeError`); `count` past `maxFiles`, the documentation keeping its places first and the code taking the room left. The notes are exactly what `pathFilter` keeps under the same filter, a code file past `maxCodeBytes` aside, so a caller can show what is left out and why from one listing, and turn code on or off without reading the tree again. An extension the filter's `extensions` names is documentation, an image's included. With `path`, only the files at that folder or under it, or the one file it names, are planned and counted, as `list` keeps them under the same `path`: a folder link's plan counts the folder's files alone.

## License

Apache-2.0
