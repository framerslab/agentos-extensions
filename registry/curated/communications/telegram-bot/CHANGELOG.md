# @framers/agentos-ext-telegram-bot

## 1.2.1

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 1.2.0

### Minor Changes

- [#77](https://github.com/framerslab/agentos-extensions/pull/77) [`91fd410`](https://github.com/framerslab/agentos-extensions/commit/91fd4108cca945cdb37cb541b1d88e68454f76a1) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 1.1.1

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

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
