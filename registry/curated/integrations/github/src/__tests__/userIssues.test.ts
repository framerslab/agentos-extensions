/**
 * @fileoverview The calls made on a person's own token, against GitHub on the loopback address (`githubStandIn.ts`):
 * the open issues assigned to the person in the repositories given, the repositories the person may open an issue in,
 * an issue opened, an issue closed, and what each call throws for a secondary rate limit and for a token GitHub no
 * longer takes. The rules written beside the tests are GitHub's, each with the page it was read on (10 November 2026);
 * a rule no page states is marked UNVERIFIED.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeIssueAsUser,
  createIssueAsUser,
  GitHubApiError,
  GitHubGrantGoneError,
  GitHubNoAnswer,
  GitHubSecondaryLimitError,
  issueTargets,
  listAssignedIssues,
  type AssignedIssue,
  type CreatedIssue,
  type IssueTarget,
} from '../documents/index.js';
import { occurrences, pause, startGitHub, watchOutput, wholeRequest, type Answer, type GitHubStandIn, type OutputWatch, type Received } from './githubStandIn.js';

/** The person's token: a made-up value in the form of a GitHub App user access token (`ghu_`). */
const TOKEN = 'ghu_madeUpPersonTokenForTheIssueTests';

/** An issue as GitHub's REST API answers one, cut to the fields that matter here and a few that must be ignored. */
function issue(repository: string, number: number, title: string, updatedAt: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9_000_000 + number,
    number,
    title,
    state: 'open',
    url: `https://api.github.com/repos/${repository}/issues/${number}`,
    html_url: `https://github.com/${repository}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${repository}`,
    updated_at: updatedAt,
    body: 'The body of an issue is never answered by the listing.',
    assignees: [{ login: 'test-person', id: 501 }],
    ...more,
  };
}

/** A repository as `GET /user/installations/{installation_id}/repositories` answers one, cut to what is read. */
function repository(id: number, fullName: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, full_name: fullName, private: false, has_issues: true, archived: false, disabled: false, default_branch: 'main', permissions: { admin: false, push: false, pull: true }, ...more };
}

/** The headers every call on a person's token carries, and the one credential among them. */
function expectPersonCall(request: Received, token: string): void {
  expect(request.headers.authorization).toBe(`Bearer ${token}`);
  expect(request.headers.accept).toBe('application/vnd.github+json');
  expect(request.headers['x-github-api-version']).toBe('2026-03-10');
  expect(request.headers['user-agent']).toBe('agentos-ext-github');
  expect(request.headers.cookie).toBeUndefined();
  expect(request.headers['proxy-authorization']).toBeUndefined();
  // The token sits in the Authorization header and nowhere else: not in the address, not in the body.
  expect(occurrences(wholeRequest(request), token)).toBe(1);
}

let github: GitHubStandIn | undefined;
let output: OutputWatch;

beforeEach(() => {
  output = watchOutput();
});

afterEach(async () => {
  vi.useRealTimers();
  await github?.close();
  github = undefined;
  const printed = output.printed();
  output.restore();
  // No call writes the token it was given to a log, whatever GitHub answered.
  expect(printed).not.toContain('ghu_');
});

describe("the open issues assigned to a person", () => {
  /*
   * "List repository issues", https://docs.github.com/en/rest/issues/issues#list-repository-issues :
   *   - `GET /repos/{owner}/{repo}/issues`; `state` is `open`, `closed` or `all`, "Default: open".
   *   - `assignee`: "Can be the name of a user. Pass in none for issues with no assigned user, and * for issues
   *     assigned to any user." The person's name is their login, read from `GET /user`
   *     (https://docs.github.com/en/rest/users/users#get-the-authenticated-user).
   *   - `per_page`: "The number of results per page (max 100)", default 30; `sort` is `created`, `updated` or
   *     `comments`; `direction` is `asc` or `desc`.
   *   - "GitHub's REST API considers every pull request an issue ... You can identify pull requests by the
   *     pull_request key."
   *   - The call works with "GitHub App user access tokens" holding '"Issues" repository permissions (read)'.
   * "To avoid exceeding secondary rate limits, you should make requests serially instead of concurrently."
   *   https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#avoid-concurrent-requests
   */
  it('asks GitHub who the person is, then only the repositories given, one at a time, and answers their open issues assigned to the person without the pull requests', async () => {
    github = await startGitHub(async (request) => {
      if (request.path === '/user') return { status: 200, body: { login: 'test-person', id: 501, type: 'User' } };
      // Held back, so two repositories asked at once would be answered at once.
      await pause(25);
      if (request.path === '/repos/acme-team/planner/issues') {
        return {
          status: 200,
          body: [
            issue('acme-team/planner', 42, 'Write the agenda for Thursday', '2026-11-09T16:20:00Z'),
            issue('acme-team/planner', 57, 'Review "Q4" numbers & send <the> summary', '2026-11-08T09:05:11Z'),
            // A pull request assigned to the person comes back from the same listing, marked by its pull_request key.
            issue('acme-team/planner', 58, 'Bump the parser', '2026-11-07T10:00:00Z', { pull_request: { url: 'https://api.github.com/repos/acme-team/planner/pulls/58' } }),
          ],
        };
      }
      if (request.path === '/repos/acme-team/handbook/issues') {
        return { status: 200, body: [issue('acme-team/handbook', 7, 'Update the onboarding page', '2026-11-01T08:00:00Z')] };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });

    const issues: AssignedIssue[] = await listAssignedIssues(TOKEN, { repositories: ['acme-team/planner', 'acme-team/handbook'] }, { apiBase: github.base });

    expect(issues).toEqual([
      { repository: 'acme-team/planner', number: 42, title: 'Write the agenda for Thursday', url: 'https://github.com/acme-team/planner/issues/42', updatedAt: '2026-11-09T16:20:00Z' },
      { repository: 'acme-team/planner', number: 57, title: 'Review "Q4" numbers & send <the> summary', url: 'https://github.com/acme-team/planner/issues/57', updatedAt: '2026-11-08T09:05:11Z' },
      { repository: 'acme-team/handbook', number: 7, title: 'Update the onboarding page', url: 'https://github.com/acme-team/handbook/issues/7', updatedAt: '2026-11-01T08:00:00Z' },
    ]);

    // The person, then the two repositories given, in the order given, and nothing else: no listing across every
    // repository the person can see (`GET /issues`), no other repository.
    expect(github.received.map((request) => `${request.method} ${request.path}`)).toEqual([
      'GET /user',
      'GET /repos/acme-team/planner/issues',
      'GET /repos/acme-team/handbook/issues',
    ]);
    expect(github.peak()).toBe(1);
    for (const request of github.received) expectPersonCall(request, TOKEN);
    for (const request of github.received.slice(1)) {
      expect(Object.fromEntries(request.query)).toEqual({ state: 'open', assignee: 'test-person', sort: 'updated', direction: 'desc', per_page: '100' });
      expect(request.body).toBe('');
    }
  });

  it('asks for the issues a repository given per page, and refuses a number outside 1 to 100 before any request', async () => {
    github = await startGitHub((request) => (request.path === '/user' ? { status: 200, body: { login: 'test-person', id: 501 } } : { status: 200, body: [] }));
    const at = { apiBase: github.base };

    await expect(listAssignedIssues(TOKEN, { repositories: ['acme-team/planner'], perPage: 25 }, at)).resolves.toEqual([]);
    expect(github.received.map((request) => request.path)).toEqual(['/user', '/repos/acme-team/planner/issues']);
    expect(github.received[1].query.get('per_page')).toBe('25');

    for (const perPage of [0, 101, -1, 2.5, Number.NaN]) {
      await expect(listAssignedIssues(TOKEN, { repositories: ['acme-team/planner'], perPage }, at)).rejects.toBeInstanceOf(TypeError);
    }
    expect(github.received).toHaveLength(2);
  });

  /*
   * "For most endpoints, the maximum value of per_page is 100." A listing past one page carries a `link` header, and
   * "The URL for the next page is followed by rel="next"."
   *   https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api
   * The call reads one page a repository and never follows that link, so a repository answers at most 100 issues.
   */
  it('reads one page a repository, at most 100 issues, and never asks for the page its `link` header names next', async () => {
    github = await startGitHub((request, base) => {
      if (request.path === '/user') return { status: 200, body: { login: 'test-person', id: 501 } };
      if (request.path === '/repos/acme-team/planner/issues') {
        const page = `${base}/repos/acme-team/planner/issues?state=open&assignee=test-person&per_page=100&page=`;
        return {
          status: 200,
          headers: { link: `<${page}2>; rel="next", <${page}3>; rel="last"` },
          body: Array.from({ length: 100 }, (_, index) => issue('acme-team/planner', index + 1, `Issue ${index + 1}`, '2026-11-09T16:20:00Z')),
        };
      }
      if (request.path === '/repos/acme-team/handbook/issues') {
        return { status: 200, body: [issue('acme-team/handbook', 7, 'Update the onboarding page', '2026-11-01T08:00:00Z')] };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });

    const issues = await listAssignedIssues(TOKEN, { repositories: ['acme-team/planner', 'acme-team/handbook'] }, { apiBase: github.base });

    expect(issues.filter((found) => found.repository === 'acme-team/planner')).toHaveLength(100);
    expect(issues[99]).toEqual({ repository: 'acme-team/planner', number: 100, title: 'Issue 100', url: 'https://github.com/acme-team/planner/issues/100', updatedAt: '2026-11-09T16:20:00Z' });
    expect(issues[100]).toEqual({ repository: 'acme-team/handbook', number: 7, title: 'Update the onboarding page', url: 'https://github.com/acme-team/handbook/issues/7', updatedAt: '2026-11-01T08:00:00Z' });
    // The person, then one page of each repository given: no `page` asked, and the next page left unread.
    expect(github.received.map((request) => request.path)).toEqual(['/user', '/repos/acme-team/planner/issues', '/repos/acme-team/handbook/issues']);
    for (const request of github.received.slice(1)) {
      expect(request.query.get('per_page')).toBe('100');
      expect(request.query.has('page')).toBe(false);
    }
  });

  it('refuses a repository that is not written `owner/name` before any request, so no text of it becomes part of an address', async () => {
    github = await startGitHub(() => ({ status: 200, body: [] }));
    const at = { apiBase: github.base };

    const malformed = ['acme-team', 'acme-team/planner/issues', 'acme-team/', '/planner', 'acme-team/..', '../planner', 'acme team/planner', 'acme-team/planner?state=all', 'acme-team/planner#top', 'acme-team\\planner', ''];
    for (const name of malformed) {
      await expect(listAssignedIssues(TOKEN, { repositories: ['acme-team/planner', name] }, at)).rejects.toBeInstanceOf(TypeError);
      await expect(createIssueAsUser(TOKEN, { repository: name, title: 'A title', body: 'A body' }, at)).rejects.toBeInstanceOf(TypeError);
      await expect(closeIssueAsUser(TOKEN, { repository: name, number: 1 }, at)).rejects.toBeInstanceOf(TypeError);
    }
    expect(github.received).toHaveLength(0);
  });

  it('answers no issue and makes no request when no repository is given', async () => {
    github = await startGitHub(() => ({ status: 200, body: [] }));

    await expect(listAssignedIssues(TOKEN, { repositories: [] }, { apiBase: github.base })).resolves.toEqual([]);
    expect(github.received).toHaveLength(0);
  });

  /*
   * "List repository issues" answers 404, "Resource not found", for a repository the token does not reach
   * (https://docs.github.com/en/rest/issues/issues#list-repository-issues), and GitHub answers 404 in place of 403 "to
   * avoid confirming the existence of private repositories"
   * (https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#404-not-found-for-an-existing-resource).
   */
  it("ends the listing with GitHub's refusal when it refuses one repository, asking for none after it", async () => {
    github = await startGitHub((request) => {
      if (request.path === '/user') return { status: 200, body: { login: 'test-person', id: 501 } };
      if (request.path === '/repos/acme-team/planner/issues') return { status: 200, body: [issue('acme-team/planner', 42, 'Write the agenda', '2026-11-09T16:20:00Z')] };
      return { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest/issues/issues#list-repository-issues' } };
    });

    const refused: unknown = await listAssignedIssues(TOKEN, { repositories: ['acme-team/planner', 'acme-team/left', 'acme-team/handbook'] }, { apiBase: github.base }).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(GitHubApiError);
    expect(refused).toMatchObject({ status: 404, rateLimited: false });
    expect((refused as Error).message).toBe('GitHub answered 404');
    expect(github.received.map((request) => request.path)).toEqual(['/user', '/repos/acme-team/planner/issues', '/repos/acme-team/left/issues']);
  });
});

describe('the repositories a person may open an issue in', () => {
  /*
   * "A GitHub App user access token only has permissions that both the user and the app have", and "a user access
   * token can only access resources that both the user and app can access ... see `GET /user/installations` and
   * `GET /user/installations/{installation_id}/repositories`".
   *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
   * `GET /user/installations`: "You can find the permissions for the installation under the permissions key"; each
   * installation carries `permissions` (`issues`: `read` or `write`) and `suspended_at`.
   * `GET /user/installations/{installation_id}/repositories`: each repository carries `full_name`, `private`,
   * `has_issues`, `archived` and `disabled`. Both listings take `per_page` (max 100) and page through `Link`.
   *   https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token
   *   https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token
   * "Create an issue" needs '"Issues" repository permissions (write)'; "Any user with pull access to a repository can
   * create an issue. If issues are disabled in the repository, the API returns a 410 Gone status."
   *   https://docs.github.com/en/rest/issues/issues#create-an-issue
   * "When a repository is archived, its issues, pull requests, ... become read-only."
   *   https://docs.github.com/en/repositories/archiving-a-github-repository/archiving-repositories
   * A suspension "blocks the app from accessing the account's resources. When a GitHub App is suspended, the app's
   * access to the GitHub API or webhook events is blocked for that account."
   *   https://docs.github.com/en/rest/apps/apps#suspend-an-app-installation
   * UNVERIFIED: no page read says in one sentence that a person's token is refused in a suspended installation. It
   * follows from the two rules above (the token reaches only what the app reaches, and a suspended app reaches
   * nothing of the account), so a suspended installation's repositories are left out.
   */
  it('answers the repositories of the installations that hold Issues at write, with whether each is private, leaving out those with issues off, archived or disabled', async () => {
    github = await startGitHub((request, base) => {
      if (request.path === '/user/installations' && request.query.get('page') === '2') {
        return {
          status: 200,
          body: {
            total_count: 4,
            installations: [
              { id: 13, account: { login: 'paused-team', id: 903 }, permissions: { issues: 'write', metadata: 'read' }, suspended_at: '2026-10-30T12:00:00Z' },
              { id: 14, account: { login: 'second-team', id: 904 }, permissions: { issues: 'write', metadata: 'read' }, suspended_at: null },
            ],
          },
        };
      }
      if (request.path === '/user/installations') {
        return {
          status: 200,
          headers: { link: `<${base}/user/installations?per_page=100&page=2>; rel="next", <${base}/user/installations?per_page=100&page=2>; rel="last"` },
          body: {
            total_count: 4,
            installations: [
              { id: 11, account: { login: 'acme-team', id: 901 }, permissions: { issues: 'write', metadata: 'read' }, suspended_at: null },
              // Installed before the app asked for Issues at write, and not approved since: it reads issues alone.
              { id: 12, account: { login: 'read-team', id: 902 }, permissions: { issues: 'read', metadata: 'read' }, suspended_at: null },
            ],
          },
        };
      }
      if (request.path === '/user/installations/11/repositories') {
        return {
          status: 200,
          body: {
            total_count: 5,
            repositories: [
              repository(71, 'acme-team/planner', { private: true }),
              repository(72, 'acme-team/handbook'),
              repository(73, 'acme-team/site', { has_issues: false }),
              repository(74, 'acme-team/old-app', { archived: true }),
              repository(75, 'acme-team/blocked', { disabled: true }),
            ],
          },
        };
      }
      if (request.path === '/user/installations/14/repositories' && request.query.get('page') === '2') {
        return { status: 200, body: { total_count: 2, repositories: [repository(82, 'second-team/notes', { private: true })] } };
      }
      if (request.path === '/user/installations/14/repositories') {
        return {
          status: 200,
          headers: { link: `<${base}/user/installations/14/repositories?per_page=100&page=2>; rel="next"` },
          body: { total_count: 2, repositories: [repository(81, 'second-team/site')] },
        };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });

    const targets: IssueTarget[] = await issueTargets(TOKEN, { apiBase: github.base });

    expect(targets).toEqual([
      { repository: 'acme-team/planner', private: true },
      { repository: 'acme-team/handbook', private: false },
      { repository: 'second-team/site', private: false },
      { repository: 'second-team/notes', private: true },
    ]);
    // The installations across their pages, then the repositories of the two that can take an issue, across theirs.
    expect(github.received.map((request) => `${request.path}?page=${request.query.get('page') ?? '1'}`)).toEqual([
      '/user/installations?page=1',
      '/user/installations?page=2',
      '/user/installations/11/repositories?page=1',
      '/user/installations/14/repositories?page=1',
      '/user/installations/14/repositories?page=2',
    ]);
    expect(github.received[0].query.get('per_page')).toBe('100');
    expect(github.received[2].query.get('per_page')).toBe('100');
    expect(github.peak()).toBe(1);
    for (const request of github.received) expectPersonCall(request, TOKEN);
  });
});

describe('an issue opened and an issue closed as the person', () => {
  /*
   * "Create an issue", https://docs.github.com/en/rest/issues/issues#create-an-issue :
   *   - `POST /repos/{owner}/{repo}/issues` with `title` (required) and `body`; it answers 201 with the issue, whose
   *     `number` and `html_url` are required fields.
   *   - "This endpoint triggers notifications. Creating content too quickly using this endpoint may result in
   *     secondary rate limiting."
   *   - The call works with "GitHub App user access tokens" holding '"Issues" repository permissions (write)'.
   */
  it('opens one issue with the title and the body as they were given, in one request, and answers its number and its page', async () => {
    github = await startGitHub((request) => {
      if (request.method === 'POST' && request.path === '/repos/acme-team/planner/issues') {
        return {
          status: 201,
          headers: { location: 'https://api.github.com/repos/acme-team/planner/issues/91' },
          body: issue('acme-team/planner', 91, 'as created', '2026-11-10T20:00:00Z'),
        };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });
    // Text that a careless caller would change: quotes, markup, an emoji, line breaks, spaces at both ends.
    const title = '  Follow up: "Q4 plan" <draft> & budget 📌 ';
    const body = 'Said at 14:02.\n\n> "We ship on Friday."\r\n\n- [ ] Book the room\n\n<!-- kept as written -->\n';

    const created: CreatedIssue = await createIssueAsUser(TOKEN, { repository: 'acme-team/planner', title, body }, { apiBase: github.base });

    expect(created).toEqual({ number: 91, url: 'https://github.com/acme-team/planner/issues/91' });
    expect(github.received).toHaveLength(1);
    const [request] = github.received;
    expect(`${request.method} ${request.target}`).toBe('POST /repos/acme-team/planner/issues');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({ title, body });
    expectPersonCall(request, TOKEN);
  });

  it('never opens an issue twice: a refused or unanswered request is not sent again', async () => {
    // The repository `acme-team/silent` is never answered; any other gets 503.
    github = await startGitHub((request) => (request.path === '/repos/acme-team/silent/issues' ? 'hang' : { status: 503, body: { message: 'Service Unavailable' } }));
    const at = { apiBase: github.base };

    const unavailable: unknown = await createIssueAsUser(TOKEN, { repository: 'acme-team/planner', title: 'A title', body: 'A body' }, at).catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(GitHubApiError);
    expect(unavailable).toMatchObject({ status: 503 });
    expect(github.received).toHaveLength(1);

    const unanswered: unknown = await createIssueAsUser(TOKEN, { repository: 'acme-team/silent', title: 'A title', body: 'A body' }, { ...at, timeoutMs: 80 }).catch((error: unknown) => error);
    expect(unanswered).toBeInstanceOf(GitHubNoAnswer);
    expect(unanswered).toMatchObject({ reason: 'timeout' });
    expect(github.received).toHaveLength(2);
  });

  /*
   * "Update an issue", https://docs.github.com/en/rest/issues/issues#update-an-issue :
   *   - `PATCH /repos/{owner}/{repo}/issues/{issue_number}`; `state`: "The open or closed state of the issue. Can be
   *     one of: open, closed"; it answers 200.
   *   - "Issue owners and users with push access or Triage role can edit an issue."
   *   - The call works with "GitHub App user access tokens" holding '"Issues" repository permissions (write)' or
   *     '"Pull requests" repository permissions (write)'.
   */
  it('closes an issue with `state: closed` and nothing else, and refuses a number that is not a positive integer before any request', async () => {
    github = await startGitHub((request) => {
      if (request.method === 'PATCH' && request.path === '/repos/acme-team/planner/issues/91') {
        return { status: 200, body: issue('acme-team/planner', 91, 'as created', '2026-11-10T20:05:00Z', { state: 'closed', state_reason: 'completed' }) };
      }
      return { status: 404, body: { message: 'Not Found' } };
    });
    const at = { apiBase: github.base };

    await expect(closeIssueAsUser(TOKEN, { repository: 'acme-team/planner', number: 91 }, at)).resolves.toBeUndefined();

    expect(github.received).toHaveLength(1);
    const [request] = github.received;
    expect(`${request.method} ${request.target}`).toBe('PATCH /repos/acme-team/planner/issues/91');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body)).toEqual({ state: 'closed' });
    expectPersonCall(request, TOKEN);

    for (const number of [0, -3, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
      await expect(closeIssueAsUser(TOKEN, { repository: 'acme-team/planner', number }, at)).rejects.toBeInstanceOf(TypeError);
    }
    expect(github.received).toHaveLength(1);
  });
});

/** Each call on a person's token, made against the stand-in at `apiBase`. */
function everyCall(apiBase: string): [string, () => Promise<unknown>][] {
  const at = { apiBase };
  return [
    ['listAssignedIssues', () => listAssignedIssues(TOKEN, { repositories: ['acme-team/planner'] }, at)],
    ['issueTargets', () => issueTargets(TOKEN, at)],
    ['createIssueAsUser', () => createIssueAsUser(TOKEN, { repository: 'acme-team/planner', title: 'A title', body: 'A body' }, at)],
    ['closeIssueAsUser', () => closeIssueAsUser(TOKEN, { repository: 'acme-team/planner', number: 91 }, at)],
  ];
}

describe("GitHub's secondary rate limit on a person's call", () => {
  /*
   * "Exceeding the rate limit", https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit :
   *   - "If you exceed a secondary rate limit, you will receive a 403 or 429 response and an error message that
   *     indicates that you exceeded a secondary rate limit. If the retry-after response header is present, you should
   *     not retry your request until after that many seconds has elapsed. If the x-ratelimit-remaining header is 0,
   *     you should not retry your request until after the time, in UTC epoch seconds, specified by the
   *     x-ratelimit-reset header. Otherwise, wait for at least one minute before retrying."
   *   - "If you exceed your primary rate limit, you will receive a 403 or 429 response, and the x-ratelimit-remaining
   *     header will be 0. You should not retry your request until after the time specified by the x-ratelimit-reset
   *     header."
   * UNVERIFIED: the words of the secondary limit's message. The page says the message "indicates that you exceeded a
   * secondary rate limit" and does not quote it; the answers below use the words GitHub's API has sent, "You have
   * exceeded a secondary rate limit", and the calls read any message that names a secondary rate limit.
   */
  it("throws GitHubSecondaryLimitError with the header's seconds from every call", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'));
    const now = Date.now();
    github = await startGitHub(() => ({
      status: 403,
      headers: { 'retry-after': '30' },
      body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.', documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api#about-secondary-rate-limits' },
    }));

    for (const [name, call] of everyCall(github.base)) {
      const before = github.received.length;
      const limited: unknown = await call().catch((error: unknown) => error);

      expect(limited, name).toBeInstanceOf(GitHubSecondaryLimitError);
      // It is the pack's error of an answer outside 2xx as well, with the time to call again in epoch milliseconds.
      expect(limited, name).toBeInstanceOf(GitHubApiError);
      expect(limited, name).toMatchObject({ name: 'GitHubSecondaryLimitError', status: 403, retryAfterSeconds: 30, rateLimited: true, retryAt: now + 30_000 });
      // The message names the status and nothing of the answer.
      expect((limited as Error).message, name).toBe('GitHub answered 403');
      // The call stopped at the refusal: one request, and none sent again.
      expect(github.received.length - before, name).toBe(1);
    }
  });

  it('tells a secondary limit by its `retry-after` header or by its message, on a 403 and on a 429, and leaves the primary limit and another 403 as they were', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'));
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 1800;
    const secondary = { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' };
    const answers: Record<string, Answer> = {
      'acme-team/after-429': { status: 429, headers: { 'retry-after': '7' }, body: secondary },
      'acme-team/after-date': { status: 403, headers: { 'retry-after': new Date(now + 90_000).toUTCString() }, body: secondary },
      'acme-team/message-403': { status: 403, body: secondary },
      'acme-team/message-429': { status: 429, body: secondary },
      'acme-team/message-reset': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: secondary },
      'acme-team/primary': { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded for user ID 501.' } },
      'acme-team/primary-429': { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }, body: { message: 'API rate limit exceeded for user ID 501.' } },
      'acme-team/forbidden': { status: 403, body: { message: 'Resource not accessible by integration', documentation_url: 'https://docs.github.com/rest/issues/issues#create-an-issue' } },
      'acme-team/unavailable': { status: 503, headers: { 'retry-after': '120' }, body: { message: 'Service Unavailable' } },
    };
    github = await startGitHub((request) => answers[request.path.replace(/^\/repos\//, '').replace(/\/issues$/, '')] ?? { status: 404, body: { message: 'Not Found' } });
    const at = { apiBase: github.base };
    const refusalOf = async (name: string): Promise<unknown> => createIssueAsUser(TOKEN, { repository: `acme-team/${name}`, title: 'A title', body: 'A body' }, at).catch((error: unknown) => error);

    // The header's seconds, as delay-seconds or as the seconds left until its HTTP date.
    expect(await refusalOf('after-429')).toMatchObject({ name: 'GitHubSecondaryLimitError', status: 429, retryAfterSeconds: 7, retryAt: now + 7_000 });
    expect(await refusalOf('after-date')).toMatchObject({ name: 'GitHubSecondaryLimitError', status: 403, retryAfterSeconds: 90, retryAt: now + 90_000 });
    // No header: the message tells, there are no seconds to hand on, and GitHub's rule is a minute.
    expect(await refusalOf('message-403')).toMatchObject({ name: 'GitHubSecondaryLimitError', status: 403, retryAfterSeconds: null, retryAt: now + 60_000 });
    expect(await refusalOf('message-429')).toMatchObject({ name: 'GitHubSecondaryLimitError', status: 429, retryAfterSeconds: null, retryAt: now + 60_000 });
    // No header and a spent window: the message tells, and the wait is the window's reset.
    expect(await refusalOf('message-reset')).toMatchObject({ name: 'GitHubSecondaryLimitError', status: 403, retryAfterSeconds: null, retryAt: reset * 1000 });

    for (const name of ['primary', 'primary-429']) {
      const primary = await refusalOf(name);
      expect(primary, name).toBeInstanceOf(GitHubApiError);
      expect(primary, name).not.toBeInstanceOf(GitHubSecondaryLimitError);
      expect(primary, name).toMatchObject({ rateLimited: true, retryAt: reset * 1000 });
    }
    const forbidden = await refusalOf('forbidden');
    expect(forbidden).toBeInstanceOf(GitHubApiError);
    expect(forbidden).not.toBeInstanceOf(GitHubSecondaryLimitError);
    expect(forbidden).toMatchObject({ status: 403, rateLimited: false, retryAt: null });
    // `retry-after` on an answer that is neither 403 nor 429 is no rate limit.
    const unavailable = await refusalOf('unavailable');
    expect(unavailable).not.toBeInstanceOf(GitHubSecondaryLimitError);
    expect(unavailable).toMatchObject({ status: 503, rateLimited: false, retryAt: now + 120_000 });
  });
});

describe("a rate limit the headers name, whose message never arrives", () => {
  /*
   * "If you exceed your primary rate limit, you will receive a 403 or 429 response, and the x-ratelimit-remaining
   * header will be 0. You should not retry your request until after the time specified by the x-ratelimit-reset
   * header."
   *   https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-rate-limit
   * The headers alone say the call was refused for a rate limit and when it may be made again; the message would only
   * have told a secondary limit from the primary one. So a message that stalls or breaks while it is read leaves the
   * refusal told by its headers, never an answer that GitHub gave none. The first two tests hand the calls a fetch whose
   * bodies are streams (one that never ends, one that breaks after a few bytes); the last two send the same refusals
   * from the stand-in on the loopback address through the runtime's own fetch, the body held open or its connection
   * dropped after its first bytes.
   */
  it('answers a 403 or a 429 with `x-ratelimit-remaining: 0` as a rate limit with the reset time when its body stalls or breaks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'));
    const reset = Math.floor(Date.now() / 1000) + 1800;
    const stalled = (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const broken = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"message":"API rate'));
          controller.error(new Error('connection reset'));
        },
      });
    for (const status of [403, 429]) {
      for (const [kind, body] of [['stalled', stalled], ['broken', broken]] as const) {
        const fetchImpl = (async () =>
          new Response(body(), { status, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset), 'content-type': 'application/json' } })) as typeof fetch;
        const at = { apiBase: 'https://api.github.com', fetchImpl, timeoutMs: 80 };
        const calls: [string, () => Promise<unknown>][] = [
          ['listAssignedIssues', () => listAssignedIssues(TOKEN, { repositories: ['acme-team/planner'] }, at)],
          ['issueTargets', () => issueTargets(TOKEN, at)],
          ['createIssueAsUser', () => createIssueAsUser(TOKEN, { repository: 'acme-team/planner', title: 'A title', body: 'A body' }, at)],
          ['closeIssueAsUser', () => closeIssueAsUser(TOKEN, { repository: 'acme-team/planner', number: 91 }, at)],
        ];
        for (const [name, call] of calls) {
          const limited: unknown = await call().catch((error: unknown) => error);
          const what = `${name}, ${status}, ${kind}`;
          expect(limited, what).not.toBeInstanceOf(GitHubNoAnswer);
          expect(limited, what).toBeInstanceOf(GitHubApiError);
          expect(limited, what).not.toBeInstanceOf(GitHubSecondaryLimitError);
          expect(limited, what).toMatchObject({ status, rateLimited: true, retryAt: reset * 1000 });
        }
      }
    }
  });

  it('still ends with GitHubNoAnswer when a 403 whose headers name no rate limit stalls before its message', async () => {
    const fetchImpl = (async () => new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) }), { status: 403 })) as typeof fetch;
    const refused: unknown = await createIssueAsUser(TOKEN, { repository: 'acme-team/planner', title: 'A title', body: 'A body' }, { fetchImpl, timeoutMs: 80 }).catch(
      (error: unknown) => error,
    );
    // Without its message such a 403 could be a rate limit or a refused permission, so no refusal is guessed.
    expect(refused).toBeInstanceOf(GitHubNoAnswer);
    expect(refused).toMatchObject({ reason: 'timeout' });
  });

  /** Each call on the person's token under a deadline of `timeoutMs`, against `apiBase`. */
  function callsUnder(apiBase: string, timeoutMs: number): [string, () => Promise<unknown>][] {
    const at = { apiBase, timeoutMs };
    return [
      ['listAssignedIssues', () => listAssignedIssues(TOKEN, { repositories: ['acme-team/planner'] }, at)],
      ['issueTargets', () => issueTargets(TOKEN, at)],
      ['createIssueAsUser', () => createIssueAsUser(TOKEN, { repository: 'acme-team/planner', title: 'A title', body: 'A body' }, at)],
      ['closeIssueAsUser', () => closeIssueAsUser(TOKEN, { repository: 'acme-team/planner', number: 91 }, at)],
    ];
  }

  /** What the four calls ask the stand-in, in order: the person and then the repository for the listing. */
  const ASKED = ['GET /user', 'GET /repos/acme-team/planner/issues', 'GET /user/installations', 'POST /repos/acme-team/planner/issues', 'PATCH /repos/acme-team/planner/issues/91'];

  it('keeps the refusal its headers tell, over the loopback address, when its body stalls or its connection drops', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T20:00:00Z'));
    const now = Date.now();
    const reset = Math.floor(now / 1000) + 1800;
    const exhausted = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) };
    // A 429 is a rate limit by its status; with no `x-ratelimit-reset` to wait for, the page's rule is a minute on.
    const refusals: [string, number, Record<string, string>, number][] = [
      ['403, none remaining', 403, exhausted, reset * 1000],
      ['429, none remaining', 429, exhausted, reset * 1000],
      ['429 alone', 429, {}, now + 60_000],
    ];
    for (const [told, status, headers, retryAt] of refusals) {
      for (const cut of ['stall', 'drop'] as const) {
        github = await startGitHub((request) =>
          request.path === '/user'
            ? { status: 200, body: { login: 'test-person', id: 501 } }
            : { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: '{"message":"API rate', cut },
        );
        for (const [name, call] of callsUnder(github.base, 200)) {
          const limited: unknown = await call().catch((error: unknown) => error);
          const what = `${name}, ${told}, ${cut}`;
          expect(limited, what).not.toBeInstanceOf(GitHubNoAnswer);
          expect(limited, what).toBeInstanceOf(GitHubApiError);
          expect(limited, what).not.toBeInstanceOf(GitHubSecondaryLimitError);
          expect(limited, what).toMatchObject({ status, rateLimited: true, retryAt });
        }
        // Each refusal was GitHub's answer to the call's own request, sent once: no call asked again.
        expect(github.received.map((request) => `${request.method} ${request.path}`), `${told}, ${cut}`).toEqual(ASKED);
        await github.close();
        github = undefined;
      }
    }
  }, 30_000);

  it('still ends with GitHubNoAnswer, over the loopback address, when a 403 whose headers name no rate limit stalls or drops', async () => {
    for (const [cut, reason] of [
      ['stall', 'timeout'],
      ['drop', 'network'],
    ] as const) {
      github = await startGitHub((request) =>
        request.path === '/user'
          ? { status: 200, body: { login: 'test-person', id: 501 } }
          : { status: 403, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"message":"Resource not accessible', cut },
      );
      for (const [name, call] of callsUnder(github.base, 200)) {
        const refused: unknown = await call().catch((error: unknown) => error);
        expect(refused, `${name}, ${cut}`).toBeInstanceOf(GitHubNoAnswer);
        expect(refused, `${name}, ${cut}`).toMatchObject({ reason });
      }
      expect(github.received.map((request) => `${request.method} ${request.path}`), cut).toEqual(ASKED);
      await github.close();
      github = undefined;
    }
  }, 30_000);
});

describe('a call without a token', () => {
  /*
   * GitHub answers a request whose bearer is empty with 401, which these calls read as a grant gone. A missing token is
   * the caller's own fault, never the person's revocation, so it is refused before any request, as `revokeGrant` and
   * `refreshUserToken` refuse an empty token.
   */
  it('throws a TypeError before any request for an empty or blank token, never GitHubGrantGoneError', async () => {
    github = await startGitHub(() => ({ status: 401, body: { message: 'Bad credentials' } }));
    const at = { apiBase: github.base };
    for (const token of ['', '   ', undefined as unknown as string]) {
      const calls: [string, () => Promise<unknown>][] = [
        ['listAssignedIssues', () => listAssignedIssues(token, { repositories: ['acme-team/planner'] }, at)],
        ['listAssignedIssues of no repository', () => listAssignedIssues(token, { repositories: [] }, at)],
        ['issueTargets', () => issueTargets(token, at)],
        ['createIssueAsUser', () => createIssueAsUser(token, { repository: 'acme-team/planner', title: 'A title', body: 'A body' }, at)],
        ['closeIssueAsUser', () => closeIssueAsUser(token, { repository: 'acme-team/planner', number: 91 }, at)],
      ];
      for (const [name, call] of calls) {
        const refused: unknown = await call().catch((error: unknown) => error);
        expect(refused, `${name} ${JSON.stringify(token)}`).toBeInstanceOf(TypeError);
        expect(refused, `${name} ${JSON.stringify(token)}`).not.toBeInstanceOf(GitHubGrantGoneError);
      }
    }
    expect(github.received).toHaveLength(0);
  });
});

describe("a token GitHub no longer takes", () => {
  /*
   * "If a user revokes their authorization of a GitHub App ... If your app continues to use a revoked access token,
   * it will receive the `401 Bad Credentials` error."
   *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app
   * "The user access token expires after eight hours", and "Once you use a refresh token, that refresh token and the
   * old user access token will no longer work."
   *   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
   * "Authenticating with invalid credentials will initially return a `401 Unauthorized` response."
   *   https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api#failed-login-limit
   */
  it('throws GitHubGrantGoneError from every call when GitHub answers 401, with nothing of the token in it', async () => {
    github = await startGitHub(() => ({ status: 401, body: { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' } }));

    for (const [name, call] of everyCall(github.base)) {
      const before = github.received.length;
      const gone: unknown = await call().catch((error: unknown) => error);

      expect(gone, name).toBeInstanceOf(GitHubGrantGoneError);
      expect(gone, name).toMatchObject({ name: 'GitHubGrantGoneError', reason: 'token' });
      expect(`${(gone as Error).message} ${JSON.stringify(gone)}`, name).not.toContain('ghu_');
      expect((gone as Error).message, name).not.toContain('Bad credentials');
      // The call stopped at the refusal: one request, none sent again with a token GitHub refused.
      expect(github.received.length - before, name).toBe(1);
    }
  });
});

describe("a person's call under its deadline", () => {
  it('ends with GitHubNoAnswer when GitHub does not answer in the time given', async () => {
    github = await startGitHub(() => 'hang');
    const at = { apiBase: github.base, timeoutMs: 80 };

    for (const call of [() => listAssignedIssues(TOKEN, { repositories: ['acme-team/planner'] }, at), () => issueTargets(TOKEN, at), () => closeIssueAsUser(TOKEN, { repository: 'acme-team/planner', number: 91 }, at)]) {
      const late: unknown = await call().catch((error: unknown) => error);
      expect(late).toBeInstanceOf(GitHubNoAnswer);
      expect(late).toMatchObject({ reason: 'timeout' });
    }
  });
});
