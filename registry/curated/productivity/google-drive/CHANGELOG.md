# @framers/agentos-ext-google-drive

## 1.3.0

### Minor Changes

- [#395](https://github.com/framerslab/agentos-extensions/pull/395) [`e2a1792`](https://github.com/framerslab/agentos-extensions/commit/e2a17928bb8be2adf8b68fee61361955ccc3314c) Thanks [@jddunn](https://github.com/jddunn)! - `parseDriveLink(text)` reads the Drive and Docs addresses a person pastes, without a request: a Doc, Sheet or Slides address, `/file/d/<id>`, `/open?id=`, `/uc?id=` and `drive.usercontent.google.com/download?id=` or `/uc?id=` as a file, `/drive/folders/<id>` as a folder and `/drive/shared-drives/<id>` as a shared drive, a signed-in account's `/u/<n>/` allowed. Any other address on `docs.google.com`, `drive.google.com` and `drive.usercontent.google.com` is `refused` (a Form, a Drawing, the publish-to-the-web form, Drive's own pages, an address carrying credentials with a scheme or without one), and another host's is `null`.

## 1.2.1

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The pack asked for Node.js 20.19, so npm installed it on Node 20 beside a core that does not support Node 20.
- Updated dependencies [[`7e5cdd4`](https://github.com/framerslab/agentos-extensions/commit/7e5cdd48f1542569451e9d48e780d5631650e942), [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93), [`2aba829`](https://github.com/framerslab/agentos-extensions/commit/2aba8297988378e2283cc853dde4bd7cc6ff70a7)]:
  - @framers/agentos-ext-account-sources@0.9.4

## 1.2.0

### Minor Changes

- [#317](https://github.com/framerslab/agentos-extensions/pull/317) [`fec044f`](https://github.com/framerslab/agentos-extensions/commit/fec044fa92b04ac4b037d84a5efa5f2a98d8396e) Thanks [@jddunn](https://github.com/jddunn)! - Every Drive call ends at one deadline over the request and the reading of its answer, `DRIVE_TIMEOUT_MS` (60 seconds) unless `timeoutMs` sets another, and at the call's signal, whatever the fetch does with the signal it is handed. `timeoutMs` is a new option of `driveFile`, `exportFile`, `downloadFile`, `driveAccount` and `GoogleDrivePickedConnector`, a whole number of milliseconds from 1 to 2,147,483,647; any other value throws a `TypeError` before any request. A call that gets no answer, or whose answer's body stops before its end, throws the new `DriveNoAnswer` with the reason `timeout`, `cancelled` or `network`, in place of the fetch's own error or the signal's reason, and its message quotes no address, token or cause; the connector throws it rather than answering any file gone. A call whose signal has already aborted throws `DriveNoAnswer` `cancelled` before any request, and the connector's `list`, `read` and `changesSince` before they check their input or ask for an access token. A body past its cap is refused at once, even when its stream never finishes cancelling. Google's `domainPolicy` refusal, which refuses the app every file of the account, is thrown from `read`, `list` and `changesSince` rather than answering each picked file `no_access`. A `changesSince` cursor that is not JSON throws the `TypeError` a cursor of another shape throws, not the parser's `SyntaxError`, and quotes nothing of the cursor.

### Patch Changes

- Updated dependencies [[`d29a2fa`](https://github.com/framerslab/agentos-extensions/commit/d29a2fae20150d2f6a78dcb51bc3fd2a3650c390)]:
  - @framers/agentos-ext-account-sources@0.8.0

## 1.1.0

### Minor Changes

- [#287](https://github.com/framerslab/agentos-extensions/pull/287) [`46a52a9`](https://github.com/framerslab/agentos-extensions/commit/46a52a9b7e45b15af539750ba8e50a3fe0adc38e) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleOAuthFlow` takes its grant's rule as an option (`grant`: the provider id, the scopes asked, `holds` or `exact` matching, the address's extra parameters), Drive's rule (`DRIVE_GRANT`) the default and its behaviour unchanged; `grantMatches` reads OpenID's short scope names as Google's long ones. The calendar pack's `./reader` exports `GoogleCalendarOAuthFlow`: one read-only calendar scope with `openid` and `email`, held exactly at the exchange and at every refresh, and the address the ID token of the token endpoint's answer names.

## 1.0.1

### Patch Changes

- [#259](https://github.com/framerslab/agentos-extensions/pull/259) [`e98356f`](https://github.com/framerslab/agentos-extensions/commit/e98356fe8a64433b5b48211a3dca2d17e1a1f60f) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleOAuthFlow` refuses an answer past its 65,536-byte cap at once, even when the answer's stream never finishes cancelling, so the cap and the 15-second deadline hold. `accessToken` checks `drive.file` on the grant its own call read in the key's turn, the one a refresh renews, and refuses a grant without it before Google is asked: calls for other keys, even keys whose grants hold the same refresh token, cannot change its outcome, and nothing of a call stays in memory after it. Once the signal has aborted it answers no token, not even one held in memory. `revoke` resolves when Google answers that the token is already expired or revoked (400 with `invalid_token`), as RFC 7009 answers an invalid token, so `forget` answers `{ revoked: true }` and an account-source lifecycle's revoke-only queue confirms the revocation instead of reporting that the person must remove the permission at Google; any other refusal throws `OAuthGrantRefused` with the status and Google's error when it is an allowlisted code. A malformed client, endpoint override, `begin` input or `complete` input throws `GoogleOAuthFault` `configuration` rather than a `TypeError`.

## 1.0.0

### Major Changes

- [#249](https://github.com/framerslab/agentos-extensions/pull/249) [`268b25a`](https://github.com/framerslab/agentos-extensions/commit/268b25aa64859e3e6ac9e7e9a4058a968bdfac9f) Thanks [@jddunn](https://github.com/jddunn)! - Bound and cancel the Google grant's calls, so an account-source lifecycle can build a flow for each grant operation, and take `@framers/agentos-ext-account-sources` as a peer.
  
  - `new GoogleOAuthFlow(client, store, { fetchImpl, signal, endpoints })`. Every call to Google's token and revocation addresses is a POST to those two addresses alone, refuses redirects, sends no credentials or referrer, reads at most 65,536 bytes of the answer and ends after 15 seconds or when the signal aborts, with a fixed `GoogleOAuthFault` reason in place of any transport error. An answer read whole is handed back even when the caller cancels meanwhile.
  - `complete` and `keep` accept a grant only with `drive.file` among its scopes, a refresh token and an unexpired access token; a refresh whose answer names scopes must still hold `drive.file`. The id token and any other field of the answer are dropped. The flow never revokes a grant on its own, since Google's revocation removes every scope the person granted the project.
  - `begin` asks for `drive.file` alone with offline access, incremental authorization and consent, and refuses another scope, an extra parameter, or a redirect address with userinfo, a query or a fragment, or over plain HTTP away from a loopback host. Stand-in endpoints are taken on CI alone, at a loopback or `.invalid` host.
  - `driveOAuthFault(error)` translates a grant failure into the `SourceSyncFault` a lifecycle acts on.
  - `@framers/agentos-ext-account-sources` 0.7.0 or later is a peer dependency in place of the `^0.1.0` dependency, so the pack throws the host's own `ReadCapExceeded` and `SourceSyncFault`. The `@framers/agentos` peer floor is 0.13.144.
  
  Breaking changes:
  
  - `GoogleOAuthFlow` takes `{ fetchImpl, signal, endpoints }` as its third argument and has no fourth. A fetch passed as the third argument throws `GoogleOAuthFault` `configuration`; endpoints go in the options.
  - Install `@framers/agentos-ext-account-sources` 0.7.0 or later and `@framers/agentos` 0.13.144 or later beside the pack.
  - Stand-in endpoints are taken only with `CI=true`, at a loopback or `.invalid` host.
  - `complete` and `keep` throw `GoogleOAuthFault` `scope` for a grant without `drive.file` and `refresh_token` for one without a refresh token; `complete` answered such a grant in 0.1.

## 0.1.2

### Patch Changes

- [#207](https://github.com/framerslab/agentos-extensions/pull/207) [`42c3d4a`](https://github.com/framerslab/agentos-extensions/commit/42c3d4a59abebe2525798a8b2b88371a25a3661e) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleDrivePickedConnector` throws `ReadCapExceeded` from `read`, `list` and `changesSince` when a file's metadata answer passes its 1 MiB cap, such as an intercepting proxy's page or a wrong `baseUrl`'s answer, rather than answering the file `removed`, so a caller keeps its copies of files that are still in Drive.

## 0.1.1

### Patch Changes

- Updated dependencies [[`03d31a2`](https://github.com/framerslab/agentos-extensions/commit/03d31a251d0d0ca3c90489a12a6901c1c38b07fc)]:
  - @framers/agentos-ext-account-sources@0.2.0

## 0.1.0

### Minor Changes

- [#204](https://github.com/framerslab/agentos-extensions/pull/204) [`6e5e004`](https://github.com/framerslab/agentos-extensions/commit/6e5e004b63515da7fa74bb46bbe7205a187eccc4) Thanks [@jddunn](https://github.com/jddunn)! - Add a library for Google Drive files a person picked: `GoogleOAuthFlow`, Google's grant for the `drive.file` scope on the auth module's `RedirectOAuthFlow` (offline access, incremental authorization, consent, revocation); Drive's calls for a file's metadata, its export or download under a byte cap, and the connected account; and `GoogleDrivePickedConnector`, an account source connector that reads picked files by id, exports Docs, Sheets and Slides as Markdown, CSV and text, downloads other files, answers a file it can no longer read as gone with its reason, and reports changes by Drive's version.
