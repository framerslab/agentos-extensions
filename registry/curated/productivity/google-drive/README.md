# @framers/agentos-ext-google-drive

The files a person picks in Google Drive, read under the `drive.file` scope. This library holds Google's grant on AgentOS's `RedirectOAuthFlow` (`GoogleOAuthFlow`), Drive's calls over an injected `fetch`, and `GoogleDrivePickedConnector`, an `AccountSourceConnector` that reads picked files by id.

Install `@framers/agentos-ext-google-drive` next to its peers `@framers/agentos` 0.13.144 or later and `@framers/agentos-ext-account-sources` 0.7.0 or later. Both are peers with a floor and no upper bound, so the pack throws the host's own `ReadCapExceeded` and `SourceSyncFault`. Node.js 20.19 or later is required. The library does not use `googleapis`.

## The grant

```ts
import { GoogleOAuthFlow, grantHoldsDriveFile } from '@framers/agentos-ext-google-drive';

const callback = 'https://app.example.com/google/callback';

// The request that sends the person to Google: keep the state and the verifier until they come back.
const begun = new GoogleOAuthFlow({ clientId, clientSecret }, null).beginDrive(callback);

// The request Google sends the person back to. `store` is an IOAuthTokenStore, such as the auth module's
// SealedTokenStore under the connection's namespace.
const flow = new GoogleOAuthFlow({ clientId, clientSecret }, store);
const tokens = await flow.complete({ code, state, expectedState: begun.state, codeVerifier: begun.codeVerifier, redirectUri: callback });
await flow.keep(connectionId, tokens);
```

`new GoogleOAuthFlow(client, store, options)` takes the web client's id and secret, a store (null for a flow that only begins, completes and revokes) and `{ fetchImpl, signal, endpoints }`, each optional. A malformed client, options object or endpoint override throws `GoogleOAuthFault` `configuration`, as does a malformed `begin` or `complete` input, such as null scopes or a missing state.

`beginDrive(redirectUri)`, the same as `begin({ redirectUri })`, answers `{ url, state, codeVerifier }`. The address asks for `https://www.googleapis.com/auth/drive.file` alone, with `access_type=offline` for a refresh token, `include_granted_scopes=true` for incremental authorization and `prompt=consent`, and carries the state and the S256 PKCE challenge. The client secret never appears in it. `begin` refuses another scope, an extra parameter, and a redirect address with userinfo, a query or a fragment, or over plain HTTP at a host other than `localhost`, `127.0.0.1` or `[::1]` (Google exempts loopback addresses from its HTTPS rule).

`complete` checks the redirect address and the shape of the code, the state and the verifier before any call, then checks the returned state, then exchanges the code at Google's token address with the verifier and the client. It accepts a grant only when `tokens.metadata.scope` holds `drive.file`, a refresh token came with it and the access token has not expired; it throws `GoogleOAuthFault` `scope`, `refresh_token` or `invalid_response` otherwise. With incremental authorization the scopes include those the person granted the project before, such as the scopes of signing in, so the check is that they hold `drive.file`; `grantHoldsDriveFile(tokens)` answers the same. The id token and any other field of Google's answer are dropped. `complete` keeps nothing.

`keep`, `accessToken` and `forget` come from `RedirectOAuthFlow`. `keep` applies the exchange's checks, then hands the store the refresh token and the scopes, never the access token. `accessToken(key)` refreshes at Google's token address, one refresh at a time, when the token in memory is missing or near its end. It throws `GoogleOAuthFault` `scope` when the kept scopes lack `drive.file`, checked on the grant the refresh renews (the one the base flow reads in the key's turn) before Google is asked, and a refresh whose answer names scopes without `drive.file` throws the same. Once `signal` has aborted it answers no token, not even one held in memory; a grant a refresh renewed is kept by then. `forget(key)` revokes the refresh token at Google's revocation address and clears the kept grant whatever Google answers, and answers `{ revoked }`.

The flow never revokes a grant on its own, not even one its checks refuse. Google's revocation removes every scope the person granted the Google Cloud project, for every client of that project, including scopes granted for signing in through a client of the same project. Whether to revoke stays the caller's decision.

Every call to Google's token and revocation addresses goes through one bounded transport: a POST to those two addresses alone, redirects refused, no credentials or referrer sent, at most 65,536 bytes of the answer read, and one 15-second deadline over the call and the reading of its answer. An answer past the cap is refused at once: the rest of Google's stream is cancelled without waiting for the cancellation to settle. Once `signal` aborts, no operation starts and a call under way stops waiting for Google; `complete` still hands back an answer already read whole, so a grant Google issued is never dropped unread. Failures are fixed `GoogleOAuthFault` reasons whose message is `google_oauth_<reason>`: `configuration`, `cancelled`, `timeout`, `network`, `response_too_large`, `invalid_response`, `scope` and `refresh_token`. None carries Google's text, a code or a credential. A refusal at Google's token or revocation address is the auth module's `OAuthGrantRefused`, which keeps the HTTP status and an allowlisted OAuth error code alone.

`GOOGLE_ENDPOINTS` names Google's authorization, token and revocation addresses. A test passes its stand-in's as `endpoints`; they are taken only with `CI=true`, at a loopback or `.invalid` host, with no userinfo, query or fragment, and never from a request.

## In an account-source lifecycle

`@framers/agentos-ext-account-sources` runs each grant operation under a durable grant lease: it hands the operation a `SealedTokenStore` under the connection's namespace and a signal that aborts after 15 seconds, and its revoke-only queue revokes each queued token with a flow of no store, bound to that attempt's signal. Build a flow for each of them and discard it at the end of the operation:

```ts
import { SOURCE_GRANT_KEY } from '@framers/agentos-ext-account-sources';
import { driveOAuthFault, GoogleDrivePickedConnector, GoogleOAuthFlow } from '@framers/agentos-ext-google-drive';

// One access token, refreshed inside the lifecycle's grant operation; the failure translated inside it.
const accessToken = () => revocations.withGrant(handle, async (tokens, signal) => {
  try {
    return await new GoogleOAuthFlow(client, tokens, { signal }).accessToken(SOURCE_GRANT_KEY);
  } catch (error) {
    throw driveOAuthFault(error);
  }
});

// The lifecycle's revoker, given to SourceRevocations as `revoker`.
const revoker = (signal: AbortSignal) => new GoogleOAuthFlow(client, null, { signal });

const connector = new GoogleDrivePickedConnector(accessToken, { ownedOnly: true, maxFileBytes: 10_000_000 });
```

`driveOAuthFault(error)` answers the `SourceSyncFault` a lifecycle acts on: `grant_rejected` for a grant Google no longer honours (nothing kept, or `invalid_grant`) and `insufficient_scope` for one without `drive.file`, the two that start the handling of a lost grant; `rate_limited` for a 429; `provider_unavailable` for a 5xx, `server_error` or `temporarily_unavailable`; `network` for a failed call or a deadline; `cancelled` for a cancellation; `invalid_response` for anything else, a refused client (`invalid_client`, `unauthorized_client`) among them, which needs the operator's fix and is never a lost grant. A `SourceSyncFault` passes as it is. Call it inside the grant operation: the lifecycle reads any other error that leaves it as storage trouble.

A flow built for one operation serves that operation alone: it holds the access token in its own memory, so each operation refreshes once.

## Reading picked files

```ts
import { GoogleDrivePickedConnector } from '@framers/agentos-ext-google-drive';

const connector = new GoogleDrivePickedConnector(() => flow.accessToken(connectionId), {
  ownedOnly: true,
  maxFileBytes: 10_000_000,
  revoke: () => flow.forget(connectionId),
});

const read = await connector.read({ id: pickedFileId, title: '', size: null, version: null });
if ('reason' in read) {
  // Gone: `removed`, `no_access` or `not_owned`.
} else {
  // read.content is { bytes, mediaType }; read.ref carries the file's name, its webViewLink and its version.
}
```

`read` asks Drive for the file's metadata first, then exports or downloads it under `maxFileBytes`. Every file is answered as bytes with the type it was read as, for the caller's loader of that type:

| File | Read through | `mediaType` |
|---|---|---|
| Google Docs document | `files.export` | `text/markdown` |
| Google Sheets spreadsheet | `files.export`, the first sheet | `text/csv` |
| Google Slides presentation | `files.export` | `text/plain` |
| Any other file | `files.get` with `alt=media` | the file's own type |

Each read's `SourceRef` has the kind `google_drive`, the file's name as its title, its `webViewLink` as its address, Drive's `version` of the file and the time it was read.

A file that can no longer be read is answered gone, with its id and a reason:

- `removed`: Drive answers it not found (404; deleted, or no longer readable by the person), it is in the trash, it is a Google Workspace type with no export here (a folder, a form, a shortcut), Google refuses its export with the reason `exportSizeLimitExceeded` (`files.export` answers at most 10 MB), or its content is past `maxFileBytes`.
- `no_access`: Drive refuses the file with a 403 that is not a rate limit, such as `appNotAuthorizedToFile`.
- `not_owned`: `ownedOnly` is set and Drive does not answer `ownedByMe: true`. Drive leaves `ownedByMe` out for an item in a shared drive. The file's content is never requested.

The connector throws instead of answering gone when an answer says nothing about the file: Drive's rate and quota limits (403 or 429 in the `usageLimits` domain), a token Drive refuses (401), a server's fault, an error answer that is not Google's error object (a proxy's, or a wrong `baseUrl`'s 404), a metadata answer past 1 MiB, such as a proxy's page (`ReadCapExceeded`), or whatever the access token function throws, such as `OAuthGrantRefused` once a grant is gone, or the `SourceSyncFault` an account-source lifecycle's grant operation throws. A caller tries again later.

`list(selection)` answers the selected files as items, with their versions, and those that are gone, from their metadata alone. `changesSince(cursor, selection)` answers the files whose `version` differs from the cursor's, the files that are gone and the next cursor. The cursor is a JSON object of each file's id to the version it was read at; a null cursor answers every readable file as changed. Drive's `version` reflects every change made to a file on the server. `revoke()` calls the `revoke` option, and throws when the connector was given none.

The metadata and the download ask with `supportsAllDrives=true`, without which Drive answers an item of a shared drive as not found.

## Drive's calls

```ts
import { driveAccount, driveFile } from '@framers/agentos-ext-google-drive';

const account = await driveAccount(accessToken); // { emailAddress, displayName }
const file = await driveFile(accessToken, fileId); // its name, type, version, owner, size, link and trash state
```

- `driveFile(token, id, options?)` answers a file's metadata: `id`, `name`, `mimeType`, `version`, `modifiedTime`, `ownedByMe` (null where Drive leaves it out), `size` (null where Drive states none), `webViewLink` and `trashed`.
- `exportFile(token, id, mimeType, maxBytes, options?)` answers a Google Workspace file exported as `mimeType`; `EXPORT_TYPES` maps each type the connector exports to the type it asks for.
- `downloadFile(token, id, maxBytes, options?)` answers a file's own bytes.
- `driveAccount(token, options?)` answers the account's address and name from Drive's `about`, so a caller can show which account is connected. The `drive.file` scope may read it.

Each takes `{ fetchImpl, baseUrl, signal }` last: the global `fetch` and Google's address when they are absent, a stand-in's in a test. A refusal throws `DriveRequestError` with the HTTP status and, when Drive's answer names them, Google's error `reason` and `domain`. A body past its cap throws `ReadCapExceeded` from `@framers/agentos-ext-account-sources`.

## License

Apache-2.0. This pack carries a copy of the repository's license.
