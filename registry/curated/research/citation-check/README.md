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

It needs Node.js 22 or later, as `@framers/agentos` does. It reads pages with [public-sources](https://www.npmjs.com/package/@framers/agentos-ext-public-sources) (`htmlToBlocks` in page mode, `citationSources`, the `SourceDocument` a page answers as and `kindOfHost`, from 0.3.0), the [web scraper](https://www.npmjs.com/package/@framers/agentos-ext-web-scraper) (a browser's request headers and the fallback tiers) the `values` entry of [grounding-guard](https://www.npmjs.com/package/@framers/agentos-ext-grounding-guard) (the sentence rule and the word rules) and [entities](https://www.npmjs.com/package/entities) (the character references in a page's title, names and addresses). `@framers/agentos` 0.13.120 or later, the first release with the checked egress the tool reads pages through, is a peer, loaded only to grade with embeddings or to read pages through checked egress. Grounding-guard lists `@huggingface/transformers` as an optional dependency for its NLI model; `npm install --omit=optional` leaves it out when you do not use NLI.

## Input

A markdown document: each quotation (`"…"`, `“…”` or `„…“`) and the first http or https address after it in its sentence, in parentheses, in a markdown link, between angle brackets or bare, on the same line or a later line of the paragraph.

```markdown
The report says "The harbour opened in 1887" (https://example.org/harbour, read 1 Mar 2026).

A guide notes that "the lighthouse stands 40 metres tall" (<https://example.org/lighthouse>).

The page lists "Five berths", and "Two cranes lift the containers" (https://example.org/port).
```

Several quotations waiting in a sentence share the address that follows them, as the last line's two do. An address ends at white space or a quotation mark, without the punctuation after it and without a closing bracket it did not open, so `(https://example.org/wiki/River_(Delta), read 1 Mar 2026)` gives `https://example.org/wiki/River_(Delta)`. A quotation of four words or more that no address follows before its sentence ends is reported as uncited; a shorter one reads as a term or a title and is passed over. Quotations in fenced code and code spans, escaped quotation marks (`\"`) and a markdown link's title (`[the log](https://example.org/log "Title")`) are not claims. A quotation's paired emphasis marks (`*only*`, `_only_`, `**only**`), across a line break too, and backticks are removed from its words; an unpaired mark (`2*3`, `char*`), an underscore inside a word (`snake_case`) and the marks inside a code span (`` `*cat*` `` reads `*cat*`) stay.

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

Words are compared after both sides are read the same way: compatibility forms (NFKC), typographic quotation marks as plain ones, every dash a hyphen with no space around it (except one with white space after it before a digit, which keeps that space, so in "opened in 1887 — 4,200 ships" the number reads with no minus sign), case, white space, and soft hyphens and zero-width characters. An ellipsis or words in square brackets (`[…]`, `[It]`) in a quotation are gaps: the pieces between them must stand on the page in order, all in one block of its text (a paragraph, a list item, a table cell, a caption or a quotation), so a sentence of one paragraph and a cell further down the page never pass as one quotation. A quotation without gaps may run on from one block into the next, as across a line break. A match never cuts a word or a number, so "rose to 5" does not stand in "rose to 50 percent". Each check carries the sentence its verdict rests on (for an exact quotation that runs past one sentence, its block), and a `not_found` claim the three sentences nearest it by the share of content words and numbers the two have in common.

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

Each distinct address is fetched once, its fragment removed, four at a time. A request sends a browser's headers from the web scraper pack, follows up to five redirects (a sixth is the failure `redirects`), and stops at the deadline (`timeoutMs`, 15,000) or past the size cap (`maxBytes`, 5,000,000). HTML and XML are read with public-sources' `htmlToBlocks` in page mode, which keeps the tables, figures, quotations and code a page shows; other text by paragraphs; a PDF or another binary type not at all. The charset comes from a byte order mark, the content type or a `<meta>` tag; a body with no content type is read by its first bytes, a UTF-16 one after its byte order mark. A page that times out, does not connect, answers an error status other than 404 and 410, or holds no text is retried once through the web scraper's `WebScraperService`, whose tiers run a headless browser when `playwright-core` is installed and a second plain request otherwise. A page that fails is a verdict, never an exception.

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

`fetchTransport(fetch, userAgent?)` and `egressTransport(profile, bounds, userAgent?)` build the request a page goes through. A transport takes `(url, signal, rules?, limits?)` and answers `{ status, finalUrl, header, read, readPrefix, discard }`; a host can pass one of its own. `limits.maxBytes` is the most of the body the caller will read: the checked egress, which otherwise downloads the body before `read`, then reads the answer's headers first, skips a redirect's body and refuses any other body past that as it arrives, so an icon's read stops at `iconMaxBytes` whatever the page's own cap; a transport that streams the body in `read(cap)` needs nothing more.

The document's `url` and `key` are the address after redirects. Its `title` is the page's `<title>`, its character references read, its white space collapsed and cut to 255 characters, or the host when the page has none. Its `licence` is the one the page states (below), or `{ name: 'not read', url: '' }` (`UNREAD_LICENCE`) when the reader finds none. `publisher` is the site's name from `og:site_name`, else from JSON-LD `publisher.name`, cut to 255 characters and left out when the page names none. `pageDate` is the page's own date from `article:modified_time`, else JSON-LD `dateModified`, else the `Last-Modified` header, left out when none parses. The markup is read as served, in one pass in document order: a value a script writes later is not seen, a tag or a JSON-LD block inside a comment is passed over, the content of a script, a style, a template, a `noscript` and a `textarea` is not read for tags, and the time grows with the page alone however its tags are left open. Of the links and anchors the pass keeps only those a licence is read from, at most 1,000 of each kind, and the first 32 `<link>`s whose `rel` names `icon`, and reads the text of a `rel="license"` anchor alone, so a page of a million other anchors holds none of them.

#### The page's icon

With `icon: true`, `readPage` reads the page's icon once its text is read, with one more request, to the page's own origin after its redirects: the first `<link rel="icon">` (or `rel="shortcut icon"`) whose address is at that origin, an SVG passed over (by its `type`, `image/svg+xml`, or an address ending in `.svg`), since it could not be kept, else that origin's `/favicon.ico`. A declared icon at another host is never requested. The request goes through the same transport, under `allowUrl` and `robots`, every redirect held to the page's origin, under a deadline of its own, `timeoutMs`, as each request has, so the icon can add up to `timeoutMs` to the page's read; at most `iconMaxBytes` (65,536) are read. A PNG, ICO, JPEG or WebP, told by its first bytes and served under an image type, a generic binary type or none, whose data address holds at most 8,192 characters, is kept as `icon` on the document and on each passage (`data:image/png;base64,...`). Any other answer, a refusal or a failure leaves `icon` out and the page is read as it is. No icon is read when `icon` is left out.

#### The host's rule and robots.txt, on every hop

`allowUrl(url)` is the host's rule for an address. `robots` reads robots.txt by [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) with the host's product token. Given either, the reader checks the first address before it is requested, and both transports check every redirect target before its request, following up to five redirects one at a time. A refused address ends the page as `unreachable` with `failure: 'refused'` and `detail: 'host'` or `detail: 'robots'`, and is never requested. A redirect to an address that is not http or https, such as a `data:` address, ends the page with `detail: 'scheme'`, as `fetch` itself ends one. The host's rule is asked once an address. The web scraper's retry is not used under either rule, since its requests go through neither. A transport called with the rules applies them the same way, so an image or an icon read through it obeys them on every hop and throws `PageRefusal` for one they refuse.

robots.txt is the file at the address's origin, read through the same transport with the host's rule on its own hops, under its own deadline (`timeoutMs`). The reader parses its first `maxBytes` bytes and ignores the rest along with the line the limit cuts; RFC 9309 sets that limit's floor at 500 KiB (`ROBOTS_PARSING_FLOOR`, 512,000 bytes). Groups are matched by product token without case, the `*` group when none names the token, and two groups for the token are read as one. The longest matching `Allow` or `Disallow` decides, an `Allow` over a `Disallow` of the same length; `*` matches any run of characters, a final `$` the end of the path and query, and paths are compared with their percent-encoding made one form. A 400-range answer allows every page. A 500-range answer, a failed request, a passed deadline or a hop the host's rule refuses disallows every page, as the RFC's sections 2.3.1.3 and 2.3.1.4 say. A refusal of the egress policy, for the file's address or a hop of it, is the policy's answer and not the site's: the page ends with the policy's reason, such as `detail: 'scheme'` for an http address under `hosted`, as the same read with no robots rule does, and nothing is kept for it. A file past five redirects is taken as unavailable and allows every page. Each origin's answer is kept for `cacheMs` per transport and parsing limit; an answer the host's rule decided, by refusing a hop of the file, is not kept, since the next read may be under another rule. Wildcards are matched piece by piece, so the time grows with the pattern and the path and not with the ways to split them. `readRobots(url, options)`, `robotsAllows(file, token, url)` and `parseRobots(text)` are exported.

#### The licence a page states

`readLicence(html, baseUrl)` reads, in this order: a `<link rel="license" href>`, an `<a rel="license" href>`, a JSON-LD `license` (an address, or an object with its `url` and `name`), then any anchor to a Creative Commons deed (`creativecommons.org/licenses/<code>/<version>`) or public domain tool (`creativecommons.org/publicdomain/zero/<version>`, `creativecommons.org/publicdomain/mark/<version>`) anywhere in the page, a footer's included; another page of Creative Commons' site is not a licence. A deed is named from its address (`CC BY-SA 4.0`, `CC BY 3.0 US`, `CC0 1.0`, `Public Domain Mark 1.0`); another address is named by the anchor's text, the link's `title` or the JSON-LD `name`, else by the address. The address is the one the page gives, resolved against the page's own. A licence written in prose with no address is not read, so "not read" means the reader found none, not that the page states none. The first 1,000 of each kind are read: links marked `rel="license"`, anchors marked so, and anchors to Creative Commons' site.

#### A page with no text

`fallback`, a `PageFallbackReader` with `read(url, { signal })` answering text blocks or null, reads a page that answered 200 with no text a reader sees, such as one a script draws. It is called once, for the page's address after its redirects, with the caller's signal, and keeps its own deadline; its blocks are held to `textBudget`, and the document keeps the page's own title, licence, publisher and date. With no fallback, or when it answers null or fails, the page is `unreadable` with `failure: 'no_text'`. A fallback that requests the page itself, such as a rendering service, does so outside the host's rule and robots.txt: the reader asks it only for an address its own request reached under them.

#### Firecrawl as the fallback

`FirecrawlPageReader` is a `PageFallbackReader` over [Firecrawl's scrape endpoint](https://docs.firecrawl.dev/api-reference/endpoint/scrape), with the host's key:

```ts
import { FirecrawlPageReader, readPage } from '@framers/agentos-ext-citation-check';

const fallback = new FirecrawlPageReader({
  apiKey: process.env.FIRECRAWL_API_KEY!, // sent in the Authorization header, never logged or shown
  timeoutMs: 5_000,
  maxBytes: 2_000_000,
  textBudget: 300_000,
});
const page = await readPage('https://example.org/app', { transport, scraper: null, timeoutMs: 5_000, maxBytes: 2_000_000, textBudget: 300_000, now: Date.now, fallback });
```

Each page it reads costs one request, `POST https://api.firecrawl.dev/v2/scrape` (`FIRECRAWL_SCRAPE_URL`, or `url` when given), whose body is the page's address with the format and the deadline asked for, `{ url, formats: ['html'], onlyMainContent: false, maxAge: 0, timeout }`, and nothing else of the page or of the search that found it: no title, phrase or sentence. Firecrawl counts it as one credit ([pricing](https://www.firecrawl.dev/pricing)), so the reader runs only when the reader's own request found no text. `maxAge: 0` asks for a fresh scrape: Firecrawl answers a cached copy up to two days old when it is left out, and the page's `readAt` is the reader's clock. The key goes in the `Authorization` header to that endpoint alone: `url` is an https address, or plain http to the loopback address for a stand-in in a test, a redirect of the endpoint is not followed, and the key stays out of the reader's JSON, its inspected form and every error it throws. The page's cleaned HTML is read the way the reader reads its own fetches, the whole page with its tables and notes, and its text is held to `textBudget`.

The request and its answer's body share one deadline, `timeoutMs`; Firecrawl is asked to stop its own work at the same bound, held to the 1,000 to 300,000 milliseconds it takes. An answer over `maxBytes`, by its declared length or as it streams, is refused. `read` answers null for an error status (402 for no credits, 429, 500 and the rest), an answer that is not a scrape's, a failed scrape, a page that answered an error status to Firecrawl, a page Firecrawl ended on at another origin than the address asked for (its `metadata.url`, where Firecrawl's own redirects ended), an answer with no text, and the deadline; the page is then `unreadable` with `failure: 'no_text'`. The caller's cancellation ends the request and is thrown. `fetchFn` sends the request through a `fetch` of the host's; the request and its body are raced against the deadline and the caller's signal, so a `fetch` that does not watch the signal, or a body that stalls after its headers, still ends with them, and a body is cancelled without waiting for the cancel to settle.

### The open web as a public source

`WebPageSourceProvider` is a public-sources `PublicSourceProvider` over the open web. The host gives the search, so the pack calls no search service of its own:

```ts
import { WebPageSourceProvider } from '@framers/agentos-ext-citation-check';

const web = new WebPageSourceProvider({
  search: async (phrase, signal) => mySearch(phrase, signal), // pages, best first: an address, or { url, foundThrough }
  userAgent: 'ExampleReader/1.0 (https://example.org)',
  robots: { token: 'ExampleReader', timeoutMs: 2_000, maxBytes: 512_000, cacheMs: 600_000 },
  allowUrl: (url, phrase) => myHostRule(url, phrase), // false refuses the address before it is requested
  timeoutMs: 5_000,
  maxBytes: 2_000_000,
  icon: true, // each page's icon, from its own origin
});

const found = await web.search('harbour opening year', { limit: 3, onSend: () => quota.take() });
if (found.kind === 'hits') {
  for (const hit of found.hits) {
    const read = await web.read(hit, { signal: AbortSignal.timeout(10_000) });
    if (read.kind === 'document') console.log(read.document.site, read.document.title, read.document.licence.name);
  }
}
```

`search(phrase, { limit, signal, onSend })` throws a cancellation that came first, then awaits `onSend` once and runs the host's search, and answers its addresses as hits: `key` the address without its fragment, `title` the address, each page once, at most `limit` (3 when left out), an address that is not http or https passed over. It answers `limited` when `onSend` throws a limiter's refusal, and `failed` when `onSend` throws anything else or the search throws.

The host's search answers each page as its address, or as `{ url, foundThrough }` (`WebSearchAnswer`) with the provider words that found it, in the order the search named its providers. web-search's `multiSearch` names them `providers`, so its `results` can be answered as they come: `providers` is read when `foundThrough` is left out. Words that are not source words (public-sources' `isSourceWord`) are left out, and a page found at two forms of its address that share a key keeps the finders of both, each once, in the order they came.

`read(hit, { signal })` reads the page and answers `{ kind: 'document', document }`, with `site` the host without a leading "www.", `revision` null, `readAt` the clock's, the title, licence, publisher and date as read, `kind` by public-sources' `kindOfHost` from the site (`kindOverrides`, the host's own reading by host name, first), for a hit the search found with providers named `foundThrough` and `provider` (the first of them), and with `icon: true` the page's `icon` as `readPage` reads it; or `{ kind: 'skipped', status }` for a page that was not read, with its HTTP status when one came. `allowUrl(url, phrase)` is called on every address and redirect target with the phrase whose search answered the hit read, held by the hit object itself, so pass the hits as `search` answered them: a hit object this provider's search did not answer, a copy of one included, reads with the empty string. robots.txt is read with `robots`, or with `DEFAULT_ROBOTS` (the `*` group, 2,000 ms, 512,000 bytes, ten minutes kept) when left out, and not at all with `robots: null`. Pages go through AgentOS's checked egress (`egress`, `hosted` by default) unless `transport` is given, with no scraper fallback, since the scraper's requests bypass both; `fallback`, such as `FirecrawlPageReader`, reads a page with no text. The provider queues nothing: the host reads at most as many pages at once as it calls `read` for. The caller's own cancellation is thrown.

### Grading with embeddings

```ts
import { checkCitations, managerEmbeddings, openAIEmbeddings } from '@framers/agentos-ext-citation-check';

// OpenAI through AgentOS's embedText; billed by OpenAI.
await checkCitations(claims, { embedFn: openAIEmbeddings({ apiKey: process.env.OPENAI_API_KEY }) });

// An embedding manager the host already runs, such as AgentOS's EmbeddingManager.
await checkCitations(claims, { embedFn: managerEmbeddings(embeddingManager, { modelId: 'text-embedding-3-small' }) });
```

The claims of one page that are not on it word for word are graded in one `CitationVerifier.verify` call against the page's sentences (`maxPassages`, 2,000, in page order), which embeds them in one batch. `supportThreshold` and `unverifiableThreshold` pass through to the verifier. An `nliFn`, such as grounding-guard's `createNliFunction()`, lets the verifier turn a `supported` claim its sentence contradicts into `contradicted`; it downloads and runs its model locally. When the embedding function fails, the page's claims are graded by shared words, and each check's `note` says why.

### Checking a spoken claim

`ClaimChecker` checks one claim heard in a room against sentences from any source: an encyclopedia article, a web page, a paper's abstract, a person's own notes or documents. The host gives the passages (from public-sources' providers, `WebPageSourceProvider`, its own library), its embeddings call and a judge; the checker decides what may be shown.

```ts
import { embedText } from '@framers/agentos';
import { ClaimChecker, claimJudge, type ClaimPassage } from '@framers/agentos-ext-citation-check';
import { ValueAgreementChecker } from '@framers/agentos-ext-grounding-guard';

const checker = new ClaimChecker({
  // One batch: a vector a text, in order, and the tokens the call used.
  embed: async (texts, signal) => {
    const { embeddings, usage } = await embedText({ provider: 'openai', input: texts, apiKey, abortSignal: signal });
    return { vectors: embeddings, usage: { in: usage.promptTokens } };
  },
  judge: claimJudge({ model: 'openai:gpt-6-luna', apiKey, deadlineMs: 8_000, maxOutputTokens: 400 }),
  checker: new ValueAgreementChecker({ names: true }),
});

const passages: ClaimPassage[] = [
  {
    content: 'The Treaty of Versailles was a peace treaty signed on 28 June 1919.',
    title: 'Treaty of Versailles',
    url: 'https://en.wikipedia.org/wiki/Treaty_of_Versailles',
    group: 'wikipedia:Treaty_of_Versailles', // one source: two passages of one group are of one article
    kind: 'encyclopedia',
  },
];

const outcome = await checker.check(
  {
    heard: 'The Treaty of Versailles was signed in 1918', // the words heard that hold the claim
    heardSentence: 'The Treaty of Versailles was signed in 1918.', // the whole sentence they stand in
    statement: 'The Treaty of Versailles was signed in 1918.', // the claim rewritten to stand alone
  },
  passages,
  { signal: AbortSignal.timeout(10_000) },
);
// outcome.kind 'decided': outcome.decision.relation 'differs', the pair 1918 beside 1919 (offsets into
// outcome.decision.texts[0], the sentence as read), outcome.named the passage,
// outcome.quote 'signed on 28 June 1919', outcome.verdict the verifier's ClaimVerdict, outcome.usage the tokens
// outcome.kind 'ended': outcome.reason 'no_passage' | 'limited' | 'no_best' | 'judge_none' | 'quote' | 'undecided'
// outcome.kind 'known': a verdict key the host passed in `known`, with nothing sent
```

`check(claim, given, { signal, found, known, beforeSend, verdictContext })` runs these steps in order, and stops at the first that ends it:

1. The grounding guard's `passages` keeps the sentences of `given` about the claim (two shared stems and a comparable value, or the claim's names for a stated fact without a value). None ends `no_passage`, with nothing sent anywhere. The first `maxPassages` (24) kept are compared; a sentence two sources share word for word, such as a page that copies an encyclopedia, is compared once, as the first of them, so the judge reads the title and kind of the passage the outcome names, and every passage found still meets step 8.
2. With `verdictSecret`, the verdict key is made (below). A key in `known` ends the check `known`, with nothing sent.
3. `beforeSend()` is awaited once, before anything is sent; unless it answers `true` the check ends `limited`. A host counts its allowance here, so a known repeat costs none.
4. One sentence compared is named with no embeddings call (AgentOS's `CitationVerifier` with `pickOnly`), and the judge decides.
5. Otherwise the claim is embedded in one call with every compared sentence that carries no passage `vector` and has no stored public vector. Sentence vectors and passage vectors are not on one scale, so each class is ranked by its own cosine, and of the two classes' best the one earlier among the compared sentences (more stems shared with what was heard) is named. A sentence whose cosine is 0 or less is never named; none ends `no_best`. The cosine decides nothing else.
6. The judge is asked once about that sentence, under `claimJudgeSystem(kind)` with `claimJudgePrompt`: `matches`, `differs` or `none`, with the words it compared quoted. `none` ends `judge_none`.
7. The quote must hold 1 to 20 words (`CLAIM_QUOTE_MAX_WORDS`) and stand in the sentence word for word, cutting no word or number (the grounding guard's `verifyQuotes`, typographic quotation marks read as plain ones). Else it ends `quote`.
8. The grounding guard's `decide` takes the judge's relation as a proposal and decides by code over every passage found, the ones in `found` among them: a "differs" needs every content word heard and a heard value paired with a different one, and a passage found that agrees with every heard value stops it. Nothing decided ends `undecided`.

`found` is every passage about the claim the host holds, the ones it must not send included, such as a sentence that holds personal data: they are never embedded, judged or sent, and take part in step 8 alone. Left out, it is `given`'s passages about the claim.

#### Vectors a host holds, and the verdict key

A check embeds no text whose vector the host already holds:

```ts
const checker = new ClaimChecker({
  embed, judge, checker: valueChecker,
  grader: { judgeModel: 'openai:gpt-6-luna', embedding: { model: 'text-embedding-3-small', dimensions: 1536 } },
  // Public sentences' vectors by the hash of their exact input, the tenant fixed by the host, such as AgentOS's
  // SqlEmbeddingStore bound to it; clean is the host's redaction test.
  publicVectors: {
    get: (hashes) => store.get({ tenant }, model, hashes),
    put: (rows) => store.put({ tenant }, model, rows),
    clean: (text) => !redact(text).found,
  },
  verdictSecret: process.env.CLAIM_VERDICT_SECRET,
});
const outcome = await checker.check(claim, passages, {
  signal,
  known: keysHeldForThisRun, // a verdict the host already holds ends 'known', with nothing sent
  beforeSend: () => allowance.take(), // awaited once, before the first send
  verdictContext: `${accountId}:${runId}`,
});
```

- A passage's `vector` (`{ embedding, level: 'passage', passageId, inputHash }`) is the vector of the passage a sentence stands in, made by the check's embedding model: the sentence is ranked by it and never sent to the embeddings. With `grader`, a vector of another size than its embedding's is left out and the sentence is embedded; without it, a vector of another size than the claim's throws a `RangeError`. An embeddings answer holding a vector of another size, or a value that is not a finite number, rejects the check before the judge is asked.
- A sentence marked `publicKey`, only for a verified public source, whose text `clean` passes, is looked up in `publicVectors` by the SHA-256 of the model, NUL, the dimensions, NUL and the text (AgentOS's `embeddingInputHash`). A store that rejects or answers after `vectorReadMs` (200) counts as empty, and `usage.vectorHits` counts the vectors read. The vectors the check made for such sentences are stored after the verdict, a failed or late write changing nothing; an abort while they are written rejects the check at once with the signal's reason. Any other sentence is embedded and never stored.
- The verdict key is an HMAC-SHA-256, under a key derived by HKDF from `verdictSecret` with `verdictContext` (an account and a run, so a key never matches across them), over everything that decides the verdict: this pack's and the grounding guard's versions, the judge's model, the embedding model and size, `maxPassages`, the grounding guard checker's rules as `grader.rules` names them (`'names:true'`, for example), the claim, each compared sentence with its text, title, kind, group, `ref` and passage vector (its id, its `inputHash` and a hash of the vector), and each sentence found with its text, group, `ref` and whether it is held back. A changed sentence, a 25th agreeing sentence found, a held-back sentence changed, a new release of either pack or another context makes a new key. Every outcome past `no_passage` carries `key`.

`publicVectors` and `verdictSecret` need `grader`; the constructor throws without it.

The judge's instruction names the source by the named passage's `kind`, an open word:

| `kind` | "one sentence from …" |
| --- | --- |
| `encyclopedia` | an encyclopedia article |
| `official`, `news`, `page`, `forum` | a web page |
| `paper` | a paper's abstract |
| `note`, `document` | the person's own notes or documents |
| any other word | a source |

Every instruction opens with "You compare one sentence heard in a room with one sentence from", so a stand-in for the model in a host's tests can tell the judge's call apart from others.

`claimJudge({ model, apiKey, baseUrl?, deadlineMs, maxOutputTokens, effort? })` makes the judge on AgentOS's `generateObject` with this pack's schema (`{ relation, quote }`): one request (`maxAttempts: 1`), no second call for an answer outside the schema (`maxRetries: 0`), no other provider (`fallbackProviders: []`), ended at `deadlineMs` or by the check's signal, the body's read included. A host passes any function of the same shape instead, `({ system, prompt, signal }) => Promise<{ value: { relation, quote }, usage: { in, out } }>`, such as a fake in its tests. The pack reads no key from the environment.

Passages that arrive after the first decision, from slower sources, are decided by code alone, with no model call:

- `agree(first, claim, more)` answers the passages of `more` that agree with a first decision of `matches` or `differs` on the values: one a source other than the first's (by `group`, its best-ranked passage), holding every content stem heard, decided the same relation by the grounding guard, on the same heard value, its value written as the first's.
- `revisit(first, claim, found)` reads the first decision again over every passage found by then, the check's own found ones among them, and answers it, or `null` when a later passage stops it. A host that holds a "differs" until its sources have answered shows it only when `revisit` still decides it.

In both, every passage of `more` and `found` takes part in the veto, as `check`'s `found` does, whatever its length: the 40-word and 600-character limits hold only for a passage that may be sent or join.

Each call reads every passage once, as it is when the call begins (its text, group, title, kind and address), and never again: a host that redacts a passage in place between calls sends only the redacted text from then on, and a change made while a call runs reaches only later calls. `agree` and `revisit` read the first check's passages as they are when they are called, so a passage the host moved to another source is read in that source. A decision's `sentences` are the host's own passage objects, and its `texts` hold each one's text as the call read it, at the same index: `marks` and `pairs` index `texts`, whatever the host has done to a passage since. `texts` is the host's copy: `agree` reads the sentence of the decision it is given as the call that answered it read it (`check`'s, or `revisit`'s when the host puts that decision in the outcome's place), kept apart with the decision's `pairs`, so a host may redact or reformat `texts`, in place or in a shallow copy of the decision, without changing what `agree` answers. A decision whose `pairs` the host has replaced is read from its `texts`.

`usage` counts the judge's tokens in and out, the embeddings' tokens and the public vectors read apart; `judged` is the judge calls made (0 or 1). An abort rejects `check` with the signal's reason at once, whatever is pending; a failed embeddings call or judge rejects with its own error.

## The tool

The pack's one tool, `citation_verify`, takes `{ document, format?, allowUnreachable? }` and answers `{ fails, log, report }`. A document the parser cannot read, or arguments of the wrong type, answer `success: false` with the reason.

```ts
import { createExtensionPack } from '@framers/agentos-ext-citation-check';

const pack = createExtensionPack({ options: { embeddings: 'openai' }, getSecret: (id) => secrets[id] });
```

The tool reads pages through AgentOS's checked egress with the hosted policy, so a document cannot point it at a private address. The pack needs AgentOS 0.19.4 or later: checked egress came in 0.13.120, `claimJudge` needs `generateObject`'s `maxAttempts`, which came in 0.13.158, and `ClaimChecker` needs `CitationVerifier`'s source vectors and `pickOnly`, which came in 0.19.4. Pack options: `embeddings` (`none` or `openai`, the key from the `openai.apiKey` secret or `OPENAI_API_KEY`), `embeddingModel`, `egress` (`hosted` or `local`), and from code `fetch`, `embedFn` and `nliFn`, with `timeoutMs`, `maxBytes`, `maxPages` and `priority`.

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
| `WebPageSourceProvider`, `DEFAULT_ROBOTS`, `WebSearchAnswer` | The open web as a public source over the host's search, its robots.txt rule when none is given, and what the host's search answers for one page |
| `FirecrawlPageReader`, `FIRECRAWL_SCRAPE_URL` | The reader of a page with no text through Firecrawl's scrape endpoint, and that endpoint |
| `ClaimChecker` (`check`, `agree`, `revisit`), `claimJudge(options)`, `claimJudgeSystem(kind)`, `claimJudgePrompt(heard, statement, title, sentence)`, `CLAIM_QUOTE_MAX_WORDS` | A claim heard in a room checked against passages from any source; its judge on AgentOS's `generateObject`; the judge's instruction by kind and its prompt; the most words a quote holds |
| `CitedClaim`, `CitationCheck`, `CitationVerdict`, `CitationPassage`, `PageStatus`, `PageFailure`, `CitationReport`, `CitationSummary`, `CitationCheckOptions`, `CitationLogger`, `EmbedFn`, `NliFn`, `PageReaderOptions`, `PageRead`, `PageFallbackReader`, `FirecrawlPageReaderOptions`, `SpokenClaim`, `ClaimPassage`, `ClaimJudge`, `ClaimJudgement`, `ClaimCheckerOptions`, `ClaimCheckOutcome`, `ClaimDecision`, `ClaimUsage`, `Transport`, `TransportAnswer`, `TransportRules`, `TransportLimits`, `RobotsRule`, `RobotsFile`, `WebPageSourceOptions` and the rest | The types |

## License

Apache-2.0
