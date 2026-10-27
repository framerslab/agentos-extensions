# @framers/agentos-ext-zip-files

## 0.1.4

### Patch Changes

- [#408](https://github.com/framerslab/agentos-extensions/pull/408) [`62e4bf6`](https://github.com/framerslab/agentos-extensions/commit/62e4bf603369d49cddc090bbaf3c9ab8a09bba8a) Thanks [@dependabot](https://github.com/apps/dependabot)! - The pack takes archiver 8, an ES module that exports each format's archive as a class, so it builds its zip with `new ZipArchive({ zlib: { level: 6 } })` in place of the `archiver('zip', ...)` call that archiver 7's default export answered and archiver 8 no longer has.

## 0.1.3

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The published package named no Node, so npm installed it on any release, Node 20 included, beside a core that does not support Node 20.

## 0.1.2

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.1

### Patch Changes

- [#78](https://github.com/framerslab/agentos-extensions/pull/78) [`d9561f1`](https://github.com/framerslab/agentos-extensions/commit/d9561f17043bb4953732d9599fe0a2a7c387394d) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.
