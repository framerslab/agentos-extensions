# Zalo channel

This pack gives an agent text messaging through the Zalo Bot API using HTTP requests, with inbound updates from long polling or a registered webhook handler.

## Installation

```bash
npm install @framers/agentos-ext-channel-zalo
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-zalo',
        options: { botToken: process.env.ZALO_BOT_TOKEN },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `botToken` | `zalo.botToken` | `ZALO_BOT_TOKEN` | Yes | None |
| `webhookSecret` | `zalo.webhookSecret` | `ZALO_WEBHOOK_SECRET` | No | Empty string |
| `webhookPath` | None | `ZALO_WEBHOOK_PATH` | No | `/zalo-webhook` |
| `poll` | None | None | No | Enabled unless `false` or a webhook secret resolves |
| `pollTimeoutSec` | None | None | No | `30` seconds |
| `maxBodyBytes` | None | None | No | `1024 * 1024` bytes |
| `priority` | None | None | No | `50` |
| `secrets` | `zalo.botToken`, `zalo.webhookSecret` | None | No | None |

Token and webhook secret resolve from options, then `options.secrets`, then environment variables. Webhook secrets are trimmed. Webhook paths gain a leading slash and lose a trailing slash. A webhook secret disables polling even if `poll` is `true`.

## Tools

| Tool | What it does |
| --- | --- |
| `zaloChannelSendMessage` | Send a text message through the Zalo channel adapter. |

### `zaloChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target Zalo user/thread ID |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `zalo`. Sending uses the first text block and posts it to the Bot API's `sendMessage` endpoint. Incoming polling or webhook updates become direct or group text events. It uses message text or a caption, with `<media:image>` and `<media:sticker>` fallbacks for image and sticker events. Updates without chat ID, sender ID or usable text are ignored. Typing indicators do nothing.

Activation initializes the service and starts polling when enabled. The pack also registers the `zaloWebhook` HTTP handler. With a webhook secret set, the handler accepts requests at `webhookPath`, answers GET requests, and requires POST requests to carry a matching `x-bot-api-secret-token` header. Valid payloads are acknowledged and passed to the adapter. The pack does not start an HTTP server or register the webhook URL with Zalo.

## Notes

Creating the pack throws if no bot token resolves. Sending trims the target and text, rejects empty values and truncates messages to `2000` characters. Sends change the target chat's content. If the API supplies no message ID, the service generates one locally.

Polling timeouts are floored and clamped between `5` and `60` seconds; the HTTP request deadline adds `5` seconds. Polling API timeout errors are ignored, while other errors log a warning and pause for `2500` ms before continuing. Send requests have no explicit timeout.

Webhook bodies default to a `1024 * 1024`-byte limit. A positive finite `maxBodyBytes` overrides it. Missing or mismatched secret headers, oversized bodies, invalid payloads and unsupported methods receive error responses. With `poll: false` and no webhook secret, neither inbound transport runs.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
