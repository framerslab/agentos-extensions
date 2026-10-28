# @framers/agentos-ext-browser-automation

Releases after 0.3.0 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-browser-automation@<version>`.

## 0.3.0

### Minor Changes

- [#37](https://github.com/framerslab/agentos-extensions/pull/37) [`6b2d5a6`](https://github.com/framerslab/agentos-extensions/commit/6b2d5a6b8a630364b100c3235244f2db49efa2cf) Thanks [@jddunn](https://github.com/jddunn)! - The attach tools gain `browser_attach_screenshot`: a PNG of the agent tab, over the CDP transport, written to a new file in the evidence directory (`~/.wunderland/attach-evidence`, or `WUNDERLAND_ATTACH_EVIDENCE_DIR`). The path is resolved inside that directory and refused when it leaves it, passes through a link, or names a file that exists; the file is created with flag `wx`, and the result gives the path written. The directory is private to the session's user (mode 0700, refused when another user can write it or change a directory above it), and it is checked again when the file is created, so a directory swapped for a link during the capture receives no image. A screenshot holds the session until its file is written, and the daemon client awaits it for its own `opTimeoutMs`. A full-page capture is cut at 16,384 CSS pixels a side. The tool has side effects, so a deny-side-effects policy gates it. The JXA transport has no screenshot. `JxaBackend.claimAgentTab` now returns the tab it already holds instead of claiming a second one.

## 0.2.1

### Patch Changes

- [#78](https://github.com/framerslab/agentos-extensions/pull/78) [`d9561f1`](https://github.com/framerslab/agentos-extensions/commit/d9561f17043bb4953732d9599fe0a2a7c387394d) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.
