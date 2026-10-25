# @framers/agentos-extensions

## 1.0.4

### Patch Changes

- [#400](https://github.com/framerslab/agentos-extensions/pull/400) [`5dcdb2c`](https://github.com/framerslab/agentos-extensions/commit/5dcdb2c7db26733d3ee77ef84c21ba0afe48ed51) Thanks [@github-actions](https://github.com/apps/github-actions)! - `registry.json` lists every pack at the version published on npm, the Operations pack (`@framers/agentos-ext-operations`) and the Google Drive pack (`@framers/agentos-ext-google-drive`) among them.

## 1.0.3

### Patch Changes

- [`069b040`](https://github.com/framerslab/agentos-extensions/commit/069b0401a7d819d5060697dc0b7877f8f4d0a963) Thanks [@jddunn](https://github.com/jddunn)! - Add `index.mjs` wrapper so `import x from '@framers/agentos-extensions'` works on every Node version without the `with { type: 'json' }` import attribute (Node 22+) or the deprecated `assert { type: 'json' }`. The wrapper reads `registry.json` via `fs` at runtime.
