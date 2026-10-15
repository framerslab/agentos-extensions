---
'@framers/agentos-ext-google-drive': major
---

Bound and cancel the Google grant's calls, so an account-source lifecycle can build a flow for each grant operation, and take `@framers/agentos-ext-account-sources` as a peer.

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
