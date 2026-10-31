# @framers/agentos-ext-notion

Releases after 0.1.0 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-notion@<version>`.

## 0.1.0

### Minor Changes

- [#439](https://github.com/framerslab/agentos-extensions/pull/439) [`b523108`](https://github.com/framerslab/agentos-extensions/commit/b52310835f299908aa535b4c6a59cc41c756d2ea) Thanks [@jddunn](https://github.com/jddunn)! - The first release of the Notion library: a public connection's OAuth on the core's redirect flow (the person as owner, HTTP Basic and JSON at the token address, the refresh token Notion rotates kept through the host's store, revocation of the access token a renewal gives), and pages written as typed plain-text blocks, a private page at the workspace level unless a parent page is given, planned inside Notion's request limits before any call, with Notion's refusals answered as fixed reasons.
