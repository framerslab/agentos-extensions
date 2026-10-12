# Stealth browser

This pack gives an agent browser navigation, scraping, clicking, typing, screenshot and DOM snapshot tools. It uses `puppeteer-extra`, `puppeteer-extra-plugin-stealth`, `puppeteer-core` and `cheerio` with a local Chrome executable.

## Installation

```bash
npm install @framers/agentos-ext-stealth-browser
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-stealth-browser',
        options: {
          headless: true,
          timeout: 30000,
          viewport: { width: 1920, height: 1080 },
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `headless` | None | None | no | Unset through factory; launches headed |
| `timeout` | None | None | no | Unset through factory; passed to Puppeteer |
| `userAgent` | None | None | no | Random selection from the built-in pool |
| `viewport` (object with `width` and `height`) | None | None | no | Unset through factory; no viewport override |
| `executablePath` | None | None | no | OS-specific Chrome path |
| `enableEvasions` | None | None | no | Enabled unless `false` |
| `priority` | None | None | no | `50`; a falsy value also uses this default |
| Context `logger` | None | None | no | Unset |
| Context `onActivate` | None | None | no | Unset |
| Context `onDeactivate` | None | None | no | Unset |

Set `headless`, `timeout` and `viewport` explicitly to use the values in the example. The factory passes undefined properties that overwrite the service constructor's defaults. Use these flat option names rather than the manifest's dotted configuration names.

`logger.info` receives lifecycle messages. The context callbacks run on activation and deactivation; deactivation closes the browser before invoking the callback.

## Tools

| Tool | What it does |
| --- | --- |
| `stealth_navigate` | Navigates with anti-detection enabled and returns page text, links and optional HTML. |
| `stealth_scrape` | Extracts content from the current page using a CSS selector. |
| `stealth_click` | Waits for an element to become visible and clicks it. |
| `stealth_type` | Types into an input field with a default keystroke delay. |
| `stealth_screenshot` | Captures the current page or a selected element. |
| `stealth_snapshot` | Returns a DOM snapshot of interactive elements, links and forms. |

### `stealth_navigate`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | The URL to navigate to |
| `waitFor` | string, enum: `load`, `domcontentloaded`, `networkidle0`, `networkidle2`; default: `networkidle2` | no | When to consider navigation complete |
| `returnHtml` | boolean, default `false` | no | Include full HTML in response |
| `returnText` | boolean, default `true` | no | Include extracted text in response |
| `returnLinks` | boolean, default `true` | no | Include all links found on the page (text + href) |
| `maxTextLength` | number, default `50000` | no | Maximum characters of page text to return (default `50000`) |

### `stealth_scrape`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `selector` | string | yes | CSS selector to match elements |
| `limit` | number, minimum one | no | Maximum number of elements to return |
| `attributes` | array of strings | no | Specific attributes to extract |

### `stealth_click`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `selector` | string | yes | CSS selector for the element to click |
| `waitForNavigation` | boolean, default `false` | no | Wait for page navigation after click |

### `stealth_type`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `selector` | string | yes | CSS selector for the input element |
| `text` | string | yes | Text to type |
| `delay` | number, default `50` | no | Delay between keystrokes (ms). Defaults to `50` for human-like typing. |
| `clear` | boolean, default `false` | no | Clear existing text before typing |

### `stealth_screenshot`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `fullPage` | boolean, default `false` | no | Capture full scrollable page |
| `selector` | string | no | CSS selector for specific element to capture |
| `format` | string, enum: `png`, `jpeg`, `webp`; default: `png` | no | Image format |
| `quality` | number, minimum zero, maximum `100`, default `80` | no | Quality for jpeg/webp (`0` to `100`) |

### `stealth_snapshot`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `includeLinks` | boolean, default `true` | no | Include links in snapshot |
| `includeForms` | boolean, default `true` | no | Include forms in snapshot |

## Notes

The browser launches lazily when a tool first uses it and remains shared across the pack's tools until deactivation. The default executable paths are `C:\Program Files\Google\Chrome\Application\chrome.exe` on Windows, `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS and `/usr/bin/google-chrome` on Linux. Set `executablePath` for another location.

Clicking and typing change the page and can trigger its actions. Launch flags disable the browser sandbox and web security and allow insecure content. `enableEvasions: false` skips applying the stealth plugin for that service, but the service still applies launch flags, HTTP headers and page-level overrides.

Navigation failures return partial content with a zero status and an error console message; the navigation tool still returns `success: true` for that result. Scrape failures return an empty element list. Click and type failures return `success: false`.

Navigation text is truncated to `maxTextLength`, with truncation metadata. The service retains at most `100` console messages. Screenshots return base64 image data; reported dimensions come from the viewport. A zero screenshot `quality` falls back to `80`.

## License

Apache-2.0
