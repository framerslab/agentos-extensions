# Whisper chunked speech recognition

This pack gives an agent a speech recognition provider that buffers overlapping audio chunks and posts WAV files to the OpenAI Whisper HTTP API using `fetch`.

## Installation

```bash
npm install @framers/agentos-ext-streaming-stt-whisper
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-streaming-stt-whisper',
        options: { baseUrl: 'https://api.openai.com' },
      },
    ],
  },
  extensionSecrets: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
  },
});
```

## Configuration

The pack factory reads the secret and `baseUrl`. Other settings are session settings passed to `startSession`.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` (standalone session) | `OPENAI_API_KEY` | None | Yes, session interface | Empty string in pack factory |
| `baseUrl`, overridden by `providerOptions.baseUrl` | None | None | No | `https://api.openai.com` |
| `providerOptions.model` | None | None | No | `'whisper-1'` |
| `language`, or `providerOptions.language` | None | None | No | `undefined`, omitted from request |
| `providerOptions.prompt` | None | None | No | `undefined` |
| `providerOptions.chunkSizeSamples` | None | None | No | `16000` |
| `providerOptions.overlapSamples` | None | None | No | `3200` |

## Notes

The pack registers an enabled `streaming-stt-provider` with provider id `whisper-chunked`. `createWhisperChunkedSTT` also creates a standalone provider from an API key and optional base URL.

Audio chunks are posted to `/v1/audio/transcriptions` as multipart WAV uploads with bearer authentication and `verbose_json` responses. The encoder uses a fixed audio rate and mono PCM without resampling. `overlapSamples` must be less than `chunkSizeSamples`, or construction throws `RangeError`.

Sessions emit `interim_transcript` from chunk responses and use the previous nonempty response as the next prompt. Speech boundary events use an RMS energy threshold. Request failures emit `error` and leave the session available for later chunks; the next flush after a failure emits no final transcript and discards that batch's transcript, so a later flush never finalizes it. When delivering `error` throws, because no listener is attached or a listener throws, later chunks still run and the next `flush` rejects with that exception.

`flush` submits buffered audio, awaits the ordered HTTP requests and emits the last completed transcript as final. It does not assemble all window transcripts. `close` aborts requests and suppresses late results. No request timeout is set.

The factory passes an empty key when the secret is absent and does not validate it locally. It does not read environment variables.

## Core event compatibility

Subscribe to `transcript` for the core STT event shape. The existing `interim_transcript` and `final_transcript` events remain aliases with the same payloads and interim/final semantics. Subscribe to one naming convention to avoid duplicate application handling. Flush drains admitted HTTP requests before final output; close aborts requests and suppresses late results. The initial prompt is context and never becomes a transcript on its own.

This is a sliding-window HTTP chunk adapter. It retains the existing overlap policy and last-window final transcript semantics. It does not claim native streaming recognition, scoped VAD, per-attempt funding or bounded hosted input admission. Hosted use requires a separate scoped adapter with those contracts.

## License

Apache-2.0
