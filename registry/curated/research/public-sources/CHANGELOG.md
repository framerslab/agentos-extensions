# @framers/agentos-ext-public-sources

## 0.2.1

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The pack asked for Node.js 20.19, so npm installed it on Node 20 beside a core that does not support Node 20.

## 0.2.0

### Minor Changes

- [#246](https://github.com/framerslab/agentos-extensions/pull/246) [`56bd9a6`](https://github.com/framerslab/agentos-extensions/commit/56bd9a66b6ee7ce2cb8f9a3685d523deafa1bb4d) Thanks [@jddunn](https://github.com/jddunn)! - `htmlToBlocks(html, { mode: 'page' })` reads any page a citation names: it keeps the tables, figures, quotations, code and notes the page shows, each table cell, caption, quotation and code block a block of its own, and drops the page's own title, scripts, styles, templates, inline SVG, mathematics, hidden elements and Wikipedia's furniture. The article mode, the default, is unchanged.

## 0.1.0

### Minor Changes

- [#104](https://github.com/framerslab/agentos-extensions/pull/104) [`961b366`](https://github.com/framerslab/agentos-extensions/commit/961b366ef1eed2ff10988f2a329b5713cceb5e8a) Thanks [@jddunn](https://github.com/jddunn)! - A public-source library for citation checks: `PublicSourceProvider`, English Wikipedia's provider (REST search by topic phrase, page HTML by key, reference markers removed, one limiter with Retry-After, the policy's User-Agent, size caps and a deadline) and `citationSources(document, cut)`, with CC BY-SA 4.0 on every passage.

### Patch Changes

- [#113](https://github.com/framerslab/agentos-extensions/pull/113) [`8557785`](https://github.com/framerslab/agentos-extensions/commit/8557785d802a035686efccee6127634e1c591538) Thanks [@jddunn](https://github.com/jddunn)! - Wikipedia's provider: a served page's own title no longer becomes a block and a passage; a search's start is stamped when it is sent, after the caller's `onSend`, so a search that `onSend` refuses spends none of the limiter's minute and a slow `onSend` never brings two requests closer than 250 ms; after `onSend` has run, a block that came meanwhile, or a spacing that would take the wait past the limiter's `waitMs`, ends the search as `limited` with nothing sent; a phrase or a key no address can carry answers `failed` or `skipped` without a request instead of throwing; the text budget never cuts a character in two.
