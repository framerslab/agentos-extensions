# Google Cloud text-to-speech

This pack registers a text-to-speech provider for the AgentOS voice pipeline. It uses Google Cloud Text-to-Speech through `@google-cloud/text-to-speech`.

## Installation

```bash
npm install @framers/agentos-ext-google-cloud-tts
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `@google-cloud/text-to-speech` (`^5.0.0`).

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-google-cloud-tts' }],
  },
  extensionSecrets: {
    GOOGLE_CLOUD_TTS_CREDENTIALS: process.env.GOOGLE_CLOUD_TTS_CREDENTIALS!,
  },
});
```

## Configuration

`createExtensionPack` takes the first nonblank credential string from the secret `GOOGLE_CLOUD_TTS_CREDENTIALS` (read through `getSecret`, which AgentOS fills from `extensionSecrets`), then the environment variable of the same name. It ignores `options`. With neither set, the Google Cloud SDK uses Application Default Credentials. The standalone `createGoogleCloudTTS(credentials)` factory requires its argument: pass `''` to use Application Default Credentials.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `credentials` | `GOOGLE_CLOUD_TTS_CREDENTIALS` | `GOOGLE_CLOUD_TTS_CREDENTIALS` | No | Empty: Application Default Credentials |
| `languageCode` (per synthesis call) | None | None | No | `en-US` |
| `voice` (per synthesis call) | None | None | No | Unset, Google Cloud selects the language's default voice |

## Notes

Credentials accept an inline service-account JSON object or the path of an existing key file. Blank credentials leave authentication to the SDK's Application Default Credentials. The provider's source names `GOOGLE_APPLICATION_CREDENTIALS`, gcloud and the metadata server as SDK credential sources; the pack does not read that variable itself.

Malformed JSON, a nonblank value that names no file, and a path whose symbolic link followed by `..` resolves to a different file for the client cause registration to throw. Credential errors do not quote the supplied value. File paths are made absolute with symbolic links preserved.

The SDK loads on the first API request. Synthesis sends plain text to Google Cloud and returns the whole MP3 clip as a buffer with MIME type `audio/mpeg`. The provider does not stream. The returned `cost` is a placeholder and does not report API charges.

`listAvailableVoices` returns API voice names as identifiers, the primary language under both `lang` and `languageCode`, the provider identifier, and recognized gender labels in lowercase. It preserves the API response order.

## License

Apache-2.0
