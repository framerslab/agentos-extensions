# Vosk speech recognition

This pack gives an agent an offline speech recognition provider using the `vosk` native library and a local model directory. It transcribes PCM audio buffers without an HTTP service.

## Installation

```bash
npm install @framers/agentos-ext-vosk
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `vosk` (`^0.3.0`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-vosk';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { modelPath: process.env.VOSK_MODEL_PATH },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `modelPath` | None | `VOSK_MODEL_PATH` | No | `.agentos/models/vosk` under the home directory |
| `sampleRate` (audio input to `transcribe`) | None | None | No | `16000` Hz |

## Notes

The pack registers an enabled `stt-provider` with id `vosk`. `createVoskSTT` also creates a standalone provider accepting `modelPath`.

A downloaded Vosk model must exist on disk. The native library and model load lazily during transcription. The first loaded model is shared across provider instances, even when later instances specify another path. The pack does not download a model or check the path before passing it to the library.

`transcribe` accepts raw little-endian signed PCM bytes in `data` and an optional `sampleRate`. It creates a recognizer for the call, accepts the buffer, reads the final result and frees the recognizer in a `finally` block. Results contain `transcript`, fixed confidence and `isFinal: true`; absent result text becomes an empty string.

The provider advertises `supportsStreaming: true`, but its exposed transcription method processes a batch buffer. It does not expose a streaming session factory or a public recognizer accessor.

## License

Apache-2.0
