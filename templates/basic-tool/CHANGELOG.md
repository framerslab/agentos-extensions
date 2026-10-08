# @framers/agentos-template-basic-tool

## 1.1.0

### Minor Changes

- [#83](https://github.com/framerslab/agentos-extensions/pull/83) [`3858b11`](https://github.com/framerslab/agentos-extensions/commit/3858b11095c2952cb0fd5cc143028ab74e1fba76) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the template next to agentos 0.11 and later releases. The published range (`^0.5.2`) excluded them. The manifest's `agentosVersion` now states the same range (it said `^2.0.0`), and `createExtensionPack` reports the version from `package.json` instead of a hardcoded `1.0.0`.
