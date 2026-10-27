# @framers/agentos-ext-citation-check

## 0.1.3

### Patch Changes

- [#415](https://github.com/framerslab/agentos-extensions/pull/415) [`58e3a2a`](https://github.com/framerslab/agentos-extensions/commit/58e3a2a653cec95113f6c47f5b3bd22c64f095c3) Thanks [@jddunn](https://github.com/jddunn)! - citation-check takes `@framers/agentos-ext-grounding-guard` from `^0.9.0` and account-sources takes `@framers/sql-storage-adapter` from `^0.8.3`, the releases the weekly bump pins. grounding-guard 0.9.0 declares the same `@framers/agentos` peer floor as 0.8.1 (`>=0.12.0`), so citation-check's peer range is unchanged.

## 0.1.2

### Patch Changes

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The pack asked for Node.js 20.19, so npm installed it on Node 20 beside a core that does not support Node 20.
- Updated dependencies [[`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93), [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93)]:
  - @framers/agentos-ext-web-scraper@0.1.4
  - @framers/agentos-ext-public-sources@0.2.1

## 0.1.1

### Patch Changes

- [#253](https://github.com/framerslab/agentos-extensions/pull/253) [`52afc73`](https://github.com/framerslab/agentos-extensions/commit/52afc73e2d9d9a40f39d3815a6bf17d5d2d3190e) Thanks [@jddunn](https://github.com/jddunn)! - The `@framers/agentos` peer floor, and the manifest's `agentosVersion`, are 0.13.120: the first release with the checked egress (`@framers/agentos/safety/egress`) the `citation_verify` tool reads pages through by default. On an older AgentOS the tool could not read a page without a `fetch` from the host.

- [#252](https://github.com/framerslab/agentos-extensions/pull/252) [`7672b7a`](https://github.com/framerslab/agentos-extensions/commit/7672b7a5b4730944c9a6c7fe35d4fb6ba6408d3c) Thanks [@jddunn](https://github.com/jddunn)! - A quotation with gaps (an ellipsis or a bracketed insertion) is `exact` only when all its pieces stand in one block of the page: a paragraph, a list item, a table cell, a caption or a quotation. A sentence of one paragraph and a table cell further down the page no longer pass as one quotation. When an exact quotation's pieces run past one sentence, its passage is their block.

## 0.1.0

### Minor Changes

- [#246](https://github.com/framerslab/agentos-extensions/pull/246) [`56bd9a6`](https://github.com/framerslab/agentos-extensions/commit/56bd9a66b6ee7ce2cb8f9a3685d523deafa1bb4d) Thanks [@jddunn](https://github.com/jddunn)! - A new pack that checks the quoted claims of a document against the pages they cite, with no search service: `parseCitedClaims` reads markdown quotations followed by their addresses, or a JSON array of `{ claim, url, exact }`, with line numbers and uncited claims; `checkCitations` fetches each page once (Node's fetch or AgentOS's checked egress, a deadline, a size cap and the web scraper's tiers as the fallback), finds a claim's words on its page first, then grades the rest with AgentOS's `CitationVerifier` when an embedding function is given, or shows the nearest sentences, each check with the status of the page it cites; `renderCitationLog` writes the markdown for a "Citation check log" section. It ships the `citation_verify` tool and the `agentos-citations verify` command, with OpenAI embeddings through AgentOS's `embedText` behind `--embeddings openai`.

### Patch Changes

- Updated dependencies [[`56bd9a6`](https://github.com/framerslab/agentos-extensions/commit/56bd9a66b6ee7ce2cb8f9a3685d523deafa1bb4d)]:
  - @framers/agentos-ext-public-sources@0.2.0
