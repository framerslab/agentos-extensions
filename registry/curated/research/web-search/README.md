# Web Search Extension for AgentOS

Professional web search, research aggregation, and fact-checking for AgentOS agents.

Supports Serper.dev, Tavily, Brave, SerpAPI, Firecrawl and SearXNG. A search asks the configured providers in that order and answers with the first one that returns without an error, even when it returns no results (a Tavily or Firecrawl request that times out returns no results). It moves to the next provider only when one throws an error or is past its rate limit, and falls back to DuckDuckGo, which needs no API key, when every configured provider did.

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

If none are set, the extension falls back to DuckDuckGo.

## Tools

### `web_search`

Search the web.

### `research_aggregate`

Run multiple searches and aggregate results.

### `fact_check`

Cross-check a claim across sources.

## Ranking

With `multiSearch: true` (a tool input, or the pack option `defaultMultiSearch: true` for every tool), a query goes to every configured provider and DuckDuckGo in parallel. Results are merged by normalized URL and ordered by a confidence score built from how many providers returned the URL and where each placed it. The pack runs no reranking model and sends results to no reranking service.

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
- Provider selection is automatic based on which keys are configured.

## License

Apache-2.0 © Frame.dev
