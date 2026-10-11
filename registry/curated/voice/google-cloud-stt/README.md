# Google Cloud speech-to-text

This pack registers a batch speech-to-text provider for the AgentOS voice pipeline. It sends audio to Google Cloud Speech-to-Text through `@google-cloud/speech`.

## Installation

```bash
npm install @framers/agentos-ext-google-cloud-stt
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `@google-cloud/speech` (`^6.0.0`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-google-cloud-stt';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  getSecret: (id) => id === 'GOOGLE_CLOUD_STT_CREDENTIALS'
    ? process.env.GOOGLE_CLOUD_STT_CREDENTIALS
    : undefined,
}));
```

## Configuration

The factory takes the first nonblank credential string from the secret, then the environment variable. It ignores `options`. `credentials` is also the argument to the standalone `createGoogleCloudSTT` factory.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `credentials` (standalone argument) | `GOOGLE_CLOUD_STT_CREDENTIALS` | `GOOGLE_CLOUD_STT_CREDENTIALS` | No | Empty string, uses Application Default Credentials |
| `language` (per transcription call) | None | None | No | `en-US` |
| `sampleRate` (audio input) | None | None | No | `16000` Hz for raw PCM; header rate for WAV or FLAC |

## Notes

Credentials accept an inline service-account JSON object or the path of an existing key file. Blank credentials leave authentication to the SDK's Application Default Credentials. The provider's source names `GOOGLE_APPLICATION_CREDENTIALS`, gcloud and the metadata server as SDK credential sources; the pack does not read that variable itself.

Malformed JSON, a nonblank value that names no file, and a path whose symbolic link followed by `..` resolves to a different file for the client cause registration to throw. Credential errors do not quote the supplied value. File paths are made absolute with symbolic links preserved.

The provider sends audio bytes as base64 for batch recognition and does not stream. WAV and FLAC headers determine encoding; other buffers are sent as `LINEAR16` PCM. `mimeType` and `format` are informational and do not select encoding. An explicit `sampleRate` is forwarded for headered audio too.

The result joins each recognized stretch's most likely transcript and returns a final result with the raw provider response. Segment timing is included only when every stretch has an end time. Confidence is averaged over reported confidence values. The returned `cost` does not report API charges.

## License

Apache-2.0
