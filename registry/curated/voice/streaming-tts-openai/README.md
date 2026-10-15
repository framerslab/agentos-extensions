# OpenAI streaming speech synthesis

This pack gives an agent a speech synthesis provider that splits text tokens into sentence chunks and sends them to the OpenAI Audio Speech HTTP API using `fetch`.

## Installation

```bash
npm install @framers/agentos-ext-streaming-tts-openai
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-streaming-tts-openai',
        options: { voice: 'nova', format: 'opus' },
      },
    ],
  },
  extensionSecrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
});
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

Each sentence starts an HTTP POST to `/v1/audio/speech` after its predecessor finishes. The response is read completely before the core and legacy audio events emit. Requests and audio remain in input order.

Sessions retain the legacy events and add `audio` and `flush_complete`. Raw PCM duration comes from sample bytes; compressed duration remains a word-count estimate.

`cancel` aborts requests and reports buffered text. `close` cancels the timer, aborts requests and emits `close`. Request errors emit `error`, as does a WAV response that is not a well-formed PCM16 mono container; abort errors are suppressed. No HTTP timeout is set, and the generic session `language` is not forwarded.

The factory uses an empty key when the secret is absent, unless the runtime options spread overrides `apiKey`. It does not validate credentials or read environment variables.

## Core event compatibility

Core consumers receive `audio` in sentence order and `flush_complete` after a successfully drained synthesis batch. The legacy `audio_chunk`, `utterance_start` and `utterance_complete` events remain available. Subscribe to either audio name, not both. Requests execute sequentially so a faster second request cannot overtake the first. Cancellation aborts admitted HTTP work and drops queued sentences.

Core audio accepts PCM, MP3 and Opus. WAV is explicitly declared as PCM in a WAV container. AAC and FLAC remain available to legacy subscribers and are refused before synthesis when a core audio listener is present. Raw PCM duration is derived from sample bytes; compressed durations remain estimates. Completion reports synthesis, not audible playback. This event-only adapter has no awaited playback sink and does not claim hosted conformance.

## License

Apache-2.0
