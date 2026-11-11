# Web Search Extension for AgentOS

Professional web search, research aggregation, and fact-checking for AgentOS agents.

Supports Serper.dev, Tavily, Brave, SerpAPI, Firecrawl and SearXNG. A search asks the configured providers in that order and answers with the first one that returns without an error, even when it returns no results (a Tavily or Firecrawl request that times out returns no results). It moves to the next provider only when one throws an error or is past its rate limit, and falls back to DuckDuckGo, which needs no API key, when every configured provider did. English Wikipedia, which needs no key, answers a search pinned to it and `multiSearch` once a host enables it (see [Options](#options)).

## Installation

```bash
npm install @framers/agentos-ext-web-search
```

## Quick Start

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-web-search',
        options: {
          // Any one of these is enough; configured providers are tried in the order above.
          serperApiKey: process.env.SERPER_API_KEY,
          tavilyApiKey: process.env.TAVILY_API_KEY,
          braveApiKey: process.env.BRAVE_API_KEY,
          serpApiKey: process.env.SERPAPI_API_KEY,
          firecrawlApiKey: process.env.FIRECRAWL_API_KEY,
          searxngUrl: process.env.SEARXNG_URL,
        },
      },
    ],
  },
});
```

## Environment Variables

- `SERPER_API_KEY` (optional)
- `SERPAPI_API_KEY` (optional)
- `BRAVE_API_KEY` (optional)
- `TAVILY_API_KEY` (optional)
- `FIRECRAWL_API_KEY` (optional)
- `SEARXNG_URL` (optional, a SearXNG instance URL)

If none are set, the extension falls back to DuckDuckGo. Wikipedia needs no key and no variable: the `wikipedia` option enables it.

## Options

Beside the keys above, the pack options and `SearchProviderService`'s configuration take:

| Option | What it does | When left out |
|---|---|---|
| `wikipedia` | `{ enabled, client, limiter?, origin?, timeoutMs? }`: English Wikipedia's REST search through [`@framers/agentos-ext-public-sources`](https://www.npmjs.com/package/@framers/agentos-ext-public-sources)' `WikipediaSourceProvider`. It needs no key. `client` (`{ name, version, contact }`) is sent as the User-Agent Wikimedia's policy asks for. `limiter` is the process's one `SourceLimiter` for the wiki: pass the same one to every service and every reader that calls it, since Wikimedia counts its limits per client. `origin` points the provider at another wiki or a stand-in; `timeoutMs` is each request's deadline. | Off. Once enabled: a new `SourceLimiter`, `https://en.wikipedia.org`, 3,000 ms. |
| `serperUrl` | Serper's search endpoint, such as a stand-in in a host's tests. | `https://google.serper.dev/search` |
| `tavilyUrl` | Tavily's search endpoint. | `https://api.tavily.com/search` |
| `firecrawlUrl` | Firecrawl's search endpoint. | `https://api.firecrawl.dev/v1/search` |
| `tavily` | `{ searchDepth: 'basic' \| 'advanced' }`, the `search_depth` Tavily is sent. `include_answer` and `include_raw_content` are false at either depth. | `advanced` |

The `wikipedia` provider is listed after every other configured provider. A `search` with no `provider` never asks it: it answers article titles alone, so a general query goes to the keyed providers and then to DuckDuckGo. Pin it with `provider: 'wikipedia'`, or use `multiSearch`, which asks it beside the others. It answers each hit as `{ title, url, snippet: '', position }`, the `url` built by public-sources' `articleUrl`, so `decodeURIComponent` of the path after `/wiki/` gives the article's key back for a read through `WikipediaSourceProvider.read`.

## Searching from code

```ts
import { SourceLimiter } from '@framers/agentos-ext-public-sources';
import { LimiterRefused, SearchFailed, SearchProviderService } from '@framers/agentos-ext-web-search';

// One limiter for the wiki in the process, shared with every other caller of it.
const wikiLimiter = new SourceLimiter();

const search = new SearchProviderService({
  tavilyApiKey: process.env.TAVILY_API_KEY,
  tavily: { searchDepth: 'basic' },
  wikipedia: {
    enabled: true,
    client: { name: 'MyApp', version: '1.2.0', contact: 'https://example.org/contact' },
    limiter: wikiLimiter,
  },
});

let sent = 0;
const controller = new AbortController();
try {
  const response = await search.search('Treaty of Versailles', {
    provider: 'wikipedia',
    maxResults: 2,
    signal: controller.signal,
    onSend: () => {
      sent += 1;
    },
  });
  // response.results[0]: { title: 'Treaty of Versailles', url: 'https://en.wikipedia.org/wiki/Treaty_of_Versailles', snippet: '', position: 1 }
} catch (error) {
  if (error instanceof LimiterRefused) {
    // Nothing was sent: error.reason is 'blocked', 'minute', 'wait' or 'caller'.
  } else if (error instanceof SearchFailed) {
    // error.provider is 'wikipedia'; error.status is the HTTP status, or null when none came.
  }
}
```

`search(query, { maxResults, provider, category, signal, onSend })`:

- `provider` pins one provider: no other is tried and nothing falls back to DuckDuckGo. A pinned keyed provider that answers an error status throws its own `Error`. A pinned `wikipedia` search the limiter refuses throws public-sources' `LimiterRefused`, which this pack re-exports, and one that fails throws `SearchFailed`. The refusal is the one the host's limiter threw, reason and all, even from a limiter of another copy of public-sources. A search pinned to `wikipedia` on a service that did not enable it throws and sends nothing.
- `signal` ends every provider request of the search, and the search rejects with the signal's reason. Tavily's and Firecrawl's own 15-second timers run beside it, and their own timeout answers no results. Without `provider`, an abort ends the search there: no next provider is asked, and DuckDuckGo is not.
- `onSend` is awaited once before each provider is asked, before its request is sent. When it throws, nothing is sent, no other provider is asked, and the search rejects with what it threw. For `wikipedia` it runs once the limiter has granted the request, so a search the limiter refuses never runs it. A search can end refused after `onSend` has run, with nothing sent, when a 429 or a 503 blocked the limiter meanwhile or the spacing would wait past the limiter's `waitMs`.

A search with neither `signal` nor `onSend` sends the requests it sent before these options existed.

## Tools

### `web_search`

Search the web. `provider` pins one of `serper`, `serpapi`, `brave`, `tavily`, `firecrawl`, `searxng` or `duckduckgo`, and `wikipedia` on a service that enables it. The tool reads the service's providers when it is built: on a service without `wikipedia`, its schema's `provider` enum and its description leave Wikipedia out, and `validateArgs` refuses `provider: 'wikipedia'` as an invalid provider.

### `research_aggregate`

Run multiple searches and aggregate results.

### `fact_check`

Cross-check a claim across sources.

## Ranking

With `multiSearch: true` (a tool input, or the pack option `defaultMultiSearch: true` for every tool), a query goes to every configured provider (the `wikipedia` provider among them when it is enabled) and DuckDuckGo in parallel. Results are merged by normalized URL and ordered by a confidence score built from how many providers returned the URL and where each placed it. The pack runs no reranking model and sends results to no reranking service.

### Reranking with AgentOS

AgentOS reranks with a `RerankerService` (`@framers/agentos/cognition/rag/reranking`). Reranking is provider-agnostic: you register the providers you want, and `rerankChain(query, chunks, chain)` runs the chain's stages in order, each naming a provider id, a `topK` and optionally a model. A stage whose provider is not registered or not available is skipped, and a stage that throws leaves the previous order in place.

There are two ways to use it with web search:

- **This pack's results.** The pack's tools do not call a reranker. To rerank what `web_search` returned, pass the results to `rerankChain` yourself, each as a chunk with an `id`, an `originalDocumentId` (the URL, for example) and its snippet as `content`.
- **AgentOS's own search.** `WebSearchService` (`@framers/agentos/cognition/web-search`) is a separate search with its own providers (`FirecrawlProvider`, `TavilyProvider`, `SerperProvider` and `BraveProvider`, added with `registerProvider`), not this pack's. Given a `reranker` (a `RerankerService`) and a `rerankChain`, it reranks its fused results, sending each result's page content, or its snippet when it has none. If reranking fails, it returns the fused results unreranked.

AgentOS ships three reranking providers, all exported from `@framers/agentos/cognition/rag/reranking`. The table describes AgentOS at commit [`c46ff75`](https://github.com/framerslab/agentos/tree/c46ff754e8df1ccb54f31aa24fc8fd8df5952776); other versions can differ (at v0.10.40, the oldest AgentOS this pack declares, `LlmJudgeReranker` accepts a `timeoutMs` but does not apply it).

| Id | Class | How it scores | What leaves the process | Defaults | On failure |
| --- | --- | --- | --- | --- | --- |
| `local` | [`LocalCrossEncoderReranker`](https://github.com/framerslab/agentos/blob/c46ff754e8df1ccb54f31aa24fc8fd8df5952776/src/cognition/rag/reranking/providers/LocalCrossEncoderReranker.ts) | A cross-encoder scores each query and document pair in process through Transformers.js (`@huggingface/transformers`, else `@xenova/transformers`, installed by the host). | No query or document. The model is downloaded on first use and cached. | Model `cross-encoder/ms-marco-MiniLM-L-6-v2`, device `cpu`, `maxSequenceLength` 512, `batchSize` 32. | Not available when neither Transformers.js package is installed. A model that fails to load throws. A document whose scoring throws scores 0. |
| `cohere` | [`CohereReranker`](https://github.com/framerslab/agentos/blob/c46ff754e8df1ccb54f31aa24fc8fd8df5952776/src/cognition/rag/reranking/providers/CohereReranker.ts) | Cohere's Rerank API scores the documents. | The query and every document's full content, sent to `<baseUrl>/v1/rerank` with the `apiKey`. | Model `rerank-v3.5`, `baseUrl` `https://api.cohere.ai`, timeout 30000 ms. | Not available without an `apiKey`. A non-2xx answer or a timeout throws. |
| `llm-judge` | [`LlmJudgeReranker`](https://github.com/framerslab/agentos/blob/c46ff754e8df1ccb54f31aa24fc8fd8df5952776/src/cognition/rag/reranking/providers/LlmJudgeReranker.ts) | A language model, called through the host's `llmCallFn(system, user, model?)`, scores the first `maxPointwiseDocuments` documents 0 to 10 in batches, then ranks the best-scored ones in one call. Documents past `maxPointwiseDocuments` are left out of its answer. | The query and the first 200 characters of each document, sent wherever the host's `llmCallFn` sends them. | No model of its own: `scoringModel` and `rankingModel` are passed to `llmCallFn` as given. `maxPointwiseDocuments` 100, `batchSize` 10, `pointwiseTopK` 20, timeout 30000 ms a call. | A batch whose call fails, times out or does not parse scores 0. A failed ranking call leaves the order to the scores. |

See AgentOS's [Reranking](https://github.com/framerslab/agentos/blob/c46ff754e8df1ccb54f31aa24fc8fd8df5952776/docs/text/RERANKING.md) page and [`WebSearchService.ts`](https://github.com/framerslab/agentos/blob/c46ff754e8df1ccb54f31aa24fc8fd8df5952776/src/cognition/web-search/WebSearchService.ts).

## Notes

- Tools are read-only (no side effects).
- Provider selection is automatic, based on which keys are configured and whether `wikipedia` is enabled.

## License

Apache-2.0 © Frame.dev
