# @framers/agentos-ext-channel-email

## 0.1.2

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.1

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Ship the compiled output. The previous version was published without its `dist` directory, so the package could not be loaded.
