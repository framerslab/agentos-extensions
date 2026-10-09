# @framers/agentos-ext-public-sources

Public sources for AgentOS citation checks. AgentOS's `CitationVerifier` grades a claim against the passages it is given; this library fetches those passages from a public source and keeps their attribution. It ships English Wikipedia's provider behind a `PublicSourceProvider` interface: a search by a short topic phrase, a read of a hit's page HTML by its key, and the article as blocks of plain text with the reference markers, maintenance tags, tables, figures, quotations, code, mathematics and navigation removed.

`citationSources(document, cut)` turns a fetched article into passages, one for each sentence your `cut` finds in each block. A passage is a `VerificationSource` (`content`, `title`, `url`) that also carries the site, the article's key, its revision, the time it was read, its licence, and the sentence's block and offsets. The library holds no sentence rule of its own: pass the one the rest of your pipeline uses, so the claims and the passages are cut the same way.

## Installation

```bash
npm install @framers/agentos-ext-public-sources
```

It needs Node.js 20.19 or later. Its one runtime dependency is [htmlparser2](https://github.com/fb55/htmlparser2); `@framers/agentos` is a peer.

## Example

```ts
import { citationSources, SourceLimiter, WikipediaSourceProvider } from '@framers/agentos-ext-public-sources';
import { sentenceSpans } from '@framers/agentos-ext-grounding-guard/values';

const wikipedia = new WikipediaSourceProvider({
  client: { name: 'MyApp', version: '1.2.0', contact: 'https://example.org/contact' },
  limiter: new SourceLimiter(), // one for every caller on this host: Wikimedia's limits apply per client
});
const found = await wikipedia.search('Treaty of Versailles', { limit: 2 });
if (found.kind === 'hits' && found.hits[0]) {
  const page = await wikipedia.read(found.hits[0]);
  if (page.kind === 'document') {
    const passages = citationSources(page.document, sentenceSpans); // VerificationSource[] with attribution
  }
}
```

## Outcomes

`search` answers one of:

- `{ kind: 'hits', hits }`: at most `limit` hits (2 by default), each with a `key` and a `title`;
- `{ kind: 'limited' }`: the limiter refused, or your `onSend` did, and nothing was sent;
- `{ kind: 'failed', status }`: the HTTP status when an answer came, `null` for a transport failure or the deadline.

`read` answers `{ kind: 'document', document }`, `{ kind: 'limited' }`, or `{ kind: 'skipped', status }` for an answer that is not 200 HTML, one over the size caps, a transport failure or the deadline. Neither method throws for a refusal or a failure; aborting your own `signal` throws its reason.

`onSend` runs once a search has its slot and before it is sent. Throw `new LimiterRefused('caller')` from it to hold searches to a quota of your own; the search then answers `limited` with nothing sent.

## Wikimedia's limits and the User-Agent

Every request runs through a `SourceLimiter`: at most 3 at once, starts at least 250 ms apart (under 5 a second), at most 200 starts in any 60 seconds, a wait of at most 2 seconds for a slot, and, after a 429 or a 503, a block until `Retry-After` has passed (5 seconds when the header is missing, an hour at most). These are the numbers Wikimedia's [rate limits](https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits) and [robot policy](https://wikitech.wikimedia.org/wiki/Robot_policy) give an unauthenticated client with a compliant User-Agent. The limits apply per client, so every provider in a process shares one limiter, and the processes on one host send through one of them.

The provider sends the User-Agent `<name>/<version> (<contact>)`, the form of Wikimedia's [User-Agent policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy) with its library part left out, as the policy allows. Give your client's own name and version and a contact the policy accepts: a website, an email address or a wiki user. Every request also sends `Accept-Encoding: gzip`, as the robot policy asks, follows no redirect and sends no cookie.

## Sizes and the deadline

| Option | Default | What it bounds |
|---|---|---|
| `timeoutMs` | 3,000 | each request, from sending it to reading its body |
| `searchMaxBytes` | 65,536 | a search answer's body |
| `pageMaxSentBytes` | 1,500,000 | the `content-length` a page answer declares |
| `pageMaxBytes` | 6,000,000 | a page's body once unzipped |
| `textBudget` | 300,000 | the characters of text kept from a page |

## Attribution

Wikipedia's text is under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), and every document and passage carries it as `licence` (`WIKIPEDIA_LICENCE`). Wherever you show a passage, show with it:

- the sentence, as `content` holds it;
- a link to the article (`url`), named by its `title`;
- "CC BY-SA 4.0", linked to `licence.url`;
- that the text was modified: the library removes reference markers and maintenance tags and collapses white space, and CC BY-SA 4.0 asks a reuser to "indicate if You modified the Licensed Material" (section 3(a)(1)(B) of its [legal code](https://creativecommons.org/licenses/by-sa/4.0/legalcode.en)).

Wikipedia's page on [reusing its content](https://en.wikipedia.org/wiki/Wikipedia:Reusing_Wikipedia_content) describes the attribution in full. `revision` and `readAt` name the exact text a passage came from.

## The page path

The provider reads page HTML from `/api/rest_v1/page/html/{key}` (`PAGE_PATH`), the cached interface the robot policy names. [RESTBase](https://www.mediawiki.org/wiki/Wikimedia_REST_API), the service behind it, is being deprecated: pass `pagePath: '/w/rest.php/v1/page/{key}/html'` to read the same HTML from MediaWiki's own REST API. A read uses the search hit's `key`, so it follows no redirect; a title that redirects answers 307 at both paths, and the read answers `skipped`.

## API

| Export | What it is |
|---|---|
| `PublicSourceProvider` | The interface a public source implements: `site`, `search(phrase, options)`, `read(hit, options)` |
| `WikipediaSourceProvider` | English Wikipedia's provider, or another wiki's through `origin` |
| `SourceLimiter`, `LimiterRefused`, `retryAfterMs` | The limiter, its refusal and the `Retry-After` reading |
| `htmlToBlocks(html, { budget })` | An article's HTML as blocks of plain text, white space collapsed, in NFC |
| `citationSources(document, cut)` | A fetched article as passages with their attribution and place |
| `wikipediaUserAgent`, `articleUrl`, `WIKIPEDIA_LICENCE`, `SEARCH_PATH`, `PAGE_PATH` | The User-Agent, the article's address, the licence and the paths the provider uses |
| `SourceHit`, `SourceDocument`, `CitationSource`, `SourceLicence`, `SearchOutcome`, `ReadOutcome`, `CallOptions`, `WikipediaOptions`, `WikipediaClient`, `LimiterOptions` | The types of the hits, documents, passages, outcomes and options |

## License

Apache-2.0
