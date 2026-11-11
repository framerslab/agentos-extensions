# @framers/agentos-ext-jira

Jira Cloud for a host that keeps its own grant: Atlassian's OAuth 2.0 (3LO) on granular scopes on the AgentOS core's redirect flow, Jira Cloud's REST v3 through the site's cloud id, and the issue tracker interface of [`@framers/agentos-ext-account-sources`](../../research/account-sources/).

```ts
import { JiraClient, JiraOAuthFlow, JiraTracker } from '@framers/agentos-ext-jira';

// The person's press of Connect: send them to the address, keep the state until they come back.
const flow = new JiraOAuthFlow({ clientId, clientSecret }, store);
const { url, state } = flow.beginJira('https://example.com/api/jira/callback');

// Atlassian's return: check the state, exchange the code, keep the refresh token and the granted scope.
const grant = await flow.complete({ code, state: returnedState, expectedState: state, codeVerifier: '', redirectUri });
await flow.keep(connectionId, grant);

// The sites the grant reaches; the person chooses one when there are several.
const token = () => flow.accessToken(connectionId);
const [site] = await JiraClient.sites(token); // { id: cloud id, url: 'https://acme.atlassian.net', name: 'acme' }

// The tracker on that site.
const tracker = new JiraTracker(new JiraClient(token, site), () => flow.forget(connectionId));
const projects = await tracker.destinations(); // each with its issue types
const ref = await tracker.createIssue({
  destinationId: projects[0].id,
  issueTypeId: projects[0].issueTypes[0].id,
  title: 'Send the slides to the board',
  body: 'From the planning call.\n\nSaid at 10:04.',
});
ref.url; // https://acme.atlassian.net/browse/ABC-42
await tracker.closeIssue(ref);

// Disconnect: clear the grant. Atlassian has no revocation endpoint.
await tracker.revoke(); // { revoked: false }
```

## Installation

```bash
npm install @framers/agentos-ext-jira @framers/agentos @framers/agentos-ext-account-sources
```

`@framers/agentos` (0.13.144 or later) and `@framers/agentos-ext-account-sources` (0.11.3 or later) are peer dependencies. The pack has no dependency of its own: every call runs on `fetch`.

## The grant

An OAuth 2.0 (3LO) app is made in Atlassian's developer console with its callback, its permissions and, for anyone outside the app owner's account to connect, sharing switched on ([OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), read 10 November 2026). The flow follows that guide:

- `beginJira(redirectUri)` answers the authorize address `https://auth.atlassian.com/authorize` with `audience=api.atlassian.com`, the client id, the space-separated scopes, the callback, a state of 32 random bytes in hex, `response_type=code` and `prompt=consent`, and nothing else. The guide names no PKCE parameter, so the verifier answered is the empty word. The callback must be HTTPS (plain HTTP at a loopback host aside) with no query, fragment or userinfo.
- `complete` checks the state in constant time, then exchanges the code by a POST to `https://auth.atlassian.com/oauth/token` of the JSON body `{ grant_type: 'authorization_code', client_id, client_secret, code, redirect_uri }`. A grant is accepted only with a refresh token and a lifetime (`expires_in`); its `metadata` holds the granted `scope`.
- `keep` hands the store the refresh token and the metadata alone; the access token stays in memory. `accessToken` refreshes one at a time a key with the JSON body `{ grant_type: 'refresh_token', client_id, client_secret, refresh_token }`. Atlassian's refresh tokens rotate: each use answers a new one, which the store keeps; a refresh token expires after 90 days without use, and reusing one within 10 minutes is tolerated.
- `revoke` makes no call: the guide names no token revocation endpoint, and a person ends the grant in their Atlassian account. `forget(key)` clears the kept grant and the token held in memory and answers `revoked: false`.

A refused exchange or refresh throws the core's `OAuthGrantRefused` with the status and Atlassian's OAuth code (`invalid_grant` and the other RFC 6749 codes, never Atlassian's text). A token call runs under a 15-second deadline and a 64 KiB answer cap and stops on the flow's signal; a call with no answer is `JiraFault('no_answer')`, an answer past the cap or without a refresh token or a lifetime `JiraFault('invalid_response')`.

### What Jira gives

`JIRA_SCOPES` is the set the flow asks for. Each granular scope is one Jira Cloud's OpenAPI document lists for a call the client makes ([`swagger-v3.v3.json`](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json), `x-atlassian-oauth2-scopes`, read 10 November 2026):

| Call | Granular scopes |
|---|---|
| `POST /rest/api/3/issue` (create issue) | `write:issue:jira`, `write:comment:jira`, `write:comment.property:jira`, `write:attachment:jira`, `read:issue:jira` |
| `GET /rest/api/3/issue/{issueIdOrKey}/transitions` | `read:issue.transition:jira`, `read:status:jira`, `read:field-configuration:jira` |
| `POST /rest/api/3/issue/{issueIdOrKey}/transitions` | `write:issue:jira`, `write:issue.property:jira` |
| `GET /rest/api/3/project/search` | `read:issue-type:jira`, `read:project:jira`, `read:project.property:jira`, `read:user:jira`, `read:application-role:jira`, `read:avatar:jira`, `read:group:jira`, `read:issue-type-hierarchy:jira`, `read:project-category:jira`, `read:project-version:jira`, `read:project.component:jira` |
| `POST /rest/api/3/search/jql` | `read:issue-details:jira`, `read:field.default-value:jira`, `read:field.option:jira`, `read:field:jira`, `read:group:jira` |

Beside them the set holds the classic `read:jira-user`, the person's own user read, and `offline_access`, which the token answer needs to carry a refresh token. The full list, 26 scopes, in the order the flow sends them:

```
read:application-role:jira read:avatar:jira read:field-configuration:jira read:field.default-value:jira
read:field.option:jira read:field:jira read:group:jira read:issue-details:jira read:issue-type-hierarchy:jira
read:issue-type:jira read:issue.transition:jira read:issue:jira read:project-category:jira read:project-version:jira
read:project.component:jira read:project.property:jira read:project:jira read:status:jira read:user:jira
write:attachment:jira write:comment.property:jira write:comment:jira write:issue.property:jira write:issue:jira
read:jira-user offline_access
```

The app's permissions in the developer console hold the same scopes; `offline_access` is asked in the authorize address alone. The classic `write:jira-work` is not asked: it allows deleting issues ([Jira scopes](https://developer.atlassian.com/cloud/jira/platform/scopes-for-oauth-2-3LO-and-forge-apps/)), and no `delete:*` scope is in the set. A host that needs fewer passes `options.scopes`, which must hold `offline_access`.

An app made with the account-level grant covers every site where the app is installed with one consent, and `accessible-resources` can list several sites, to which more may be added over time; with the resource-level grant the consent covers the sites the person chose on the consent screen ([OAuth 2.0 (3LO) apps](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/)). Under either, `JiraClient.sites` answers every site the token reaches, and the host lets the person choose one. A site's admin may need to approve the app before a person can connect it ([your site admin must authorize this app](https://support.atlassian.com/atlassian-cloud/kb/your-site-admin-must-authorize-this-app-error-in-atlassian-cloud-apps/)).

A workspace's own automation reaches Jira another way, with an API token or a service account. Every client takes its credential from a supplier (`() => Promise<string>`) and its addresses from its options, so that way is a constructor a later version adds, with no change to a caller; this version builds the person's grant alone.

## The client

`new JiraClient(accessToken, { id, url }, options?)` calls `https://api.atlassian.com/ex/jira/<cloud id>/rest/api/3/...` on the token the supplier gives:

- `JiraClient.sites(accessToken)` reads `GET https://api.atlassian.com/oauth/token/accessible-resources` and answers each site's cloud id, address and name; the site's scopes and avatar are not kept.
- `projects()` reads `GET /project/search?expand=issueTypes&action=create`, which lists the projects where the person holds the Create issues permission, 50 a page until the last page, at most 500. Each project carries its issue types that are not subtasks.
- `assignedIssues(limit = 50)` posts `{ jql: 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC', fields: ['summary', 'status', 'updated', 'project'], maxResults }` to `/search/jql`, reading its pages by `nextPageToken` up to the limit (1 to 100). Each issue's address is `<site>/browse/<key>`, its time ISO 8601 in UTC.
- `createIssue({ projectId, issueTypeId, summary, description })` posts the fields to `/issue` with the description as Atlassian Document Format (`adfParagraphs`) and answers the issue's id, key and address.
- `closeIssue(key)`, or `closeIssue({ id, key })` with the ref `createIssue` answered, reads `GET /issue/<key>/transitions`, then the issue's status through `/search/jql` (`issue = "<key>"`, the status field alone). An issue already in the done category resolves and is left as it is: a workflow where every status reaches every other offers an issue in Done the move to another done status, such as Won't Do, which would rewrite how it was closed. Any other issue takes the available transition whose target status is in the done category, the one named Done first; with none, it is refused. The status is not read with `GET /issue/<key>`, whose granular scopes (`read:issue-meta:jira`, `read:issue-security-level:jira`, `read:issue.vote:jira`, `read:issue.changelog:jira` among them) are outside the set ([`swagger-v3.v3.json`](https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json), `getIssue`), and Atlassian answers a call whose scopes the grant lacks with 401 `Unauthorized; scope does not match` ([a report on Atlassian's developer community](https://community.developer.atlassian.com/t/oauth-2-0-3lo-granular-jira-software-scopes-present-in-token-but-rest-agile-1-0-returns-401-scope-does-not-match/100456)), which the tracker would read as an ended grant. The JQL search is eventually consistent ("Recent updates might not be immediately visible", [issue search](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/#api-rest-api-3-search-jql-post)), so when the issue's numeric id is known (the ref's `id`, or a numeric key) the search passes it in `reconcileIssues`, and a close right after another reads the status the first one wrote.

`adfParagraphs(text)` makes one paragraph per part between blank lines and a [hard break](https://developer.atlassian.com/cloud/jira/platform/apis/document/nodes/hardBreak/) per line break inside a part, with no empty text node.

Every call runs on the injected `fetch` under one deadline (15 seconds unless `timeoutMs` says) and a 1 MiB answer cap, follows no redirect, and stops on the caller's signal. The wait for the supplier's token runs before the call starts and shares that one deadline and the signal: a token that takes 10 of 15 seconds leaves the call 5. A supplier that finds no grant kept (`OAuthGrantRefused` with `missing`) is asked once more within the deadline, so a refresh another flow on the same store has just kept is read rather than refused. A failure is one of the account sources' tracker faults, whose message carries a reason and a status and never Jira's text:

- 429 is `TrackerRateLimited`, its `retryAt` from `Retry-After` in seconds or as an HTTP date, else `X-RateLimit-Reset` as an ISO 8601 time, each a day from now at most, else null ([rate limiting](https://developer.atlassian.com/cloud/jira/platform/rate-limiting/), read 10 November 2026: "Retry-After: Only returned with 429 responses. Indicates how many seconds to wait before retrying.").
- 401, and a grant the flow could not renew (a refresh Atlassian refused below 500, or no grant kept), is `TrackerGrantRefused`. A refresh Atlassian answered 429 is `TrackerRateLimited` with a null `retryAt`, and one it could not serve (5xx) is `TrackerFault('refused')` with its status: the grant is kept for the next try.
- 404 is `TrackerFault('not_found')`; any other refusal, 400, 403 and 5xx among them, is `TrackerFault('refused')` with its status.
- An answer that is not JSON, past the cap, or without the fields a call needs is `TrackerFault('invalid_response')`.
- No answer by the deadline, a cancelled call or a failed connection, at Jira or at the token address during a refresh, is `TrackerNoAnswer` with `timeout`, `cancelled` or `network`; a token answer past its cap is `TrackerFault('invalid_response')`. No `JiraFault` reaches a tracker call.

## The tracker

`new JiraTracker(client, revokeGrant)` implements `IssueTracker`: `kind` is `jira`; `destinations()` answers the projects with their issue types and `visibility: null`; `assignedIssues()` maps the done category to `done` and the others to `open`; `createIssue(draft)` needs the draft's `issueTypeId` (`TrackerFault('configuration')` without one, before a call); `closeIssue(ref)` closes by key; `revoke()` runs the host's `forget`. Its tests run the account sources' `trackerConformance` checks over an in-memory site, with `revocable: false`.

## What the pack never reads

No account id, name, email or avatar of the person or of anyone else reaches a value the pack answers or a grant it keeps. The issue search asks four fields, none of which names a person; the project search expands the issue types alone, never the project lead.

## Stand-ins

On CI alone (`CI=true`), `JiraOAuthFlow` and `JiraClient` take stand-in `endpoints`, each at a loopback or `.invalid` host. Never take them from a request.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions, with a provenance statement; each is recorded at the repository's releases under the tag `@framers/agentos-ext-jira@<version>`.

## License

Apache-2.0
