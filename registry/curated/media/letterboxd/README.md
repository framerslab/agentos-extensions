# Letterboxd movie lookup

This pack gives an agent movie metadata, ratings, directors, genres, synopsis, and user reviews from Letterboxd. It uses a built-in `fetch()` and regex scraper, with optional delegation to a recipe-capable scraping tool.

## Installation

```bash
npm install @framers/agentos-ext-letterboxd
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-letterboxd';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {},
  logger: console,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `recipeTool` | None | None | No | Built-in scraper |
| `priority` | None | None | No | `50` |

The optional `recipeTool` exposes `execute({ recipe, params }, context)`. The tool calls it with the `letterboxd-movie` recipe, a `query` parameter, and a string `year` when supplied. A failed recipe or missing output data falls back to the built-in scraper.

## Tools

| Tool | What it does |
| --- | --- |
| `letterboxd_movie` | Looks up a movie by title and optional year, returning film metadata and a sample of user reviews. |

### `letterboxd_movie`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | `string` | Yes | Film title to search for on Letterboxd. |
| `year` | `integer` | No | Optional release year to disambiguate titles with the same name. |

## Notes

The built-in scraper needs no API key or headless browser. It searches film pages, prefers a result whose surrounding HTML mentions the supplied year, and otherwise selects the first result. When search yields no slug, it tries a film URL derived from the title.

An empty title returns a tool error. Unavailable pages can return `found: false`; successful pages can contain only the fields the parser finds. The tool has no write side effects and declares `capability:media_search`. The built-in scraper uses `MAX_REVIEWS = 5` and truncates each review's text with `slice(0, 500)`. These limits do not apply to reviews returned by the recipe tool.

## License

Apache-2.0
