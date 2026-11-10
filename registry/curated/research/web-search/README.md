# Web Search Extension for AgentOS

Professional web search, research aggregation, and fact-checking for AgentOS agents.

Supports multiple providers (Serper.dev, SerpAPI, Brave) with a DuckDuckGo fallback when no API keys are configured.

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
          // Any one of these is enough; Serper/SerpAPI/Brave are tried in order.
          serperApiKey: process.env.SERPER_API_KEY,
          serpApiKey: process.env.SERPAPI_API_KEY,
          braveApiKey: process.env.BRAVE_API_KEY,
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

If none are set, the extension falls back to DuckDuckGo.

## Tools

### `web_search`

Search the web.

### `research_aggregate`

Run multiple searches and aggregate results.

### `fact_check`

Cross-check a claim across sources.

## Ranking

With `multiSearch: true`, a query goes to every configured provider and DuckDuckGo in parallel. Results are merged by normalized URL and ordered by a confidence score built from how many providers returned the URL and where each placed it. The pack runs no reranking model and sends results to no reranking service.

To rerank search results with a model, use AgentOS's `WebSearchService` (`@framers/agentos/cognition/web-search`) with a `RerankerService` and a `rerankChain`. AgentOS ships three reranking providers: `local` (a cross-encoder run in process through Transformers.js), `cohere` (Cohere's rerank API) and `llm-judge` (a model you call through your own `llmCallFn` scores and orders the results). See AgentOS's [Reranking](https://github.com/framerslab/agentos/blob/d2725ab9566cd7a58ce4666c42d4bdb492d281fa/docs/text/RERANKING.md) page.

## Notes

- Tools are read-only (no side effects).
- Provider selection is automatic based on which keys are configured.

## License

Apache-2.0 © Frame.dev
