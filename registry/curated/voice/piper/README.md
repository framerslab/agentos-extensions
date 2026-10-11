# Piper

This pack registers an offline text-to-speech provider for the AgentOS voice pipeline. It invokes the local Piper executable through Node's `child_process.spawn` and collects WAV audio from its output.

## Installation

```bash
npm install @framers/agentos-ext-piper
```

Peer dependency: `@framers/agentos` (`>=0.10.40`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-piper';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    binaryPath: process.env.PIPER_BIN,
    modelPath: process.env.PIPER_MODEL_PATH,
    maxBufferBytes: 10485760,
    timeoutMs: 30000,
  },
}));
```

## Configuration

The pack reads no secrets. Explicit paths take precedence over their environment fallbacks.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `binaryPath` | None | `PIPER_BIN` | No | `piper`, resolved through `PATH` |
| `modelPath` | None | `PIPER_MODEL_PATH` | No | `~/.agentos/models/piper/en_US-lessac-medium.onnx`, under the user's home directory |
| `maxBufferBytes` | None | None | No | `10485760` bytes |
| `timeoutMs` | None | None | No | `30000` milliseconds |

## Notes

The Piper executable is installed separately, and a local ONNX voice model file is needed for synthesis. The pack does not install the executable or download the model. Registration stores the paths without starting Piper.

Each `synthesize` call spawns Piper with `--model` and `--output_file -`, writes the text to standard input, and closes that input. Output chunks are collected into a WAV buffer with MIME type `audio/wav`. The provider does not stream audio to the caller.

Synthesis rejects on a spawn error, a nonzero exit code, a timeout, or output exceeding `maxBufferBytes`. The error path sends `SIGTERM` to the process. Standard error output alone does not reject the call.

## License

Apache-2.0
