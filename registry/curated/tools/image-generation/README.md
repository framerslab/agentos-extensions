# Image generation

This pack gives an agent a text-to-image tool through the AgentOS SDK, using OpenAI, OpenRouter, Stability AI or Replicate.

## Installation

```bash
npm install @framers/agentos-ext-image-generation
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-image-generation';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    stabilityApiKey: process.env.STABILITY_API_KEY,
    replicateApiToken: process.env.REPLICATE_API_TOKEN,
    imageDir: process.env.AGENTOS_IMAGE_DIR,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `openaiApiKey` | `openai.apiKey` | `OPENAI_API_KEY` | Yes for selected OpenAI provider | None |
| `openrouterApiKey` | `openrouter.apiKey` | `OPENROUTER_API_KEY` | Yes for selected OpenRouter provider | None |
| `stabilityApiKey` | `stability.apiKey` | `STABILITY_API_KEY` | Yes for selected Stability provider | None |
| `replicateApiToken` | `replicate.apiToken` | `REPLICATE_API_TOKEN` | Yes for selected Replicate provider | None |
| `defaultProvider` | None | None | No | First configured provider: `openai`, `openrouter`, `stability`, `replicate`; otherwise `openai` |
| `defaultModel` | None | None | No | `gpt-image-2.5-flare` for OpenAI; `google/gemini-2.5-flash-image` for OpenRouter; `stable-image-core` for Stability; `black-forest-labs/flux-schnell` for Replicate |
| `defaultSize` | None | None | No | `1024x1024` |
| `defaultQuality` | None | None | No | `medium` for OpenAI GPT Image models; otherwise unset |
| `imageDir` | None | `AGENTOS_IMAGE_DIR` | No | POSIX: `os.tmpdir()/agentos-images-${process.getuid()}`; Windows: `os.homedir()/AppData/Local/Temp/agentos-images` |
| `saveImage` | None | None | No | Save image data locally and return a `file:` URL |
| `priority` | None | None | No | `50` |

Keys resolve from the option, then `getSecret`, then the environment variable. The manifest marks each provider secret optional, but generation requires the selected provider's key. A tool call's `provider` overrides `defaultProvider`; its model, size and quality override their pack defaults.

## Tools

| Tool | What it does |
| --- | --- |
| `generate_image` | Generates an image from a text prompt using the configured providers and returns its URL. |

### `generate_image`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `prompt` | `string` | Yes | Detailed text description of the image to generate. Be specific about style, subject, composition, lighting, and mood. |
| `size` | `string` | No | Image dimensions: `1024x1024` (square, default), `1536x1024` or `1792x1024` (landscape), `1024x1536` or `1024x1792` (portrait). |
| `aspectRatio` | `string` | No | Optional aspect ratio hint for providers that support it. |
| `quality` | `string` | No | Image quality: `low`, `medium` (default), `high`, or `auto`. `standard` and `hd` are read as `medium` and `high`. Higher quality costs more. |
| `style` | `string` | No | Optional style: `vivid` for hyper-real and dramatic, `natural` for more realistic. |
| `provider` | `string` | No | Which AI provider to use: `openai`, `openrouter`, `stability` or `replicate`. If omitted, the extension uses its configured default provider. |
| `model` | `string` | No | Optional: the provider's own model id. |
| `seed` | `number` | No | Optional seed for providers that support reproducible image generation. |
| `negativePrompt` | `string` | No | Optional negative prompt for providers that support excluding specific traits or artifacts. |

## Notes

The package requires Node.js `>=22`. Generation calls can incur image charges. Missing credentials produce a failed tool result naming the selected provider's environment variable and key page. Empty prompts, invalid schema values, provider errors and storage failures also return failed results.

For OpenAI GPT Image models, the service maps `standard` quality to `medium` and `hd` to `high`. It adds the selected style as text in the prompt instead of sending a style parameter. Other model routes receive quality without this conversion.

The result uses the first image returned by the provider. Provider HTTP(S) URLs pass through unchanged. Image data is saved as PNG, JPEG or WebP and returned as a URL rather than base64. The tool ignores fields outside its schema, including `n` and `providerOptions`.

The default saver checks storage before calling a provider. On POSIX, the images directory belongs to the service user and forbids writes by other users. Its parents belong to that user or root and forbid other users' writes unless sticky. Saved images are scoped by `context.userContext.userId`, or stored under `shared` when absent. The pack does not delete saved images.

A custom `saveImage` receives `bytes`, `mimeType`, `tool` and `context`, and must return an HTTP(S) URL that passes the saver's length check. A `file:` URL refers to the machine running the tool; hosts with remote clients supply `saveImage`.

## License

Apache-2.0
