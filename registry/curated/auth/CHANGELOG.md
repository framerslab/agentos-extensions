# @framers/agentos-ext-auth

Releases after 1.2.2 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-auth@<version>`.

## 1.2.2

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The published package named no Node, so npm installed it on any release, Node 20 included, beside a core that does not support Node 20.

## 1.2.1

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 1.2.0

### Minor Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 1.1.0

### Minor Changes

- [`e6a2eb6`](https://github.com/framerslab/agentos-extensions/commit/e6a2eb61145c5715df63668b795fe90720a3c7c1) Thanks [@jddunn](https://github.com/jddunn)! - Initial release of AgentOS extension packages.

  - Auth: JWT authentication and subscription management
  - Anchor Providers: Solana on-chain provenance anchoring
  - Wunderland Tip Ingestion: Tip content processing pipeline
  - Web Search: Search, research aggregation, and fact-checking
  - Web Browser: Browser automation and content extraction
  - Telegram Integration: Telegram Bot API integration
  - Telegram Bot: Telegram bot communications handler
  - CLI Executor: Shell command execution and file management
