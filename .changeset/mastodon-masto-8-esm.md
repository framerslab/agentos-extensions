---
'@framers/agentos-ext-channel-mastodon': minor
---

The Mastodon pack runs on masto 8 and is published as an ES module.

masto 8 is an ES module only and needs Node 22 (https://github.com/neet/masto.js/releases/tag/v8.0.0). The pack was compiled to CommonJS and loaded masto with `require()`. It is now an ES module (`"type": "module"`, with an `exports` map whose entry is `import`, as in the repo's other ES module packs), which AgentOS loads with `import()`, and it declares Node 22 in `engines`.

Two calls change with masto 8. A search goes through `v2.search.list`, which masto 7 put in place of `v2.search.fetch`; awaiting it sends the same `GET /api/v2/search` and gives the first page. `getProfile()` returns `mastodon.v1.CredentialAccount`, the name masto 8 gives `AccountCredentials`, so the published declarations name a type masto exports. A new test runs the service on the installed masto against a local server and checks the request each call sends.
