# @framers/agentos-ext-citation-check

Checks the quoted claims of a document against the pages they cite, with AgentOS's own citation tooling. Each page is fetched once and no search service is called. A claim whose words stand on its page is `exact`. A claim that is not is graded by AgentOS's `CitationVerifier` against the page's sentences when an embedding function is configured, and is `not_found` otherwise, shown with the sentences nearest it. Nothing that costs money runs unless you pass it in.

With `research.md`:

```markdown
The report says "The harbour opened in 1887" (https://example.org/harbour, read 1 Mar 2026).

A guide notes that "the lighthouse stands 40 metres tall" (<https://example.org/lighthouse>).
```

```bash
npx --package @framers/agentos-ext-citation-check agentos-citations verify research.md
```

prints, when the harbour page holds the first quotation word for word and the guide's page says the lighthouse stands 31 metres tall:

```text
Checked 2 claims against 2 pages on 2026-03-01T09:00:00.000Z: each claim's words were looked for on its page, and each claim not found there is shown with the page's sentences nearest it by shared words.
Verdicts: 1 exact, 1 not found. Result: fails.

| Line | Verdict | Claim | Source | What the page says |
| --- | --- | --- | --- | --- |
| 1 | exact | The harbour opened in 1887 | <https://example.org/harbour> | The harbour opened in 1887 and handled 4,200 ships in its first year. |
| 3 | not found | the lighthouse stands 40 metres tall | <https://example.org/lighthouse> | nearest (0.67): Its lighthouse stands 31 metres tall. |

Nearest passages for the claims not found:

- Line 3, "the lighthouse stands 40 metres tall":
  1. (0.67) Its lighthouse stands 31 metres tall.
```

and exits 1. The output is the markdown for a document's "Citation check log" section; it carries no heading of its own.

## Installation

```bash
npm install @framers/agentos-ext-citation-check
```

It needs Node.js 22 or later, as `@framers/agentos` does. It reads pages with [public-sources](https://www.npmjs.com/package/@framers/agentos-ext-public-sources) (`htmlToBlocks` in page mode, `citationSources` and the `SourceDocument` a page answers as, from 0.2.3), the [web scraper](https://www.npmjs.com/package/@framers/agentos-ext-web-scraper) (a browser's request headers and the fallback tiers) the `values` entry of [grounding-guard](https://www.npmjs.com/package/@framers/agentos-ext-grounding-guard) (the sentence rule and the word rules) and [entities](https://www.npmjs.com/package/entities) (the character references in a page's title, names and addresses). `@framers/agentos` 0.13.120 or later, the first release with the checked egress the tool reads pages through, is a peer, loaded only to grade with embeddings or to read pages through checked egress. Grounding-guard lists `@huggingface/transformers` as an optional dependency for its NLI model; `npm install --omit=optional` leaves it out when you do not use NLI.

## Input

A markdown document: each quotation (`"…"`, `“…”` or `„…“`) and the first http or https address after it in its sentence, in parentheses, in a markdown link, between angle brackets or bare, on the same line or a later line of the paragraph.

```markdown
The report says "The harbour opened in 1887" (https://example.org/harbour, read 1 Mar 2026).

A guide notes that "the lighthouse stands 40 metres tall" (<https://example.org/lighthouse>).

The page lists "Five berths", and "Two cranes lift the containers" (https://example.org/port).
```

Several quotations waiting in a sentence share the address that follows them, as the last line's two do. An address ends at white space or a quotation mark, without the punctuation after it and without a closing bracket it did not open, so `(https://example.org/wiki/River_(Delta), read 1 Mar 2026)` gives `https://example.org/wiki/River_(Delta)`. A quotation of four words or more that no address follows before its sentence ends is reported as uncited; a shorter one reads as a term or a title and is passed over. Quotations in fenced code and code spans, and escaped quotation marks (`\"`), are not claims.

A JSON document: an array of claims.

```json
[
  { "claim": "The harbour opened in 1887", "url": "https://example.org/harbour", "exact": true },
  { "claim": "Roughly four thousand vessels called in the first year", "url": "https://example.org/harbour", "exact": false },
  { "claim": "The tide rises twice each day" }
]
```

`url` left out or empty makes the claim uncited, and `exact`, true when left out, records whether the claim gives itself as the page's own words; the check reads every claim the same way, word for word first. An entry with no claim, a `url` that is not http or https, or an `exact` that is not a boolean is refused with the entry's number and line. `parseCitedClaims(text)` reads a document that is a JSON array as JSON and any other as markdown; `{ format: 'markdown' }` or `{ format: 'json' }` names the form.

## Verdicts

| Verdict | When |
| --- | --- |
| `exact` | The claim's words stand on the page |
| `supported` | `CitationVerifier` found a sentence at or above the support threshold (0.6 by default) |
| `weak` | The best sentence lies between the two thresholds |
| `unverifiable` | No sentence reaches the unverifiable threshold (0.3 by default) |
| `contradicted` | A `supported` claim the NLI function reads as contradicted by its sentence, with a score over 0.7 |
| `not_found` | The words are not on the page and no embedding function graded the claim |
| `unreachable` | The page could not be fetched: no answer by the deadline, no connection, a status that is not 2xx, an address the egress policy refuses, or too many redirects |
| `unreadable` | The page came but holds no text this check reads: a PDF, another binary type, a body past the size cap, or no text a reader sees |
| `uncited` | The claim cites no address |

Words are compared after both sides are read the same way: compatibility forms (NFKC), typographic quotation marks as plain ones, every dash a hyphen with no space around it, case, white space, and soft hyphens and zero-width characters. An ellipsis or words in square brackets (`[…]`, `[It]`) in a quotation are gaps: the pieces between them must stand on the page in order, all in one block of its text (a paragraph, a list item, a table cell, a caption or a quotation), so a sentence of one paragraph and a cell further down the page never pass as one quotation. A quotation without gaps may run on from one block into the next, as across a line break. A match never cuts a word or a number, so "rose to 5" does not stand in "rose to 50 percent". Each check carries the sentence its verdict rests on (for an exact quotation that runs past one sentence, its block), and a `not_found` claim the three sentences nearest it by the share of content words and numbers the two have in common.

`citationReportFails(report)` is true when a claim is `contradicted`, `not_found` or `unverifiable`, or when its page is `unreachable` or `unreadable`; `{ allowUnreachable: true }` leaves the last two out.

## The command

```text
agentos-citations verify <file> [--json] [--embeddings none|openai] [--format auto|markdown|json]
                         [--allow-unreachable] [--no-fallback] [--timeout <ms>]
```

With the pack installed, `npx agentos-citations verify <file>` runs the command; without an install, `npx --package @framers/agentos-ext-citation-check agentos-citations verify <file>` runs it, the package named so that npx does not look for a package called `agentos-citations`. `<file>` is a path, or `-` for standard input. The command prints the markdown log, or the report as JSON with `--json`. It exits 0 when the check passes, 1 when it fails, and 2 for a usage or input error. `--embeddings openai` grades the claims not found word for word with OpenAI embeddings through AgentOS's `embedText`, with `OPENAI_API_KEY` from the environment and `OPENAI_BASE_URL` when it is set; without the key it exits 2 before fetching anything. `--no-fallback` leaves out the web scraper's retry.

## In code

```ts
import { checkCitations, citationReportFails, parseCitedClaims, renderCitationLog } from '@framers/agentos-ext-citation-check';

const claims = parseCitedClaims(markdown);
const report = await checkCitations(claims, { timeoutMs: 10_000 });
const log = renderCitationLog(report); // the "Citation check log" section's body
if (citationReportFails(report)) process.exitCode = 1;
```

`checkCitationDocument(text, options)` parses and checks in one call. The report holds one check per claim, in the document's order (`line`, `claim`, `url`, `exact`, `verdict`, `grader`, `score`, `passage`, `nearest`, `note`, and `page`, the status of the page it cites, null for an uncited claim), one status per distinct page (`outcome`, `finalUrl`, `status`, `failure`, `detail`, `via`, `passages`), and a summary with the count of each verdict, the uncited claims and the pages that were not read.

### Reading pages

Each distinct address is fetched once, its fragment removed, four at a time. A request sends a browser's headers from the web scraper pack, follows redirects, and stops at the deadline (`timeoutMs`, 15,000) or past the size cap (`maxBytes`, 5,000,000). HTML and XML are read with public-sources' `htmlToBlocks` in page mode, which keeps the tables, figures, quotations and code a page shows; other text by paragraphs; a PDF or another binary type not at all. The charset comes from a byte order mark, the content type or a `<meta>` tag. A page that times out, does not connect, answers an error status other than 404 and 410, or holds no text is retried once through the web scraper's `WebScraperService`, whose tiers run a headless browser when `playwright-core` is installed and a second plain request otherwise. A page that fails is a verdict, never an exception.

| Option | Default | What it does |
| --- | --- | --- |
| `fetch` | the global `fetch` | The requests go through it; pass one that applies your egress rules |
| `egress` | none | `hosted` or `local`: read pages through AgentOS's checked egress instead (`@framers/agentos/safety/egress`, from 0.13.120) |
| `fallback` | on unless `fetch` or `egress` is given | `false`, `true`, or a scraper with `scrape(input)` |
| `timeoutMs`, `maxBytes`, `textBudget` | 15,000, 5,000,000, 300,000 | One request's deadline, a body's bytes, a page's characters of text |
| `concurrency`, `maxPages` | 4, 100 | Pages read at once; distinct pages per check, more refused before any is fetched |
| `logger` | none | AgentOS's `ILogger`: the events `citation_check.page_unreachable`, `citation_check.page_unreadable`, `citation_check.page_read_by_fallback` and `citation_check.embedding_failed`, with the page's origin and never a claim |
| `signal` | none | Cancels the check, which throws the signal's reason |

The global `fetch` reaches any address a document names. A host that checks documents from people it does not trust passes `egress: 'hosted'`, which reaches public https addresses on port 443 alone and checks every redirect, or a `fetch` of its own. The fallback's requests go through neither, so it is off once either is given unless `fallback: true` turns it on.

### The page reader

`readPage(url, options)` is the reader `checkCitations` runs, exported for a host that reads pages of its own. It answers `{ status, blocks, passages, document, pageDate }`: the page's status as above, its text blocks, its sentences as passages, the page as a public-sources `SourceDocument` (null when it was not read) and the page's own date (null when it states none). It throws only the caller's own cancellation.

```ts
import { egressTransport, readPage } from '@framers/agentos-ext-citation-check';

const transport = await egressTransport('hosted', { timeoutMs: 5_000, maxBytes: 2_000_000 }, 'ExampleReader/1.0 (https://example.org)');
const page = await readPage('https://example.org/harbour', {
  transport,
  scraper: null,
  timeoutMs: 5_000,
  maxBytes: 2_000_000,
  textBudget: 300_000,
  now: Date.now,
  allowUrl: (url) => !new URL(url).hostname.endsWith('.internal.example'),
  robots: { token: 'ExampleReader', timeoutMs: 2_000, maxBytes: 512_000, cacheMs: 600_000 },
});
if (page.document !== null) console.log(page.document.title, page.document.licence.name, page.document.publisher);
```

`fetchTransport(fetch, userAgent?)` and `egressTransport(profile, bounds, userAgent?)` build the request a page goes through. A transport takes `(url, signal, rules?)` and answers `{ status, finalUrl, header, read, readPrefix, discard }`; a host can pass one of its own.

The document's `url` and `key` are the address after redirects. Its `title` is the page's `<title>`, its character references read, its white space collapsed and cut to 255 characters, or the host when the page has none. Its `licence` is the one the page states (below), or `{ name: 'not read', url: '' }` (`UNREAD_LICENCE`) when the reader finds none. `publisher` is the site's name from `og:site_name`, else from JSON-LD `publisher.name`, cut to 255 characters and left out when the page names none. `pageDate` is the page's own date from `article:modified_time`, else JSON-LD `dateModified`, else the `Last-Modified` header, left out when none parses. The markup is read as served, in one pass in document order: a value a script writes later is not seen, a tag or a JSON-LD block inside a comment is passed over, the content of a script, a style, a template, a `noscript` and a `textarea` is not read for tags, and the time grows with the page alone however its tags are left open.

#### The host's rule and robots.txt, on every hop

`allowUrl(url)` is the host's rule for an address. `robots` reads robots.txt by [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) with the host's product token. Given either, the reader checks the first address before it is requested, and both transports check every redirect target before its request, following up to five redirects one at a time. A refused address ends the page as `unreachable` with `failure: 'refused'` and `detail: 'host'` or `detail: 'robots'`, and is never requested. The host's rule is asked once an address. The web scraper's retry is not used under either rule, since its requests go through neither. A transport called with the rules applies them the same way, so an image or an icon read through it obeys them on every hop and throws `PageRefusal` for one they refuse.

robots.txt is the file at the address's origin, read through the same transport with the host's rule on its own hops, under its own deadline (`timeoutMs`). The reader parses its first `maxBytes` bytes and ignores the rest along with the line the limit cuts; RFC 9309 sets that limit's floor at 500 KiB (`ROBOTS_PARSING_FLOOR`, 512,000 bytes). Groups are matched by product token without case, the `*` group when none names the token, and two groups for the token are read as one. The longest matching `Allow` or `Disallow` decides, an `Allow` over a `Disallow` of the same length; `*` matches any run of characters, a final `$` the end of the path and query, and paths are compared with their percent-encoding made one form. A 400-range answer allows every page. A 500-range answer, a failed request, a passed deadline or a hop the host's rule refuses disallows every page, as the RFC's sections 2.3.1.3 and 2.3.1.4 say. A file past five redirects is taken as unavailable and allows every page. Each origin's answer is kept for `cacheMs` per transport and parsing limit; an answer the host's rule decided, by refusing a hop of the file, is not kept, since the next read may be under another rule. Wildcards are matched piece by piece, so the time grows with the pattern and the path and not with the ways to split them. `readRobots(url, options)`, `robotsAllows(file, token, url)` and `parseRobots(text)` are exported.

#### The licence a page states

`readLicence(html, baseUrl)` reads, in this order: a `<link rel="license" href>`, an `<a rel="license" href>`, a JSON-LD `license` (an address, or an object with its `url` and `name`), then any anchor to a Creative Commons deed (`creativecommons.org/licenses/<code>/<version>`) or public domain tool (`creativecommons.org/publicdomain/`) anywhere in the page, a footer's included. A deed is named from its address (`CC BY-SA 4.0`, `CC BY 3.0 US`, `CC0 1.0`, `Public Domain Mark 1.0`); another address is named by the anchor's text, the link's `title` or the JSON-LD `name`, else by the address. The address is the one the page gives, resolved against the page's own. A licence written in prose with no address is not read, so "not read" means the reader found none, not that the page states none.

#### A page with no text

`fallback`, a `PageFallbackReader` with `read(url, { signal })` answering text blocks or null, reads a page that answered 200 with no text a reader sees, such as one a script draws. It is called once, for the page's address after its redirects, with the caller's signal, and keeps its own deadline; its blocks are held to `textBudget`, and the document keeps the page's own title, licence, publisher and date. With no fallback, or when it answers null or fails, the page is `unreadable` with `failure: 'no_text'`.

### The open web as a public source

`WebPageSourceProvider` is a public-sources `PublicSourceProvider` over the open web. The host gives the search, so the pack calls no search service of its own:

```ts
import { WebPageSourceProvider } from '@framers/agentos-ext-citation-check';

const web = new WebPageSourceProvider({
  search: async (phrase, signal) => mySearch(phrase, signal), // page addresses, best first
  userAgent: 'ExampleReader/1.0 (https://example.org)',
  robots: { token: 'ExampleReader', timeoutMs: 2_000, maxBytes: 512_000, cacheMs: 600_000 },
  allowUrl: (url, phrase) => myHostRule(url, phrase), // false refuses the address before it is requested
  timeoutMs: 5_000,
  maxBytes: 2_000_000,
});

const found = await web.search('harbour opening year', { limit: 3, onSend: () => quota.take() });
if (found.kind === 'hits') {
  for (const hit of found.hits) {
    const read = await web.read(hit, { signal: AbortSignal.timeout(10_000) });
    if (read.kind === 'document') console.log(read.document.site, read.document.title, read.document.licence.name);
  }
}
```

`search(phrase, { limit, signal, onSend })` awaits `onSend` once, then runs the host's search, and answers its addresses as hits: `key` the address without its fragment, `title` the address, each page once, at most `limit` (3 when left out), an address that is not http or https passed over. It answers `limited` when `onSend` throws a limiter's refusal, and `failed` when `onSend` throws anything else or the search throws.

`read(hit, { signal })` reads the page and answers `{ kind: 'document', document }`, with `site` the host without a leading "www.", `revision` null, `readAt` the clock's, and the title, licence, publisher and date as read; or `{ kind: 'skipped', status }` for a page that was not read, with its HTTP status when one came. `allowUrl(url, phrase)` is called on every address and redirect target with the phrase whose search answered the hit read, held by the hit object itself, so pass the hits as `search` answered them: a hit object this provider's search did not answer, a copy of one included, reads with the empty string. robots.txt is read with `robots`, or with `DEFAULT_ROBOTS` (the `*` group, 2,000 ms, 512,000 bytes, ten minutes kept) when left out, and not at all with `robots: null`. Pages go through AgentOS's checked egress (`egress`, `hosted` by default) unless `transport` is given, with no scraper fallback, since the scraper's requests bypass both; `fallback` reads a page with no text. The provider queues nothing: the host reads at most as many pages at once as it calls `read` for. The caller's own cancellation is thrown.

### Grading with embeddings

```ts
import { checkCitations, managerEmbeddings, openAIEmbeddings } from '@framers/agentos-ext-citation-check';

// OpenAI through AgentOS's embedText; billed by OpenAI.
await checkCitations(claims, { embedFn: openAIEmbeddings({ apiKey: process.env.OPENAI_API_KEY }) });

// An embedding manager the host already runs, such as AgentOS's EmbeddingManager.
await checkCitations(claims, { embedFn: managerEmbeddings(embeddingManager, { modelId: 'text-embedding-3-small' }) });
```

The claims of one page that are not on it word for word are graded in one `CitationVerifier.verify` call against the page's sentences (`maxPassages`, 2,000, in page order), which embeds them in one batch. `supportThreshold` and `unverifiableThreshold` pass through to the verifier. An `nliFn`, such as grounding-guard's `createNliFunction()`, lets the verifier turn a `supported` claim its sentence contradicts into `contradicted`; it downloads and runs its model locally. When the embedding function fails, the page's claims are graded by shared words, and each check's `note` says why.

## The tool

The pack's one tool, `citation_verify`, takes `{ document, format?, allowUnreachable? }` and answers `{ fails, log, report }`. A document the parser cannot read, or arguments of the wrong type, answer `success: false` with the reason.

```ts
import { createExtensionPack } from '@framers/agentos-ext-citation-check';

const pack = createExtensionPack({ options: { embeddings: 'openai' }, getSecret: (id) => secrets[id] });
```

The tool reads pages through AgentOS's checked egress with the hosted policy, so a document cannot point it at a private address; it needs AgentOS 0.13.120 or later. Pack options: `embeddings` (`none` or `openai`, the key from the `openai.apiKey` secret or `OPENAI_API_KEY`), `embeddingModel`, `egress` (`hosted` or `local`), and from code `fetch`, `embedFn` and `nliFn`, with `timeoutMs`, `maxBytes`, `maxPages` and `priority`.

## API

| Export | What it is |
| --- | --- |
| `parseCitedClaims(text, { format })`, `CitationInputError` | The claims of a markdown or JSON document, with their lines; the error for a document it cannot read |
| `checkCitations(claims, options)`, `checkCitationDocument(text, options)`, `CitationSetupError` | The check, and the error for settings it cannot run with |
| `renderCitationLog(report, { allowUnreachable })`, `citationReportFails(report, { allowUnreachable })`, `FAILING_VERDICTS` | The markdown log and the result |
| `openAIEmbeddings(options)`, `managerEmbeddings(manager, request)` | Embedding functions from AgentOS's `embedText` and from an embedding manager |
| `normalizeForMatch`, `quoteFragments`, `locateQuote`, `lexicalNearest`, `withoutInvisible` | The classical checks the runner uses |
| `CitationVerifyTool`, `createExtensionPack` | The `citation_verify` tool and the pack |
| `runCitationCli(argv, io)`, `CITATION_CLI_USAGE` | The command, for a host that runs it in its own process |
| `CITATION_VERDICTS`, `pageKey`, `isHttpUrl` | The verdicts in order, a page's address without its fragment, the address check |
| `readPage(url, options)`, `fetchTransport(fetch, userAgent)`, `egressTransport(profile, bounds, userAgent)`, `PageRefusal`, `UNREAD_LICENCE` | The page reader, its two transports, a transport's refusal, the licence of a page that states none |
| `readRobots(url, options)`, `robotsAllows(file, token, url)`, `parseRobots(text)`, `ROBOTS_PARSING_FLOOR` | robots.txt read through a transport, its answer for an address, its parser, RFC 9309's parsing floor |
| `readLicence(html, baseUrl)` | The licence a page's markup states |
| `WebPageSourceProvider`, `DEFAULT_ROBOTS` | The open web as a public source over the host's search, and its robots.txt rule when none is given |
| `CitedClaim`, `CitationCheck`, `CitationVerdict`, `CitationPassage`, `PageStatus`, `PageFailure`, `CitationReport`, `CitationSummary`, `CitationCheckOptions`, `CitationLogger`, `EmbedFn`, `NliFn`, `PageReaderOptions`, `PageRead`, `PageFallbackReader`, `Transport`, `TransportAnswer`, `TransportRules`, `RobotsRule`, `RobotsFile`, `WebPageSourceOptions` and the rest | The types |

## License

Apache-2.0
