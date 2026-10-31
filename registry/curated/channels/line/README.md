# LINE channel

This pack gives an agent outbound text messaging and inbound webhook messages through the LINE Messaging API using `@line/bot-sdk`.

## Installation

```bash
npm install @framers/agentos-ext-channel-line
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-line',
        options: {
          channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
          channelSecret: process.env.LINE_CHANNEL_SECRET,
          webhookPath: process.env.LINE_WEBHOOK_PATH,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `channelAccessToken` | `line.channelAccessToken` | `LINE_CHANNEL_ACCESS_TOKEN` | Yes | None |
| `channelSecret` | `line.channelSecret` | `LINE_CHANNEL_SECRET` | Yes | None |
| `webhookPath` | | `LINE_WEBHOOK_PATH` | No | `/webhooks/line` |
| `skipSignatureValidation` | | | No | `false` |
| `maxBodyBytes` | | | No | `1048576` bytes |
| `priority` | | | No | `50` |
| `secrets` | | | No | None |
| Context `logger` | | | No | `console` for webhook errors |

Credentials resolve from options, then option `secrets`, then environment variables. The webhook path matches the path configured in LINE Developers Console; a missing leading slash is added.

## Tools

| Tool | What it does |
| --- | --- |
| `lineChannelSendMessage` | Sends a text message through the LINE channel. |

### `lineChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target LINE conversation/user/group/room ID |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `line` and initializes a `MessagingApiClient`. It sends text using a cached reply token when available, otherwise it pushes the message to the conversation. The tool calls the service directly and always uses push messaging. Conversation ids can have `line:`, `line:user:`, `line:group:` or `line:room:` prefixes, which are removed before sending.

The pack registers the `lineWebhook` HTTP handler at `webhookPath`. It checks the `x-line-signature` header with HMAC unless `skipSignatureValidation` is true. It acknowledges accepted requests before processing events asynchronously. Inbound text messages from users, groups and rooms become message events; other message types are ignored. Typing indicators do nothing.

## Notes

Sending delivers text to LINE recipients. Missing credentials cause factory errors. Sending requires an initialized client, a nonempty conversation id and nonempty text. Returned message ids are generated locally.

The webhook accepts unsigned verification payloads with an empty `events` array. Other unsigned requests are rejected even when `skipSignatureValidation` is true. Invalid signatures and invalid JSON are rejected, and bodies exceeding `maxBodyBytes` are rejected. The host must route requests to the registered HTTP handler. Cached reply tokens expire after a minute; shutdown clears them and the event handlers.

Node.js requirement: `>=22`.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
