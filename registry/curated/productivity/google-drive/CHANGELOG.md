# @framers/agentos-ext-google-drive

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
