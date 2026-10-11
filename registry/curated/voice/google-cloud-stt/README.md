# Google Cloud speech-to-text

This pack registers a batch speech-to-text provider for the AgentOS voice pipeline. It sends audio to Google Cloud Speech-to-Text through `@google-cloud/speech`.

## Installation

```bash
npm install @framers/agentos-ext-google-cloud-stt
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `@google-cloud/speech` (`^6.0.0`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-google-cloud-stt' }],
  },
  extensionSecrets: {
    GOOGLE_CLOUD_STT_CREDENTIALS: process.env.GOOGLE_CLOUD_STT_CREDENTIALS!,
  },
});
```

## Configuration

`createExtensionPack` takes the first nonblank credential string from the secret `GOOGLE_CLOUD_STT_CREDENTIALS` (read through `getSecret`, which AgentOS fills from `extensionSecrets`), then the environment variable of the same name. It ignores `options`. With neither set, the Google Cloud SDK uses Application Default Credentials. The standalone `createGoogleCloudSTT(credentials)` factory requires its argument: pass `''` to use Application Default Credentials.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `credentials` | `GOOGLE_CLOUD_STT_CREDENTIALS` | `GOOGLE_CLOUD_STT_CREDENTIALS` | No | Empty: Application Default Credentials |
| `language` (per transcription call) | None | None | No | `en-US` |
| `sampleRate` (audio input) | None | None | No | `16000` Hz for raw PCM; header rate for WAV or FLAC |

## Notes

Credentials accept an inline service-account JSON object or the path of an existing key file. Blank credentials leave authentication to the SDK's Application Default Credentials. The provider's source names `GOOGLE_APPLICATION_CREDENTIALS`, gcloud and the metadata server as SDK credential sources; the pack does not read that variable itself.

Malformed JSON, a nonblank value that names no file, and a path whose symbolic link followed by `..` resolves to a different file for the client cause registration to throw. Credential errors do not quote the supplied value. File paths are made absolute with symbolic links preserved.

The provider sends audio bytes as base64 for batch recognition and does not stream. WAV and FLAC headers determine encoding; other buffers are sent as `LINEAR16` PCM. `mimeType` and `format` are informational and do not select encoding. An explicit `sampleRate` is forwarded for headered audio too.

The result joins each recognized stretch's most likely transcript and returns a final result with the raw provider response. Segment timing is included only when every stretch has an end time. Confidence is averaged over reported confidence values. The returned `cost` does not report API charges.

## License

Apache-2.0
