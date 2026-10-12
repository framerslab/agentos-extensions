---
'@framers/agentos-ext-channel-mastodon': minor
---

The Mastodon pack runs on masto 8 and is published as an ES module.

masto 8 is an ES module only and needs Node 22 (https://github.com/neet/masto.js/releases/tag/v8.0.0). The pack was compiled to CommonJS, so it would have loaded masto with `require()`, which Node allows without a flag only from 22.12. It is now an ES module (`"type": "module"`, with an `exports` map), which AgentOS loads with `import()` on any Node 22. A project that loads the pack with `require()` needs Node 22.12 or later. The calls the pack makes (`createRestAPIClient`, `$select`, and awaiting a list for its first page) are the same in masto 8.
