# Deepgram streaming speech recognition

This pack gives an agent a streaming speech recognition provider using the Deepgram WebSocket API through `ws`, with interim transcripts, final transcripts and speaker labels.

## Installation

```bash
npm install @framers/agentos-ext-streaming-stt-deepgram
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-streaming-stt-deepgram' }],
  },
  extensionSecrets: {
    DEEPGRAM_API_KEY: process.env.DEEPGRAM_API_KEY!,
  },
});
```

## Configuration

The pack factory reads only the secret. Session settings go to `startSession`, with provider settings in `providerOptions`.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` (standalone session) | `DEEPGRAM_API_KEY` | None | Yes, session interface | Empty string in pack factory |
| `language`, or `providerOptions.language` | None | None | No | `undefined` through provider; `'en-US'` when omitted from direct session construction |
| `punctuate`, or `providerOptions.punctuate` | None | None | No | `undefined` through provider; `true` when omitted from direct session construction |
| `interimResults`, or `providerOptions.interimResults` | None | None | No | `undefined` through provider; `true` when omitted from direct session construction |
| `providerOptions.model` | None | None | No | `undefined` through provider; `'nova-2'` when omitted from direct session construction |
| `providerOptions.diarize` | None | None | No | `undefined` through provider; `false` when omitted from direct session construction |
| `providerOptions.keywords` | None | None | No | `undefined`, omitted from request |
| `providerOptions.endpointing` | None | None | No | `undefined`, omitted from request |

## Notes

The pack registers an enabled `streaming-stt-provider` with provider id `deepgram-streaming`. `createDeepgramStreamingSTT` also creates a standalone provider from an API key.

`startSession` opens a WebSocket authenticated with the key and transmits audio to Deepgram. It converts normalized floating point PCM to signed integer PCM without resampling. The request fixes the audio rate and channel layout, so callers must supply matching audio.

Sessions emit `transcript`, `interim_transcript`, `final_transcript`, `speech_start`, `speech_end`, `error` and `close`. Word timestamps are converted to milliseconds, and diarization assigns speaker labels. Empty interim transcripts are suppressed.

Unexpected socket closures trigger reconnection with capped exponential backoff. Buffered audio drops the oldest frames when full. `flush` sends `CloseStream` and resolves after enqueueing it; `close` terminates the socket and cancels reconnection.

The provider forwards unset session fields as `undefined`, overriding the direct session constructor defaults. The pack passes an empty key when the secret is absent and does not validate it locally. `endpointing: false` omits the query parameter rather than sending a disabling value.

## License

Apache-2.0
