# Nextcloud Talk channel

This pack gives an agent a text messaging tool and a channel adapter for Nextcloud Talk. It uses the Talk Bot API for outbound messages and signed HTTP webhooks for inbound messages.

## Installation

```bash
npm install @framers/agentos-ext-channel-nextcloud
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-nextcloud',
        options: {
          url: process.env.NEXTCLOUD_URL,
          token: process.env.NEXTCLOUD_TOKEN,
          apiUser: process.env.NEXTCLOUD_API_USER,
          apiPassword: process.env.NEXTCLOUD_API_PASSWORD,
          webhookPath: process.env.NEXTCLOUD_TALK_WEBHOOK_PATH,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then the environment.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `url` | `nextcloud.url` | `NEXTCLOUD_URL` | yes | None |
| `token` | `nextcloud.token` | `NEXTCLOUD_TOKEN` | yes | None |
| `apiUser` | `nextcloud.apiUser` | `NEXTCLOUD_API_USER` | no | None |
| `apiPassword` | `nextcloud.apiPassword` | `NEXTCLOUD_API_PASSWORD` | no | None |
| `webhookPath` | None | `NEXTCLOUD_TALK_WEBHOOK_PATH` | no | `/nextcloud-talk-webhook` |
| `skipSignatureValidation` | None | None | no | `false` |
| `maxBodyBytes` | None | None | no | `1024 * 1024` bytes |
| `priority` | None | None | no | `50` |
| `secrets` | Credential ids above | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `nextcloudChannelSendMessage` | Sends a text message through the Nextcloud Talk channel adapter. |

### `nextcloudChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Target room token |
| `text` | string | yes | Message text |
| `replyToMessageId` | string | no | Optional `messageId` to reply to |

## Channel adapter

The adapter registers platform `nextcloud-talk`. It sends the first text block to a room token and forwards `replyToMessageId` as a reply. The HTTP handler receives signed webhook requests and emits text messages from `Create` events that contain a room token, sender and text. Activation initializes the service; inbound delivery uses the host HTTP server.

## Notes

Sending posts a message to Nextcloud Talk. The server needs the Bot API enabled and a bot shared secret from `occ talk:bot:install`. Missing `url` or `token` makes pack creation throw.

The webhook handler verifies signatures unless `skipSignatureValidation` is `true`. It rejects bodies above `maxBodyBytes`. Without both `apiUser` and `apiPassword`, or when room lookup fails, inbound messages are treated as group messages. Typing indicators are not supported.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
