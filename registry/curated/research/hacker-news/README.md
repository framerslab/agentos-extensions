# Hacker News

This pack gives an agent a tool to fetch and search Hacker News stories with query, time, points and tag filters. It uses the public Algolia HN Search API through `fetch` and requires no API key.

## Installation

```bash
npm install @framers/agentos-ext-hacker-news
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-hacker-news';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { priority: 50 },
  logger: console,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `priority` | None | None | no | `50`; a falsy value also uses this default |
| Context `logger` | None | None | no | Unset |

`logger.info` receives activation and deactivation messages.

## Tools

| Tool | What it does |
| --- | --- |
| `hacker_news` | Fetches and searches raw Hacker News stories with filters and sorting. |

### `hacker_news`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | no | Search query. Leave empty for front page stories. |
| `sortBy` | string, enum: `relevance`, `date`, `points`; default: `points` | no | |
| `minPoints` | integer, minimum zero, default zero | no | Minimum upvote threshold. |
| `timeRange` | string, enum: `day`, `week`, `month`, `year` | no | Restrict results to a time window. |
| `tag` | string, enum: `story`, `comment`, `show_hn`, `ask_hn`, `front_page`; default: `story` | no | HN content type filter. |
| `maxResults` | integer, minimum `1`, maximum `50`, default `10` | no | |

## Notes

The tool declares `capability:web_search`. Requests time out after `15000` ms. API or fetch failures return `success: false` with an error message.

When `tag` is absent, execution selects `front_page` for an empty query and `story` for a nonempty query. The schema's `tag` default is `story`. A positive `minPoints` uses a strict greater-than filter. The tool requests extra hits, removes hits without titles, sorts by points or date locally, then truncates results. `relevance` preserves Algolia's ordering.

Stories include title, URL, points, author, comment count, discussion URL, publication time, content hash and object ID. `totalFound` is the returned story count. The tool does not infer categories.

## License

Apache-2.0
