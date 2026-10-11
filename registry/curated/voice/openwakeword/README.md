# OpenWakeWord

This pack registers a wake-word provider for the AgentOS voice pipeline. It runs a local OpenWakeWord ONNX model through `onnxruntime-node` using audio energy and zero-crossing features.

## Installation

```bash
npm install @framers/agentos-ext-openwakeword
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `onnxruntime-node` (`^1.17.0`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-openwakeword';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    modelPath: process.env.OPENWAKEWORD_MODEL_PATH,
    threshold: 0.5,
    keyword: 'hey mycroft',
  },
}));
```

## Configuration

The pack reads no secrets. An explicit `modelPath` takes precedence over its environment fallback.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `modelPath` | None | `OPENWAKEWORD_MODEL_PATH` | No | `~/.agentos/models/openwakeword/hey_mycroft.onnx`, under the user's home directory |
| `threshold` | None | None | No | `0.5` |
| `keyword` | None | None | No | `hey mycroft` |

## Notes

A local ONNX model file and the runtime peer dependency are needed for detection. The session loads on the first `detect` call; the pack does not download a model.

`detect` accepts signed PCM frames as `Int16Array`. The sample-rate argument is informational and is not validated or used to resample audio. The model receives a `float32` tensor named `input` containing normalized RMS energy and zero-crossing rate. Its input must accept that feature layout. The provider reads the leading probability from the leading output tensor.

A probability strictly greater than `threshold` returns `keyword`, `confidence` and `providerId`. Other results return `null`. `keyword` labels the detection and does not select the model. `reset` has no effect. `dispose` releases the loaded session when a release method exists and clears its reference.

## License

Apache-2.0
