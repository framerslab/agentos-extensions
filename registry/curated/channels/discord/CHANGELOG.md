# @framers/agentos-ext-channel-discord

## 0.1.3

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.2

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.1

### Patch Changes

- [#67](https://github.com/framerslab/agentos-extensions/pull/67) [`63b66b4`](https://github.com/framerslab/agentos-extensions/commit/63b66b407433702573095a58812403ccf97bea21) Thanks [@jddunn](https://github.com/jddunn)! - Fetch trivia questions from Open Trivia DB the first time one is asked for, instead of when the module loads, so importing the pack sends no request. Declare Node.js 22 or later in `engines`, the range `@framers/agentos` requires.
