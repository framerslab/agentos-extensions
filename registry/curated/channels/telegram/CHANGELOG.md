# @framers/agentos-ext-channel-telegram

## 0.1.3

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.2

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

## 0.1.1

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Publish the fixes made in source since the last release, built against the current `@framers/agentos` peer range.
