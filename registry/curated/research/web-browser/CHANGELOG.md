# @framers/agentos-ext-web-browser

## 1.3.0

### Minor Changes

- [#77](https://github.com/framerslab/agentos-extensions/pull/77) [`91fd410`](https://github.com/framerslab/agentos-extensions/commit/91fd4108cca945cdb37cb541b1d88e68454f76a1) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

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
