# OpenAI streaming speech synthesis

This pack gives an agent a speech synthesis provider that splits text tokens into sentence chunks and sends them to the OpenAI Audio Speech HTTP API using `fetch`.

## Installation

```bash
npm install @framers/agentos-ext-streaming-tts-openai
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-streaming-tts-openai';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { voice: 'nova', format: 'opus' },
  getSecret: (id) => id === 'OPENAI_API_KEY' ? 'your-api-key' : undefined,
}));
```

## Configuration

Session `providerOptions` override `model`, `voice`, `format` and `maxBufferMs`. The base URL remains a provider setting.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` (provider config; options spread also accepts it at runtime) | `OPENAI_API_KEY` | None | Yes, provider interface | Empty string in pack factory |
| `baseUrl` | None | None | No | `https://api.openai.com` |
| `model` | None | None | No | `'tts-1'` |
| `voice` | None | None | No | `'nova'` |
| `format` | None | None | No | `'opus'` |
| `maxBufferMs` | None | None | No | `2000` milliseconds |

## Notes

The pack registers an enabled `streaming-tts-provider` with provider id `openai-streaming-tts`. `createOpenAIStreamingTTS` also creates a standalone provider from an API key and optional settings.

Sentence boundaries require punctuation followed by whitespace. The inactivity timer resets on each token push and emits text up to the last space, retaining the final word. `flush` emits remaining text and waits for pending synthesis requests.

Each sentence starts an HTTP POST to `/v1/audio/speech` with bearer authentication. The response is read completely before `audio_chunk` emits. Requests start eagerly, and events emit inside each request, so differing response times can produce audio events out of input order.

Sessions emit `utterance_start`, `audio_chunk`, `utterance_complete`, `cancelled`, `error` and `close`. Audio chunks contain the sentence text, response bytes and an estimated duration based on word count.

`cancel` aborts requests and reports buffered text. `close` cancels the timer, aborts requests and emits `close`. Request errors emit `error`; abort errors are suppressed. No HTTP timeout is set, and the generic session `language` is not forwarded.

The factory uses an empty key when the secret is absent, unless the runtime options spread overrides `apiKey`. It does not validate credentials or read environment variables.

## License

Apache-2.0
