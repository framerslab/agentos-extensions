/**
 * @fileoverview Calls made on a person's own token, the user access token a GitHub App's web flow answers: the open
 * issues assigned to the person in the repositories a caller names, the repositories the person may open an issue in,
 * an issue opened and an issue closed. Each function takes the token it is given, sends it as the call's bearer and
 * holds none; each takes `{ fetchImpl, apiBase, timeoutMs }` last, `fetch`, GitHub's API and a 30-second deadline a
 * request when absent. A 401 throws `GitHubGrantGoneError`, a secondary rate limit `GitHubSecondaryLimitError`, any
 * other refusal `GitHubApiError` and a call without an answer `GitHubNoAnswer`; none of them holds the token, an
 * address or anything of GitHub's answer.
 * @module agentos-ext-github/app/userIssues
 */

import { personRefusal } from './errors.js';
import { arrayOf, discardBody, GITHUB_API_BASE, githubFetch, githubSend, numberIn, objectOf, pages, stringIn, type GitHubApiOptions, type GitHubRequest } from './http.js';

/** An open issue assigned to the person. */
export interface AssignedIssue {
  /** The repository it is in, `owner/name`, as the caller wrote it. */
  repository: string;
  /** The issue's number in its repository. */
  number: number;
  /** The issue's title. */
  title: string;
  /** The issue's page on GitHub (`html_url`). */
  url: string;
  /** When the issue last changed (`updated_at`, an ISO 8601 time). */
  updatedAt: string;
}

/** Which repositories to ask for the person's issues, and how many of each. */
export interface ListAssignedIssuesInput {
  /** The repositories to ask, each `owner/name`. No other repository is asked. */
  repositories: readonly string[];
  /** How many issues and pull requests to ask a repository for, from 1 to 100; 100 when absent. */
  perPage?: number;
}

/** A repository the person may open an issue in. */
export interface IssueTarget {
  /** The repository, `owner/name` (`full_name`). */
  repository: string;
  /** True for a private repository, where only the people with access to it can read an issue. */
  private: boolean;
}

/** The issue to open. */
export interface CreateIssueInput {
  /** The repository to open it in, `owner/name`. */
  repository: string;
  /** The issue's title, sent as it is. */
  title: string;
  /** The issue's body, sent as it is. */
  body: string;
}

/** An issue as opened. */
export interface CreatedIssue {
  /** The issue's number in its repository. */
  number: number;
  /** The issue's page on GitHub (`html_url`). */
  url: string;
}

/** The issue to close. */
export interface CloseIssueInput {
  /** The repository it is in, `owner/name`. */
  repository: string;
  /** The issue's number in its repository. */
  number: number;
}

/** The most items GitHub answers on a page (`per_page`). */
const MAX_PER_PAGE = 100;

/**
 * A repository written `owner/name`: two parts of letters, digits, `-` and `_`, the name's with `.` as well. The check
 * is this module's own, stricter than an address needs: a name is put into a request's address as it is, so one
 * holding `/`, `?`, `#`, a space or a `..` part would ask GitHub for something else.
 */
const REPOSITORY_NAME = /^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/;

/**
 * The address of a repository under the REST API, `<apiBase>/repos/<owner>/<name>`.
 *
 * @throws TypeError when `repository` is not written `owner/name`, before any request.
 */
function repositoryAddress(apiBase: string, repository: string): string {
  if (typeof repository !== 'string' || !REPOSITORY_NAME.test(repository) || /\/\.{1,2}$/.test(repository)) {
    throw new TypeError('a repository is written owner/name');
  }
  return `${apiBase}/repos/${repository}`;
}

/**
 * Refuses a token that is not a string or is empty or blank, before any request. GitHub answers such a bearer with
 * 401, which a call on the person's token reads as `GitHubGrantGoneError`; a missing token is the caller's own fault,
 * never the person's revocation.
 *
 * @throws TypeError for a token that is not a string or holds nothing but whitespace.
 */
function requireToken(token: string): void {
  if (typeof token !== 'string' || token.trim() === '') throw new TypeError("a call on a person's token needs the token");
}

/** A call on the person's token: its bearer, its deadline, and its refusals thrown as the errors of a person's call. */
function personRequest(token: string, timeoutMs: number | undefined): GitHubRequest {
  return { token, timeoutMs, refusedAs: personRefusal };
}

/**
 * The open issues assigned to the token's person in the repositories given, and in no other.
 *
 * The person's login is read first (`GET /user`). Each repository is then asked for its open issues assigned to that
 * login (`GET /repos/{owner}/{repo}/issues` with `state=open` and `assignee`), most recently changed first, one page
 * of `perPage` items, and the pull requests on the page, which GitHub lists among the issues and marks with a
 * `pull_request` key, are left out (https://docs.github.com/en/rest/issues/issues#list-repository-issues). So a
 * repository answers at most `perPage` issues, fewer by the pull requests the page held. The repositories are asked
 * one at a time, in the order given, as GitHub asks of a client
 * (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests).
 * The token needs the app's Issues permission at read.
 *
 * A refusal ends the listing with its error and no repository is asked after it. GitHub answers 404 for a repository
 * the token does not reach, as it does for one that does not exist
 * (https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource),
 * so a caller whose list has gone stale checks it against {@link issueTargets}. No request is made for an empty list.
 *
 * @param token The person's user access token.
 * @param input The repositories to ask, and how many issues of each.
 * @param options Where calls go.
 * @throws TypeError before any request when the token is empty or blank, a repository is not written `owner/name` or
 * `perPage` is not a whole number from 1 to 100.
 */
export async function listAssignedIssues(
  token: string,
  input: ListAssignedIssuesInput,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<AssignedIssue[]> {
  requireToken(token);
  const perPage = input.perPage ?? MAX_PER_PAGE;
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > MAX_PER_PAGE) throw new TypeError('perPage is a whole number from 1 to 100');
  const asked = input.repositories.map((repository) => ({ repository, address: repositoryAddress(apiBase, repository) }));
  if (asked.length === 0) return [];
  const request = personRequest(token, timeoutMs);
  const login = stringIn(objectOf(await githubFetch(fetchImpl, `${apiBase}/user`, request), 'a user'), 'login', 'a user');
  const query = new URLSearchParams({ state: 'open', assignee: login, sort: 'updated', direction: 'desc', per_page: String(perPage) });
  const issues: AssignedIssue[] = [];
  for (const { repository, address } of asked) {
    for (const value of arrayOf(await githubFetch(fetchImpl, `${address}/issues?${query.toString()}`, request), 'a page of issues')) {
      const fields = objectOf(value, 'an issue');
      if ('pull_request' in fields) continue;
      issues.push({
        repository,
        number: numberIn(fields, 'number', 'an issue'),
        title: stringIn(fields, 'title', 'an issue'),
        url: stringIn(fields, 'html_url', 'an issue'),
        updatedAt: stringIn(fields, 'updated_at', 'an issue'),
      });
    }
  }
  return issues;
}

/** The objects under `key` of a page of a listing; `what` names the page in the error when it is not one. */
function itemsOf(page: unknown, key: string, what: string): Record<string, unknown>[] {
  return arrayOf(objectOf(page, what)[key], what).map((value) => objectOf(value, what));
}

/** True for an installation an issue can be opened through: it holds Issues at write and is not suspended. */
function takesIssues(installation: Record<string, unknown>): boolean {
  const permissions = installation.permissions;
  const issues = typeof permissions === 'object' && permissions !== null ? (permissions as Record<string, unknown>).issues : undefined;
  return issues === 'write' && typeof installation.suspended_at !== 'string';
}

/**
 * The repositories the token's person may open an issue in, each with whether it is private.
 *
 * A user access token reaches only what both the person and the app reach, which GitHub lists as the app's
 * installations the person can access and each one's repositories
 * (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app).
 * The installations are read across every page (`GET /user/installations`), then, one installation at a time, the
 * repositories of each that holds the Issues permission at write and is not suspended
 * (`GET /user/installations/{installation_id}/repositories`, across every page;
 * https://docs.github.com/en/rest/apps/installations). A repository is answered when its issues are on (`has_issues`)
 * and it is neither archived, which makes its issues read-only
 * (https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories), nor disabled
 * (`disabled`). Anyone with pull access to a repository can open an issue in it, and the listing holds only
 * repositories the person can access (https://docs.github.com/en/rest/issues/issues#create-an-issue).
 *
 * @param token The person's user access token.
 * @param options Where calls go.
 * @throws TypeError before any request when the token is empty or blank.
 */
export async function issueTargets(token: string, { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {}): Promise<IssueTarget[]> {
  requireToken(token);
  const request = personRequest(token, timeoutMs);
  const installations = await pages(fetchImpl, `${apiBase}/user/installations?per_page=${MAX_PER_PAGE}`, request, (page) =>
    itemsOf(page, 'installations', 'a page of installations'),
  );
  const targets: IssueTarget[] = [];
  for (const installation of installations.filter(takesIssues)) {
    const id = numberIn(installation, 'id', 'an installation');
    const repositories = await pages(fetchImpl, `${apiBase}/user/installations/${id}/repositories?per_page=${MAX_PER_PAGE}`, request, (page) =>
      itemsOf(page, 'repositories', 'a page of repositories'),
    );
    for (const repository of repositories) {
      if (repository.has_issues !== true || repository.archived === true || repository.disabled === true) continue;
      const isPrivate = repository.private;
      // Never guessed: a private repository answered as public, or the other way, would mislead whoever writes the issue.
      if (typeof isPrivate !== 'boolean') throw new Error('GitHub answered a repository without a boolean private');
      targets.push({ repository: stringIn(repository, 'full_name', 'a repository'), private: isPrivate });
    }
  }
  return targets;
}

/**
 * Opens an issue as the token's person (`POST /repos/{owner}/{repo}/issues`) with the title and the body as they are
 * given, and answers its number and its page. The token needs the app's Issues permission at write, and GitHub
 * answers 410 for a repository whose issues are off (https://docs.github.com/en/rest/issues/issues#create-an-issue).
 *
 * The request is sent once and never again, whatever comes of it: opening an issue triggers notifications, and a
 * second request would open a second issue. A call that ends with `GitHubNoAnswer` may have opened the issue all the
 * same, GitHub having taken the request before its answer was lost.
 *
 * @param token The person's user access token.
 * @param input The repository, the title and the body.
 * @param options Where calls go.
 * @throws TypeError before any request when the token is empty or blank or the repository is not written `owner/name`.
 */
export async function createIssueAsUser(
  token: string,
  input: CreateIssueInput,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<CreatedIssue> {
  requireToken(token);
  const address = repositoryAddress(apiBase, input.repository);
  const body = JSON.stringify({ title: input.title, body: input.body });
  const created = objectOf(await githubFetch(fetchImpl, `${address}/issues`, { ...personRequest(token, timeoutMs), method: 'POST', body }), 'an issue');
  return { number: numberIn(created, 'number', 'an issue'), url: stringIn(created, 'html_url', 'an issue') };
}

/**
 * Closes an issue as the token's person: `PATCH /repos/{owner}/{repo}/issues/{issue_number}` with `state: closed`
 * and nothing else, no `state_reason` among it. The issue's owner and people with push access or the Triage role can
 * edit an issue, and the token needs the app's Issues permission, or its Pull requests permission, at write
 * (https://docs.github.com/en/rest/issues/issues#update-an-issue). GitHub's REST API counts every pull request as an
 * issue, so a pull request's number closes the pull request: the number is taken as given. Resolves once GitHub
 * answers a success; the issue it answers is not read.
 *
 * @param token The person's user access token.
 * @param input The repository and the issue's number.
 * @param options Where calls go.
 * @throws TypeError before any request when the token is empty or blank, the repository is not written `owner/name`
 * or the number is not a positive integer.
 */
export async function closeIssueAsUser(
  token: string,
  input: CloseIssueInput,
  { fetchImpl = fetch, apiBase = GITHUB_API_BASE, timeoutMs }: GitHubApiOptions = {},
): Promise<void> {
  requireToken(token);
  const address = repositoryAddress(apiBase, input.repository);
  if (!Number.isSafeInteger(input.number) || input.number <= 0) throw new TypeError('an issue number is a positive integer');
  const answer = await githubSend(fetchImpl, `${address}/issues/${input.number}`, {
    ...personRequest(token, timeoutMs),
    method: 'PATCH',
    body: JSON.stringify({ state: 'closed' }),
  });
  // The status is the whole answer: the issue GitHub sends back is let go unread.
  discardBody(answer.response);
}
