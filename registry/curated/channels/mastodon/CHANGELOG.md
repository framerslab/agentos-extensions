# @framers/agentos-ext-channel-mastodon

## 0.2.0

### Minor Changes

- [#164](https://github.com/framerslab/agentos-extensions/pull/164) [`62735ab`](https://github.com/framerslab/agentos-extensions/commit/62735ab6b7f5ed7a20f8cf510e5e9516b07b4614) Thanks [@dependabot](https://github.com/apps/dependabot)! - The Mastodon pack runs on masto 8 and is published as an ES module.
  
  masto 8 is an ES module only and needs Node 22 (https://github.com/neet/masto.js/releases/tag/v8.0.0). The pack was compiled to CommonJS and loaded masto with `require()`. It is now an ES module (`"type": "module"`, with an `exports` map whose entry is `import`, as in the repo's other ES module packs), which AgentOS loads with `import()`, and it declares Node 22 in `engines`.
  
  Two calls change with masto 8. A search goes through `v2.search.list`, which masto 7 put in place of `v2.search.fetch`; awaiting it sends the same `GET /api/v2/search` and gives the first page. `getProfile()` returns `mastodon.v1.CredentialAccount`, the name masto 8 gives `AccountCredentials`, so the published declarations name a type masto exports. A new test runs the service on the installed masto against a local server and checks the request each call sends.

## 0.1.3

### Patch Changes

- [#151](https://github.com/framerslab/agentos-extensions/pull/151) [`7141e7c`](https://github.com/framerslab/agentos-extensions/commit/7141e7c2d704ba1bcbea43090e865a14dcb3024c) Thanks [@jddunn](https://github.com/jddunn)! - Adds a README: installation, configuration, the tools the pack registers and what they do.

## 0.1.2

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.1

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.
