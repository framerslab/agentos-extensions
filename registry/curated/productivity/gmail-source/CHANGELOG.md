# @framers/agentos-ext-gmail-source

## 0.5.0

### Minor Changes

- [#251](https://github.com/framerslab/agentos-extensions/pull/251) [`3cedbe3`](https://github.com/framerslab/agentos-extensions/commit/3cedbe3c79b47e97f60b7ab6a0b70143bd13dc5c) Thanks [@jddunn](https://github.com/jddunn)! - Add a bounded selected-id Gmail connector and durable-sync binding with private mailbox verification, expiring label snapshots and explicit connector disposal. The API clients of one sync lease can share one access token through `tokenHolder`, so a cycle refreshes the grant once, and the `@framers/agentos` peer floor rises to 0.13.146, whose HTML loader strips tags in linear time.

## 0.4.0

### Minor Changes

- [#243](https://github.com/framerslab/agentos-extensions/pull/243) [`11b0ce4`](https://github.com/framerslab/agentos-extensions/commit/11b0ce49bf30ca9550bedea855f89eb9b7937454) Thanks [@jddunn](https://github.com/jddunn)! - Add a capped read-only Gmail API client with shared grant and quota dispatch, fixed error classification, independent label-cache evidence and canonical thread mapping.

## 0.3.0

### Minor Changes

- [#240](https://github.com/framerslab/agentos-extensions/pull/240) [`16e1fb8`](https://github.com/framerslab/agentos-extensions/commit/16e1fb8c0a9e5f4053990c121d4cb4dabd493eeb) Thanks [@jddunn](https://github.com/jddunn)! - Add bounded Gmail MIME mapping with sanitized thread documents, message provenance, attachment metadata and explicit cache refusal.

## 0.2.0

### Minor Changes

- [#232](https://github.com/framerslab/agentos-extensions/pull/232) [`ddfb91f`](https://github.com/framerslab/agentos-extensions/commit/ddfb91f90ee35071c941862275a20afa1b0efb65) Thanks [@jddunn](https://github.com/jddunn)! - Add bounded pre-storage mail sanitization, allow-listed headers and conservative reply and signature trimming through public text helpers.

## 0.1.0

### Minor Changes

- [#224](https://github.com/framerslab/agentos-extensions/pull/224) [`b6aed0d`](https://github.com/framerslab/agentos-extensions/commit/b6aed0d16c244429373846d29882f810d2a3e633) Thanks [@jddunn](https://github.com/jddunn)! - Add a read-only Gmail source library with scope-checked redirect grants, fixed endpoints and bounded, cancellable OAuth responses.
