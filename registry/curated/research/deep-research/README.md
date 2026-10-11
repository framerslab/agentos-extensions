# Deep research

This pack gives an agent investigation, academic search, scraping, aggregate search, trend discovery and iterative research tools. It uses `axios` for search and content APIs, DuckDuckGo HTML search, and OpenAI-compatible chat completion endpoints for query decomposition and report synthesis.

## Installation

```bash
npm install @framers/agentos-ext-deep-research
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-deep-research';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    serperApiKey: process.env.SERPER_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    serpApiKey: process.env.SERPAPI_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `serperApiKey` | `serper.apiKey` | `SERPER_API_KEY` | yes, manifest | Empty string |
| `braveApiKey` | `brave.apiKey` | `BRAVE_API_KEY` | no | Unset |
| `serpApiKey` | `serpapi.apiKey` | `SERPAPI_API_KEY` | no | Unset |
| `openaiApiKey` | `openai.apiKey` | `OPENAI_API_KEY`, then `OPENROUTER_API_KEY` in the shared key chain | no | Shared key chain, then empty string |
| `openrouterApiKey` | `openrouter.apiKey` | `OPENAI_API_KEY`, then `OPENROUTER_API_KEY` in the shared key chain | no | Shared key chain, then empty string |
| `primaryProvider` | None | None | no | `openai` |
| `smallModel` | None | None | no | `gpt-4o-mini` |
| `synthesisModel` | None | None | no | `gpt-4o` |
| `secrets` | Secret map | None | no | Context `secrets`, then an empty object |
| None | None | `DEBUG` | no | Unset |

Search keys resolve from options, then the selected secret map, then the environment. `options.secrets` replaces context `secrets`. The LLM key resolves from `openaiApiKey`, `openai.apiKey`, `openrouterApiKey`, `openrouter.apiKey`, `OPENAI_API_KEY`, then `OPENROUTER_API_KEY`.

`primaryProvider` selects `openai`, `openrouter` or `ollama`. An OpenRouter option or environment key also selects the OpenRouter endpoint when `openaiApiKey` is absent. The Ollama endpoint is local. A nonempty `DEBUG` enables console progress logging unless a per-call progress callback takes precedence.

## Tools

| Tool | What it does |
| --- | --- |
| `researchInvestigate` | Investigates a topic across web, academic, social and news sources with cross-references. |
| `researchAcademic` | Searches academic papers on arXiv, Google Scholar or Semantic Scholar. |
| `researchScrape` | Extracts content from YouTube, Wikipedia, blogs and generic pages. |
| `researchAggregate` | Searches Serper, Brave and SerpAPI and returns results grouped by engine. |
| `researchTrending` | Retrieves trends from Twitter, Reddit, YouTube or Hacker News. |
| `deep_research` | Decomposes a query, searches and extracts sources, analyzes gaps and synthesizes a report with citations. |

### `researchInvestigate`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | The research query or topic to investigate |
| `sources` | array of strings, enum: `web`, `academic`, `social`, `news` | no | Sources to search across (default: `web`, `academic`, `news`) |
| `maxResults` | number | no | Maximum results per source (default `10`) |

### `researchAcademic`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Academic search query (keywords, paper title, author name) |
| `source` | string, enum: `arxiv`, `scholar`, `semantic` | no | Academic source to search (default: `arxiv`) |
| `maxResults` | number | no | Maximum number of papers to return (default `10`) |

### `researchScrape`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URL to scrape content from |
| `type` | string, enum: `youtube`, `wikipedia`, `blog`, `generic` | no | Content type for platform-specific extraction (default: `generic`) |

### `researchAggregate`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Search query |
| `engines` | array of strings, enum: `serper`, `brave`, `serpapi` | no | Search engines to query (default: `serper`) |
| `maxResults` | number | no | Maximum results per engine (default `10`) |

### `researchTrending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platform` | string, enum: `twitter`, `reddit`, `youtube`, `hackernews` | no | Platform to discover trends from (default: `hackernews`) |
| `category` | string | no | Category or subreddit to filter trends (optional) |

### `deep_research`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Research question or topic to investigate |
| `depth` | string, enum: `quick`, `moderate`, `deep`; default: `moderate` | no | Research depth: quick (`30000` ms, `10` searches), moderate (`120000` ms, `20` searches), deep (`540000` ms, `50` searches) |
| `maxIterations` | integer, minimum `1`, maximum `10` | no | Maximum search-extract-analyze iterations |
| `sources` | array of strings, enum: `web`, `academic`, `news`, `social` | no | Source types to search |
| `focusAreas` | array of strings | no | Specific aspects to focus on |

## Notes

The manifest requires `serper.apiKey`, but the factory does not reject a missing key. Without it, `deep_research` uses DuckDuckGo HTML search. With it, the engine uses aggregate search; empty provider results do not trigger DuckDuckGo. Brave and SerpAPI are skipped when their keys are absent. Investigation and aggregate search skip failed sources or engines.

Service-backed tools require activation. `deep_research` declares `capability:web_search` and validates that `query` has at least `3` characters. Its `sources` input is passed to the search method but does not filter searches. Without an LLM key, the engine searches the original query; when it collects content and has LLM budget remaining, its no-op synthesis returns an empty summary. Configured LLM calls send research prompts and source evidence to the selected endpoint.

YouTube scraping returns oEmbed metadata, not transcripts. Wikipedia scraping uses the English summary endpoint. Investigation cross-references match shared title words. Trend `category` affects Reddit; the other providers ignore it.

Service HTTP requests use a `30000` ms timeout; generic scraping and engine page extraction use `15000` ms. Generic scraping truncates text to `10000` characters. The engine tracks search, extraction, LLM and elapsed-time budgets, with default iteration limits of `1` for `quick`, `3` for `moderate` and `6` for `deep`. These checks do not cancel an in-flight search or LLM request.

Firecrawl support exists in the engine, but the pack factory does not pass Firecrawl settings to it.

## License

Apache-2.0
