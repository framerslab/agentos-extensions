# Image editing

This pack gives an agent image transformation, inpainting, upscaling and variation tools through the AgentOS SDK, using OpenAI, Stability AI or Replicate.

## Installation

```bash
npm install @framers/agentos-ext-image-editing
```

Peer dependency: `@framers/agentos` with range `>=0.13.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-image-editing';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    stabilityApiKey: process.env.STABILITY_API_KEY,
    replicateApiToken: process.env.REPLICATE_API_TOKEN,
    imageDir: process.env.AGENTOS_IMAGE_DIR,
  },
  logger: console,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `openaiApiKey` | `openai.apiKey` | `OPENAI_API_KEY` | No | None |
| `stabilityApiKey` | `stability.apiKey` | `STABILITY_API_KEY` | No | None |
| `replicateApiToken` | `replicate.apiToken` | `REPLICATE_API_TOKEN` | No | None |
| `imageDir` | None | `AGENTOS_IMAGE_DIR` | No | POSIX: `os.tmpdir()/agentos-images-${process.getuid()}`; Windows: `os.homedir()/AppData/Local/Temp/agentos-images` |
| `saveImage` | None | None | No | Save image data locally and return a `file:` URL |
| `priority` | None | None | No | `50` |
| `logger` | None | None | No | None |

Keys resolve from the first nonblank option, then `getSecret`, then the environment variable. Editing and variations select the first configured provider in the order `openai`, `stability`, `replicate`. Upscaling selects `replicate`, then `stability`. With no configured key, provider selection passes to AgentOS; provider errors become failed tool results.

## Tools

| Tool | What it does |
| --- | --- |
| `editImage` | Transforms an image from a prompt or inpaints the white regions of a mask, returning image URLs. |
| `upscaleImage` | Upscales an image with a super-resolution model and returns its URL. |
| `variateImage` | Generates variations of an existing image and returns their URLs. |

### `editImage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imageUrl` | `string` | Yes | The source image: an HTTP(S) URL, a `data:image` URL, or the `file:` URL of an image this tool saved. |
| `prompt` | `string` | Yes | The change to make, in words. |
| `mode` | `string` | No | `img2img`, or `inpaint` (needs `maskUrl`). Without a mode: `inpaint` when `maskUrl` is given, else `img2img`. |
| `maskUrl` | `string` | No | For `inpaint`: a mask image whose white pixels mark the regions to repaint. |
| `strength` | `number` | No | How far to move from the source, `0` to `1` (default `0.75`). |
| `provider` | `string` | No | The image provider: `openai`, `stability`, `replicate` or `auto`. `auto` (default) takes the first one with a key. |
| `model` | `string` | No | Optional: the provider's own model id, without a provider prefix. |
| `size` | `string` | No | Optional output size. |
| `negativePrompt` | `string` | No | Optional content to avoid. |

### `upscaleImage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imageUrl` | `string` | Yes | The source image: an HTTP(S) URL, a `data:image` URL, or the `file:` URL of an image this tool saved. |
| `scale` | `number` | No | The upscale factor: `2` or `4` times on Replicate (default `2`); Stability always gives `4` times. |
| `provider` | `string` | No | The image provider: `replicate`, `stability` or `auto`. `auto` (default) takes Replicate when it has a key, else Stability. |
| `model` | `string` | No | Optional: the provider's own model id, without a provider prefix. |

### `variateImage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imageUrl` | `string` | Yes | The source image: an HTTP(S) URL, a `data:image` URL, or the `file:` URL of an image this tool saved. |
| `count` | `number` | No | How many variations. |
| `provider` | `string` | No | The image provider: `openai`, `stability`, `replicate` or `auto`. `auto` (default) takes the first one with a key. |
| `model` | `string` | No | Optional: the provider's own model id, without a provider prefix. |
| `size` | `string` | No | Optional output size. |

## Notes

Provider calls can incur image charges. Image data is saved as PNG, JPEG or WebP and returned as a URL rather than base64. Provider HTTP(S) URLs pass through unchanged. A custom `saveImage` receives `bytes`, `mimeType`, `tool` and `context`, and must return an HTTP(S) URL that passes the saver's length check. A `file:` URL refers to the machine running the tool; hosts with remote clients supply `saveImage`.

The default saver creates and checks storage before a provider call. On POSIX, the images directory belongs to the service user and forbids writes by other users. Its parent directories belong to that user or root and forbid other users' writes unless sticky. Caller subdirectories use `context.userContext.userId`, or `shared` when absent. The pack does not delete saved images.

Inputs accept `data:image` URLs, public HTTP(S) URLs and saved `file:` URLs belonging to the caller. Other local files and private network sources fail. HTTP(S) input requires AgentOS's untrusted image-fetch support, which checks resolved addresses and redirects. Image sources have a `50 * 1024 * 1024`-byte limit; remote fetches have a `30000` ms timeout.

`inpaint` requires a mask. A mask with `img2img`, outpainting and style transfer fail. Finite strength values are clamped to the schema range, and variation quantities are rounded down and clamped to their schema range. Stability upscaling rejects a request for twice the input size. A model prefix naming a different selected provider fails. Empty provider output and storage failures return failed tool results.

## License

Apache-2.0
