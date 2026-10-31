# @framers/agentos-template-basic-tool

Releases after 1.1.2 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-template-basic-tool@<version>`.

## 1.1.2

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The published package named no Node, so npm installed it on any release, Node 20 included, beside a core that does not support Node 20.

## 1.1.1

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 1.1.0

### Minor Changes

- [#83](https://github.com/framerslab/agentos-extensions/pull/83) [`3858b11`](https://github.com/framerslab/agentos-extensions/commit/3858b11095c2952cb0fd5cc143028ab74e1fba76) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the template next to agentos 0.11 and later releases. The published range (`^0.5.2`) excluded them. The manifest's `agentosVersion` now states the same range (it said `^2.0.0`), and `createExtensionPack` reports the version from `package.json` instead of a hardcoded `1.0.0`.
