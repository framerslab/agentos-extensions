# GitHub

This pack gives an agent tools for repository search, issues, pull requests, files, branches, commits, releases, workflow dispatch, gists, and repository indexing. It uses the GitHub API through `@octokit/rest`.

## Installation

```bash
npm install @framers/agentos-ext-github
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-github';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN },
  logger: console,
}));
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

## License

Apache-2.0
