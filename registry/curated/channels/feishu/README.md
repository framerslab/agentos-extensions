# Feishu channel

This pack gives an agent a text messaging tool and an inbound webhook adapter for Feishu and Lark using `@larksuiteoapi/node-sdk`.

## Installation

```bash
npm install @framers/agentos-ext-channel-feishu
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-feishu',
        options: {
          appId: process.env.FEISHU_APP_ID,
          appSecret: process.env.FEISHU_APP_SECRET,
          verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
          encryptKey: process.env.FEISHU_ENCRYPT_KEY,
          domain: process.env.FEISHU_DOMAIN,
          webhookPath: process.env.FEISHU_WEBHOOK_PATH,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then environment variables. Verification tokens and encryption keys are trimmed.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `appId` | `feishu.appId` | `FEISHU_APP_ID` | Yes | None; throws when missing |
| `appSecret` | `feishu.appSecret` | `FEISHU_APP_SECRET` | Yes | None; throws when missing |
| `verificationToken` | `feishu.verificationToken` | `FEISHU_VERIFICATION_TOKEN` | Yes, in manifest | `''` |
| `encryptKey` | `feishu.encryptKey` | `FEISHU_ENCRYPT_KEY` | Yes, in manifest | `''` |
| `domain` | None | `FEISHU_DOMAIN` | No | `feishu` |
| `webhookPath` | None | `FEISHU_WEBHOOK_PATH` | No | `/feishu-webhook` |
| `maxBodyBytes` | None | None | No | `1048576` |
| `priority` | None | None | No | `50` |
| `secrets` | None | None | No | Unset |

The domain accepts `feishu`, `lark` or a custom URL. The webhook path gains a leading slash and loses a trailing slash. Invalid or nonpositive `maxBodyBytes` values use the default.

## Tools

| Tool | What it does |
| --- | --- |
| `feishuChannelSendMessage` | Sends a text message through the Feishu/Lark adapter. |

### `feishuChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target Feishu `chat_id` |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `feishu`. Activation starts the service using a self-built Lark client; the SDK handles the tenant access token. Sending uses the first text block and addresses the conversation as a `chat_id`.

The `feishuWebhook` HTTP handler delegates token validation and challenge responses to the SDK. It receives `im.message.receive_v1` events and dispatches nonempty text messages to subscribed handlers. A `p2p` chat maps to a direct conversation; other chat types map to group conversations. Sender IDs use `open_id`, then `user_id`, then `unknown`. Typing indicators do nothing.

## Notes

Sending creates remote messages. The service trims the chat ID and message text and rejects empty values or sends before activation. Missing app credentials throw during pack creation.

Without a verification token, the webhook accepts GET health requests and rejects other requests as unavailable. Activation logs a warning. The encryption key is optional in the runtime code despite the manifest requirement. Requests outside the configured path are not handled. The body guard destroys requests that exceed `maxBodyBytes`.

## License

Apache-2.0
