---
'@framers/agentos-ext-google-drive': minor
---

Bound and cancel the Google grant's calls, so an account-source lifecycle can build a flow for each grant operation, and take `@framers/agentos-ext-account-sources` as a peer.

- `new GoogleOAuthFlow(client, store, { fetchImpl, signal, endpoints })`. Every call to Google's token and revocation addresses is a POST to those two addresses alone, refuses redirects, sends no credentials or referrer, reads at most 65,536 bytes of the answer and ends after 15 seconds or when the signal aborts, with a fixed `GoogleOAuthFault` reason in place of any transport error. An answer read whole is handed back even when the caller cancels meanwhile.
- `complete` and `keep` accept a grant only with `drive.file` among its scopes, a refresh token and an unexpired access token; a refresh whose answer names scopes must still hold `drive.file`. The id token and any other field of the answer are dropped. The flow never revokes a grant on its own, since Google's revocation removes every scope the person granted the project.
- `begin` asks for `drive.file` alone with offline access, incremental authorization and consent, and refuses another scope, an extra parameter, or a redirect address with userinfo, a query or a fragment, or over plain HTTP away from a loopback host. Stand-in endpoints are taken on CI alone, at a loopback or `.invalid` host.
- `driveOAuthFault(error)` translates a grant failure into the `SourceSyncFault` a lifecycle acts on.
- `@framers/agentos-ext-account-sources` 0.7.0 or later is a peer dependency in place of the `^0.1.0` dependency, so the pack throws the host's own `ReadCapExceeded` and `SourceSyncFault`. The `@framers/agentos` peer floor is 0.13.144.

Breaking: pass `{ fetchImpl, endpoints }` where the fetch and the endpoints were the third and fourth arguments of `GoogleOAuthFlow`; install `@framers/agentos-ext-account-sources` 0.7.0 or later beside the pack; `complete` now refuses a grant without `drive.file` or a refresh token with `GoogleOAuthFault` (`scope`, `refresh_token`) where it answered it before.
