# @framers/agentos-ext-linear

Linear for a host that keeps its own grant: Linear's OAuth 2.0 with PKCE on the AgentOS core's redirect flow, a GraphQL client over `fetch`, and the issue tracker interface of `@framers/agentos-ext-account-sources` on that client. The pack lists a person's teams and their open assigned issues, and opens or closes one issue at a time.

```ts
import { LinearClient, LinearOAuthFlow, LinearTracker } from '@framers/agentos-ext-linear';

// The person's press of Connect: send them to the address, keep the state and the verifier until they come back.
const flow = new LinearOAuthFlow({ clientId, clientSecret }, store);
const { url, state, codeVerifier } = flow.begin({ redirectUri: 'https://example.com/api/linear/callback' });

// Linear's return: check the state, exchange the code with the verifier, keep the refresh token.
const grant = await flow.complete({ code, state: returnedState, expectedState: state, codeVerifier, redirectUri });
await flow.keep(connectionId, grant);

// Calls on the grant: the client asks the flow for a usable access token each time.
const client = new LinearClient(() => flow.accessToken(connectionId));
await client.organization(); // { name: 'Acme', urlKey: 'acme' }

// The tracker interface: teams as destinations, one issue a call.
const tracker = new LinearTracker(client, () => flow.forget(connectionId));
const [team] = await tracker.destinations(); // { id, key: 'ENG', name: 'Engineering', visibility: null, issueTypes: [] }
const issue = await tracker.createIssue({ destinationId: team.id, title: 'Send the slides', body: 'From the planning call.' });
issue.url; // https://linear.app/acme/issue/ENG-123
await tracker.closeIssue(issue);

// Disconnect: revoke the refresh token at Linear and clear the grant.
await tracker.revoke(); // { revoked: true }
```

## Installation

```bash
npm install @framers/agentos-ext-linear @framers/agentos @framers/agentos-ext-account-sources
```

`@framers/agentos` (0.15.81 or later) and `@framers/agentos-ext-account-sources` (0.11.3 or later) are peer dependencies: the flow extends the core's `RedirectOAuthFlow`, and the client and the tracker throw the account sources library's tracker faults, which a host compares with `instanceof`.

## Usage

`LinearOAuthFlow` follows Linear's [OAuth 2.0 document](https://linear.app/developers/oauth-2-0-authentication):

- `begin({ redirectUri })` answers the authorize address (`https://linear.app/oauth/authorize`) with the client id, `response_type=code`, the callback, the scopes comma-separated, `actor=user`, `prompt=consent`, a state and an S256 PKCE challenge, with the state and the verifier for the host to keep. No extra parameter replaces the actor or the prompt. The callback must be HTTPS (plain HTTP at a loopback host aside), with no userinfo or fragment.
- `complete` checks the state in constant time, then posts the code to `https://api.linear.app/oauth/token` as a form with the callback, the client id, the client secret and the verifier. An answer without a refresh token is refused as `invalid_response`.
- `keep(key, grant)` hands the host's store the refresh token alone; the access token stays in the flow's memory. Use the core's `SealedTokenStore` on a server, so the refresh token is sealed at rest. A grant without a refresh token is refused as `configuration`, and nothing is kept.
- `accessToken(key)` answers the access token while it has more than five minutes left, and otherwise refreshes the grant, one refresh at a time a key, keeping the refresh token the answer rotates in.
- `revoke(token, hint)` posts `token` and `token_type_hint` (`refresh_token` by default, or `access_token`) to `https://api.linear.app/oauth/revoke`. Linear answers 200 when it revoked the token; any other answer throws the core's `OAuthGrantRefused` with reason `revoke` and the status.
- `forget(key)` revokes the kept refresh token and clears the grant whatever Linear answers, and answers `{ revoked }`.

`LinearClient` takes a supplier of the access token, so the same client serves any credential the host holds:

- `organization()`: the workspace's name and URL key.
- `teams()`: the teams whose issues the person can reach, 50 a page, at most 250.
- `assignedIssues(limit = 50)`: the person's open issues, the newest change first, at most 250.
- `createIssue({ teamId, title, description })`: one issue, its description read by Linear as Markdown.
- `closeIssue(issueId)`: moves the issue to its team's completed state with the lowest position, and writes nothing for an issue already done.
- `linearGraphql(token, operationName, query, variables)` makes one call of a host's own document under the same deadline, cap and faults.

`LinearTracker` implements `IssueTracker` on the client. Its destinations are teams, with `visibility: null`, since a team's issues are read inside the workspace and never in public, and `issueTypes: []`, since Linear has no issue types. A draft that names an issue type is refused before any call. Its `revoke` calls the function the host gives it, the flow's `forget` of the grant's key. It passes the account sources library's tracker conformance checks.

## Configuration

| Option | Where | What it does |
|---|---|---|
| `clientId`, `clientSecret` | `LinearOAuthFlow` | The OAuth application's client, loaded through the host's secret mechanism |
| `fetchImpl` | the flow and the client | The fetch every call is made with; the global fetch when absent |
| `timeoutMs` | the flow and the client | One deadline over a call and the reading of its answer: 15 seconds for a token call, 30 seconds for a GraphQL call |
| `endpoints` | `LinearOAuthFlow` | Stand-in addresses for the authorize, token, revoke and GraphQL addresses |
| `endpoint` | `LinearClient` | A stand-in's GraphQL address |

Stand-in addresses are taken only on CI (`CI=true`) and only at a loopback or `.invalid` host. Never take them from a request.

Every call runs under its deadline and the caller's signal, follows no redirect, and reads its answer under a cap (64 KiB for a token answer, 1 MiB for a GraphQL answer).

## What Linear gives

- **The scopes.** `read`, which is always present ("Read access for the user's account"); `write` ("Write access for the user's account"); and `issues:create` ("Allows creating and updating issues, and creating their attachments"), from [Linear's scope list](https://linear.app/developers/oauth-2-0-authentication). The flow never asks for `comments:create`, since it writes no comment, or for `admin`, which Linear's document says to ask for only when absolutely needed.
- **The actor.** `actor=user`, Linear's default: an issue the pack opens is created as the person who connected, not as the application ([the authorize parameters](https://linear.app/developers/oauth-2-0-authentication)).
- **The tokens.** An access token lasts 24 hours (`expires_in: 86399`). A refresh token lasts 30 days from its issue, and each refresh answers a new access token and a new refresh token with a fresh 30 days. API requests extend neither, so a grant left unused for 30 days asks the person to connect again. A refresh whose answer was lost can be repeated with the same refresh token within 30 minutes of the first. Linear moved every OAuth application to refresh tokens on 1 April 2026.
- **Revocation.** `POST https://api.linear.app/oauth/revoke` with `token` and, when available, `token_type_hint`: 200 when revoked, 400 when Linear could not revoke the token (one already revoked, for example), 401 when it could not authenticate with it.
- **A workspace's own automation.** Linear's client credentials grant gives a 30-day app token with no refresh token, meant for CI and scheduled jobs. The client takes any token supplier, so a host reaches Linear that way by supplying such a token; this version builds no flow for it.

## Rate limits

An OAuth application may make 5,000 requests an hour for each person (or app user), within 2,000,000 complexity points an hour, and a single query may not pass 10,000 points ([rate limiting](https://linear.app/developers/rate-limiting)). Every answer carries `X-RateLimit-Requests-Limit`, `X-RateLimit-Requests-Remaining` and `X-RateLimit-Requests-Reset` (epoch milliseconds), with the same three for complexity and, for a limited endpoint, for that endpoint. A call past a limit answers HTTP 429 with an error whose code is `RATELIMITED` and a `Retry-After` header in seconds.

The client throws `TrackerRateLimited` for a 429 or a `RATELIMITED` error. Its `retryAt` comes from `Retry-After`, capped at an hour; else from the latest reset of the windows whose remaining count ran out; else it is null. The pack never retries on its own.

## Faults

Every call of the client and the tracker throws the account sources library's tracker faults, which carry a reason and a status and never Linear's text:

| Linear's answer | Fault |
|---|---|
| 429, or an error with the code `RATELIMITED` | `TrackerRateLimited` with `retryAt` |
| 401, an error with the code `AUTHENTICATION_ERROR`, or a grant the token supplier refused | `TrackerGrantRefused`: ask the person to connect again |
| No answer by the deadline, a cancel or a failed connection | `TrackerNoAnswer` with `cause` `timeout`, `cancelled` or `network` |
| Any other status outside 2xx, or any other error | `TrackerFault('refused')` with the status |
| An answer past the cap, or one without the fields the call needs | `TrackerFault('invalid_response')` |
| A draft or a limit refused before any call | `TrackerFault('configuration')` |

A token supplier that throws the core's `OAuthGrantRefused` reads as `TrackerGrantRefused`. Two cases keep the grant: a refresh Linear answered 429 reads as `TrackerRateLimited`, and a refresh it answered with a 5xx reads as `TrackerFault('refused')`. The flow throws the core's `OAuthGrantRefused` for a refused exchange, refresh or revocation, `TrackerNoAnswer` for a call with no answer, and `LinearFault` for an option, input or answer the pack refuses on its own.

## What the pack never reads

No id, name, email or avatar of the person or of anyone else: the client's documents ask for the organisation's name and URL key, teams' ids, keys and names, and issues' ids, identifiers, titles, addresses, update times, states and teams. The assigned issues come through `viewer.assignedIssues`, which asks for no field of the assignee. The documents are in `src/client.ts`.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by its release workflow; each version is recorded at the repository's releases.

## License

Apache-2.0
