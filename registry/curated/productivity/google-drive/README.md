# @framers/agentos-ext-google-drive

The files a person picks in Google Drive, read under the `drive.file` scope. This library holds Google's grant on AgentOS's `RedirectOAuthFlow` (`GoogleOAuthFlow`), Drive's calls over an injected `fetch`, and `GoogleDrivePickedConnector`, an `AccountSourceConnector` that reads picked files by id.

Install `@framers/agentos-ext-google-drive` with its peer `@framers/agentos` 0.13.40 or later. Node.js 20.19 or later is required. The runtime dependency is `@framers/agentos-ext-account-sources`; the library does not use `googleapis`.

## The grant

```ts
import { GoogleOAuthFlow, grantHoldsDriveFile } from '@framers/agentos-ext-google-drive';

// `store` is an IOAuthTokenStore, such as the auth module's SealedTokenStore.
const flow = new GoogleOAuthFlow({ clientId, clientSecret }, store);

// The request that sends the person to Google: keep the state and the verifier until they come back.
const begun = flow.beginDrive('https://app.example.com/google/callback');

// The request Google sends the person back to.
const tokens = await flow.complete({
  code,
  state,
  expectedState: begun.state,
  codeVerifier: begun.codeVerifier,
  redirectUri: 'https://app.example.com/google/callback',
});
if (grantHoldsDriveFile(tokens)) await flow.keep(connectionId, tokens);
```

`beginDrive(redirectUri)` answers `{ url, state, codeVerifier }`. The address asks for `https://www.googleapis.com/auth/drive.file` alone, with `access_type=offline` for a refresh token, `include_granted_scopes=true` for incremental authorization and `prompt=consent`, and carries the state and the S256 PKCE challenge. The client secret never appears in it.

`complete` checks the returned state and exchanges the code at Google's token address with the verifier and the client. `tokens.metadata.scope` holds the scopes Google granted, which with incremental authorization include those the client was granted before; `grantHoldsDriveFile(tokens)` is true only when they include `drive.file`.

`keep`, `accessToken` and `forget` come from `RedirectOAuthFlow`: the store is handed the refresh token and the scopes, never the access token; `accessToken(key)` refreshes at Google's token address, one refresh at a time, when the token in memory is missing or near its end; `forget(key)` revokes the refresh token at Google's revocation address and clears the kept grant whatever Google answers, and answers `{ revoked }`. Google's revocation removes every scope the person granted the Google Cloud project, for every client of that project, including scopes granted for signing in through a client of the same project.

`GOOGLE_ENDPOINTS` names Google's authorization, token and revocation addresses. A test passes its stand-in's addresses as the fourth argument, after the fetch.

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

- `removed`: Drive answers it not found (404; deleted, or no longer readable by the person), it is in the trash, it is a Google Workspace type with no export here (a folder, a form, a shortcut), Google refuses its export as past the 10 MB that `files.export` answers, or its content is past `maxFileBytes`.
- `no_access`: Drive refuses the file with a 403 that is not a rate limit, such as `appNotAuthorizedToFile`.
- `not_owned`: `ownedOnly` is set and Drive does not answer `ownedByMe: true`. Drive leaves `ownedByMe` out for an item in a shared drive. The file's content is never requested.

The connector throws instead of answering gone when the refusal says nothing about the file: Drive's rate and quota limits (403 or 429 in the `usageLimits` domain), a token Drive refuses (401), a server's fault, an error answer that is not Google's error object (a proxy's, or a wrong `baseUrl`'s 404), or whatever the access token function throws, such as `OAuthGrantRefused` once a grant is gone. A caller tries again later.

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
