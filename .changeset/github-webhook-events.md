---
"@framers/agentos-ext-github": minor
---

Read a GitHub App's webhook deliveries as typed events with `readWebhookDelivery` and `readWebhookRequest`: after the size cap, the `X-Hub-Signature-256` check and the `X-GitHub-Delivery` id, a delivery is answered as a `push` (with `toDefaultBranch`), an `installation` action, the repositories an installation gains or loses, an account renamed, a `ping`, or `other`, and a refused one throws `WebhookDeliveryRefused` with its reason. Every call of the `./documents` entry now runs under a deadline (`GITHUB_TIMEOUT_MS`, `timeoutMs` in the options) and the caller's signal, a call that gets no answer throws `GitHubNoAnswer`, a JSON answer is read under a 16 MiB cap, and `GitHubApiError` carries `rateLimited` and `retryAt` from GitHub's `retry-after` and `x-ratelimit-*` headers. `changesSince` refuses a cursor it did not answer without quoting it.

Install `@framers/agentos-ext-account-sources` 0.7.0 or later beside the pack: it is a peer dependency in place of the `^0.1.0` dependency, so a host keeps one copy of it. The `@framers/agentos` peer floor rises to 0.13.144.
