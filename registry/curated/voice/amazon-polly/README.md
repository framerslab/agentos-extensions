# Amazon Polly

This pack registers a text-to-speech provider for the AgentOS voice pipeline. It uses Amazon Polly through `@aws-sdk/client-polly`.

## Installation

```bash
npm install @framers/agentos-ext-amazon-polly
```

Peer dependencies: `@framers/agentos` (`>=0.10.40`) and `@aws-sdk/client-polly` (`^3.0.0`).

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-amazon-polly';

const extensionManager = new ExtensionManager();
const secrets: Record<string, string | undefined> = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_REGION: process.env.AWS_REGION,
};

extensionManager.register(createExtensionPack({
  getSecret: (id) => secrets[id],
}));
```

## Configuration

The pack factory reads secrets through `getSecret`. It does not read environment variables or `options`. The example supplies environment values through that callback. Credential option names below belong to the standalone `createAmazonPollyTTS` factory.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessKeyId` (standalone) | `AWS_ACCESS_KEY_ID` | None | Yes for standalone credentials | Empty string in the pack factory |
| `secretAccessKey` (standalone) | `AWS_SECRET_ACCESS_KEY` | None | Yes for standalone credentials | Empty string in the pack factory |
| `region` (standalone) | `AWS_REGION` | None | No | `us-east-1` |
| `voice` (per synthesis call) | None | None | No | `Joanna` |

## Notes

The provider sends text to Amazon Polly using the neural engine and returns a fully collected MP3 buffer with MIME type `audio/mpeg`. `listAvailableVoices` maps the voices returned by the API to voice identifiers, names, language codes and genders.

The SDK loads when the provider makes an API request. The pack factory substitutes empty strings for missing credential secrets and does not reject them during registration. The returned `cost` is a placeholder and does not report API charges.

## License

Apache-2.0
