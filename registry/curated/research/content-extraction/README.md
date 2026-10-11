# Content extraction

This pack gives an agent tools to extract web content, YouTube transcripts, Wikipedia articles, PDF text and structured page data. It uses `axios` for HTTP requests, YouTube oEmbed and caption endpoints, and Wikipedia REST and MediaWiki APIs.

## Installation

```bash
npm install @framers/agentos-ext-content-extraction
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-content-extraction' }],
  },
});
```

## Tools

| Tool | What it does |
| --- | --- |
| `extractUrl` | Extracts clean text, markdown or HTML from a URL. |
| `extractYoutube` | Retrieves a YouTube transcript and video metadata from a video ID or URL. |
| `extractWikipedia` | Extracts an article's content, summary and metadata in the requested language. |
| `extractPdf` | Extracts text from a PDF document at a URL. |
| `extractStructured` | Extracts tables, lists, links and metadata from a web page. |

### `extractUrl`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URL to extract content from |
| `format` | string, enum: `text`, `markdown`, `html` | no | Output format (default: `text`) |

### `extractYoutube`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoId` | string | yes | YouTube video ID or full URL (e.g., "dQw4w9WgXcQ" or "https://www.youtube.com/watch?v=dQw4w9WgXcQ") |

### `extractWikipedia`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `title` | string | yes | Wikipedia article title (e.g., "Artificial intelligence") |
| `language` | string | no | Wikipedia language code (default: `en`) |

### `extractPdf`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URL of the PDF document to extract text from |

### `extractStructured`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | string | yes | URL to extract structured data from |
| `selectors` | object | no | Optional CSS-style selectors to target specific elements |
| `selectors.tables` | string | no | Selector for tables |
| `selectors.lists` | string | no | Selector for lists |
| `selectors.links` | string | no | Selector for links |

## Notes

The factory reads no configuration or secrets. Activation initializes the service; calls before initialization return an error. Tools return `success: false` and an `error` message when extraction fails.

URL and structured extraction requests time out after `15000` ms. Other HTTP requests use a `30000` ms timeout. Structured extraction returns at most `100` links and ignores the supplied `selectors`.

PDF extraction reads text operators from uncompressed streams. When it finds no text, it returns a message explaining that uncompressed text streams are required. YouTube extraction returns `(Transcript not available)` when captions cannot be retrieved.

## License

Apache-2.0
