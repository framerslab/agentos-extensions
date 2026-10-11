# ElevenLabs streaming speech synthesis

This pack gives an agent a streaming speech synthesis provider using the ElevenLabs WebSocket API through `ws`. It sends text tokens and emits MP3 audio chunks.

## Installation

```bash
npm install @framers/agentos-ext-streaming-tts-elevenlabs
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-streaming-tts-elevenlabs';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { voiceId: '21m00Tcm4TlvDq8ikWAM' },
  getSecret: (id) => id === 'ELEVENLABS_API_KEY' ? 'your-api-key' : undefined,
}));
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

`startSession` opens a WebSocket to ElevenLabs. On opening, it sends the API key and voice settings, then drains queued messages. `pushTokens` sends text and also sends the accumulated segment with `flush: true` when sentence punctuation arrives. `flush` sends remaining text and an empty end-of-stream message; it resolves when messages are queued, without waiting for audio completion.

Binary messages emit `audio_chunk` with MP3 bytes and empty associated text. A JSON `isFinal` message emits `utterance_complete`. Duration fields are estimates from the pending text rather than measurements of the audio. Other JSON messages, including alignment data, are ignored.

`cancel` closes the socket and emits `cancelled` with pending text. `close` closes the socket and emits `close`. The generic session `language` field is not forwarded. No reconnect or explicit timeout is implemented.

The factory uses an empty key when the secret is absent, unless the runtime options spread overrides `apiKey`. It does not validate credentials or read environment variables.

## License

Apache-2.0
