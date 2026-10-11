# Vision pipeline

This pack gives an agent OCR, handwriting recognition, document layout, image descriptions and CLIP embeddings through AgentOS's `createVisionPipeline`. The pipeline uses local OCR and vision packages and can use cloud vision providers.

## Installation

```bash
npm install @framers/agentos-ext-vision-pipeline
```

Peer dependency: `@framers/agentos` with range `>=0.13.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-vision-pipeline',
        options: {
          openaiApiKey: process.env.OPENAI_API_KEY,
          imageDir: process.env.AGENTOS_IMAGE_DIR,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `openaiApiKey` | `openai.apiKey` | `OPENAI_API_KEY` via AgentOS | No | AgentOS detects the cloud provider when neither option nor secret supplies a nonblank key |
| `imageDir` | None | `AGENTOS_IMAGE_DIR` | No | A user-specific `agentos-images-<uid>` directory under `os.tmpdir()` on POSIX, or `AppData/Local/Temp/agentos-images` under the user's home on Windows |
| `priority` | None | None | No | `45` |
| None, cloud provider detection by AgentOS | None | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` or `GEMINI_API_KEY`, `OPENROUTER_API_KEY` | No | Provider and key detected by AgentOS |

A nonblank `openaiApiKey` takes precedence over `getSecret('openai.apiKey')` and selects OpenAI for cloud vision. Otherwise, AgentOS reads provider credentials from the environment. The pack lists the provider variables above but does not implement their selection order itself.

## Tools

| Tool | What it does |
| --- | --- |
| `vision-pipeline` | Reads printed text, handwriting and document layout, describes images or returns a CLIP embedding vector. |

### `vision-pipeline` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imageUrl` | `string` | Yes | The image: an http(s) URL, a `data:image` URL, or the `file:` URL of an image the image tools saved. |
| `mode` | `string`, enum: `ocr`, `handwriting`, `layout`, `describe`, `embed`, `auto` | No | `ocr` for printed text, `handwriting`, `layout` for the lines of text with their boxes, `describe` for what the image shows, `embed` for a CLIP vector, or `auto` (default) to let the pipeline decide. |
| `maxTier` | `number`, enum: `1`, `2`, `3` | No | The highest tier to use: `1` local OCR only, `2` local vision models, `3` cloud vision (default). |

## Notes

Local OCR needs `ppu-paddle-ocr` or `tesseract.js`. Handwriting, layout and embeddings need `@huggingface/transformers` for TrOCR, Florence and CLIP. `embed` loads CLIP on demand. Cloud vision needs provider credentials and can send the image to a cloud model.

`ocr` runs OCR alone. `handwriting` runs TrOCR alone, `layout` runs the document layout tier alone, and `describe` runs cloud vision alone. `maxTier` restricts the allowed processing, and a mode that needs a higher tier returns an error. If no text tier runs, the tool returns an error naming failed tiers or the packages and credentials the call can use.

HTTP images are fetched through AgentOS's `imageToBuffer` with `untrusted: true`, which checks public addresses and redirects, limits images to `50 * 1024 * 1024` bytes and applies a `30000` ms fetch timeout. Local and private network addresses are refused. Data URLs are decoded without fetching.

Local paths are refused. A `file:` URL must name a saved PNG, JPEG or WebP in the caller's subdirectory under `imageDir`, with the image saver's filename pattern. Saved images larger than `50 * 1024 * 1024` bytes are refused. The directory ownership and write permissions are checked. The caller scope comes from `context.userContext.userId`, with `shared` used when it is absent.

Pipelines are built on first use and reused per strategy. Failed builds are retried on the next call. Deactivation disposes of built pipelines and prevents new pipeline creation until activation.

## License

Apache-2.0
