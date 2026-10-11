# Web scraper

This pack gives an agent page scraping, structured extraction and named YAML recipe tools. It uses `fetch`, optional `playwright-core` browser fallbacks, a regex selector engine and `yaml` for recipe loading.

## Installation

```bash
npm install @framers/agentos-ext-web-scraper
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-web-scraper',
        options: {
          proxyUrl: process.env.WEB_SCRAPER_PROXY_URL,
          proxyList: process.env.WEB_SCRAPER_PROXY_LIST,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `proxyUrl` | `scraper.proxyUrl` | `WEB_SCRAPER_PROXY_URL` | no | Unset |
| `proxyList` | `scraper.proxyList` | `WEB_SCRAPER_PROXY_LIST` | no | Unset |
| `minDelayMs` | None | None | no | `500` ms |
| `maxDelayMs` | None | None | no | `2000` ms |
| `priority` | None | None | no | `50`; a falsy value also uses this default |
| Context `logger` | None | None | no | Unset |

Proxy settings resolve from truthy options, then `context.getSecret`, then the environment. `proxyList` accepts a comma-separated string or an array of strings and takes precedence over `proxyUrl`. The service rotates through the list; per-request `options.proxy` overrides it. `logger.info` receives activation and deactivation messages.

## Tools

| Tool | What it does |
| --- | --- |
| `web_scrape` | Scrapes a page and returns selector-based data or raw HTML and cleaned text through progressive fallbacks. |
| `web_scrape_recipe` | Runs a named sequence of scraping steps with parameter and prior-result interpolation. |

### `web_scrape`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | Fully qualified URL to scrape (must start with http:// or https://). |
| `extract` | object | no | Optional extraction configuration. Use `fields` for single-record extraction, or `list` + `listFields` for repeating-item extraction. |
| `extract.fields` | object with string values | no | Map of output field name to CSS-like selector. Append ` @attr` to extract an attribute value instead of text content. |
| `extract.list` | string | no | Selector for the repeating container element in a list view. |
| `extract.listFields` | object with string values | no | Per-item field selectors, relative to each `list` container match. |
| `options` | object | no | Optional per-request scrape settings. |
| `options.tier` | integer, minimum `1`, maximum `4` | no | Starting scrape tier (`1`: fetch, `2`: Playwright, `3`: stealth, `4`: LLM fallback). |
| `options.maxTier` | integer, minimum `1`, maximum `4` | no | Highest tier the service may escalate to (default `4`). |
| `options.proxy` | string | no | HTTP/SOCKS5 proxy URL for this request. |
| `options.headers` | object with string values | no | Extra HTTP headers to include. |
| `options.waitFor` | string | no | CSS selector to wait for before extraction (tier two and above only). |
| `options.timeout` | integer, minimum `1000` | no | Per-request timeout in milliseconds (default `30000`). |
| `options.javascript` | boolean | no | Set to true if the page requires JS rendering (skips to tier two). |

### `web_scrape_recipe`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `recipe` | string | yes | Name of the recipe to execute (e.g., `generic-article`, `letterboxd-movie`). |
| `params` | object with string values | yes | Runtime parameter values for the recipe. Keys must match the parameter names declared in the recipe definition. |

## Notes

Both tools declare `capability:web_scrape`. The service tries plain fetch, headless Playwright, stealth Playwright, then a text-fetch fallback. `javascript: true` starts at the browser tier unless `maxTier` caps it lower. A cached successful tier can raise the starting tier. Fetch requests and browser navigation or selector waits default to `30000` ms per operation, rather than a total deadline.

Browser fallbacks dynamically import `playwright-core` and launch Chromium. If the import or launch fails, the service continues to the next allowed tier. `playwright-core` is not listed in the package's dependencies. Proxies are passed to Playwright launch options; the fetch paths do not apply them. Each browser attempt closes its browser afterward.

The text fallback rejects content shorter than `200` characters and recognized Cloudflare challenge pages. With `extract`, it returns text and `_llmExtractionRequired: true`; the calling runtime performs any LLM extraction. Browser paths also reject recognized challenge pages. Plain fetch accepts successful HTTP responses without this challenge check. Failure across all allowed tiers returns `success: false` and an error message.

Extraction supports `tag`, `.class`, `#id`, `tag.class` and a ` @attr` suffix. It uses regex matching rather than a full CSS parser. Unsupported or unmatched field selectors return empty strings. Empty extraction results do not trigger fallback escalation.

Rate limiting uses random delays between `minDelayMs` and `maxDelayMs` for repeated requests to a domain. Successful tiers are cached per domain for `30` minutes, with a maximum of `500` entries.

Activation loads YAML recipes from the package's `recipes/` directory, then `~/.wunderland/scraper-recipes/`; user recipes override matching names. The bundled recipe names are `generic-article` and `letterboxd-movie`. The engine looks up loaded names and does not load a path supplied as `recipe`. Missing recipes return an error. Invalid recipe files produce console warnings and are skipped.

Recipe steps run sequentially and interpolate `{{paramName}}`, `{{steps.stepName.data.field}}` and `{{steps.stepName.items[N].field}}` in URLs and selectors. Parameters prefixed with `=` in a recipe have defaults; missing values otherwise become empty strings. Interpolation does not URL-encode values. Failed steps stop execution and return partial data. A step's `options.maxItems` caps list results. The bundled Letterboxd recipe uses descendant selectors that the regex extraction engine does not implement.

## License

Apache-2.0
