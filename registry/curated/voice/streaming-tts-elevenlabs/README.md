# ElevenLabs streaming speech synthesis

This pack gives an agent a streaming speech synthesis provider using the ElevenLabs WebSocket API through `ws`. It sends text tokens and emits MP3 audio chunks.

## Installation

```bash
npm install @framers/agentos-ext-streaming-tts-elevenlabs
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-streaming-tts-elevenlabs',
        options: { voiceId: '21m00Tcm4TlvDq8ikWAM' },
      },
    ],
  },
  extensionSecrets: {
    ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY!,
  },
});
```

## Configuration

Voice settings in `startSession({ providerOptions: ... })` override pack options.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` (provider config; options spread also accepts it at runtime) | `ELEVENLABS_API_KEY` | None | Yes, provider interface | Empty string in pack factory |
| `voiceId` | None | None | No | `'21m00Tcm4TlvDq8ikWAM'` |
| `modelId` | None | None | No | `'eleven_turbo_v2'` |
| `stability` | None | None | No | `0.5` |
| `similarityBoost` | None | None | No | `0.75` |
| `style` | None | None | No | `0.0` |
| `useSpeakerBoost` | None | None | No | `true` |

## Notes

The pack registers an enabled `streaming-tts-provider` with provider id `elevenlabs-streaming-tts`. `createElevenLabsStreamingTTS` also creates a standalone provider from an API key and optional voice settings.

`startSession` opens a WebSocket. On opening, a live session sends the API key and voice settings, then drains queued messages. Each token is sent once; punctuation adds `flush: true` without resending earlier tokens. `flush` queues EOS and resolves without waiting for remote completion.

JSON base64 and retained binary messages emit core and legacy MP3 audio. A remote final emits completion once. Duration fields remain estimates, and alignment data is not consumed.

`cancel` closes the socket and emits `cancelled` with pending text. `close` closes the socket and emits `close`. The generic session `language` field is not forwarded. No reconnect or explicit timeout is implemented.

The factory uses an empty key when the secret is absent, unless the runtime options spread overrides `apiKey`. It does not validate credentials or read environment variables.

## Core event compatibility

The session decodes base64 JSON audio envelopes and retains binary MP3 compatibility. Every decoded chunk emits `audio` and the legacy `audio_chunk` in wire order. Subscribe to one audio name. Text fragments are sent once, including when punctuation requests synthesis.

For compatibility, `flush()` resolves after EOS is queued. A remote final event emits `flush_complete` and the legacy `utterance_complete` once. EOS enqueue and socket closure are not completed synthesis. Cancellation discards queued text and blocks a subsequent socket-open event. Duration values remain estimates. This event-only adapter has no awaited output sink, and these aliases do not establish scoped hosted eligibility.

## License

Apache-2.0
