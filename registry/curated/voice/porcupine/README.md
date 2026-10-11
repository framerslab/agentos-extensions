# Porcupine wake word detection

This pack gives an agent a wake word provider backed by Picovoice Porcupine through `@picovoice/porcupine-node`.

## Installation

```bash
npm install @framers/agentos-ext-porcupine
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `@picovoice/porcupine-node` (`^3.0.0`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-porcupine';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { keywords: ['porcupine'] },
  getSecret: (id) => id === 'PICOVOICE_ACCESS_KEY' ? 'your-access-key' : undefined,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessKey` (standalone provider only) | `PICOVOICE_ACCESS_KEY` (pack factory) | None | Yes, provider interface | Empty string in pack factory |
| `keywords` | None | None | No | `['porcupine']` |
| `sensitivities` | None | None | No | `0.5` per keyword |

## Notes

The pack registers a `wake-word-provider` with id `porcupine`, enabled by default. The factory reads the access key through `getSecret`; it does not read an environment variable or an `accessKey` option.

`createPorcupine` also exports a standalone provider factory accepting `accessKey`, `keywords` and `sensitivities`. The sensitivity array must match the keyword array in length, according to the options interface.

The native SDK loads on the first `detect` call. Audio frames must match the SDK frame size and use signed PCM at its fixed sample rate; the provider ignores the supplied sample rate argument. Detection returns an object containing `keyword`, `confidence` and `providerId`, or `null`. `reset` does nothing; `dispose` releases the native engine. The pack passes an empty access key to the SDK when the secret is absent and does not validate it itself.

## License

Apache-2.0
