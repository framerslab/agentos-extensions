# iMessage channel

This pack gives an agent a text messaging tool and an inbound webhook adapter for iMessage through the BlueBubbles HTTP bridge. The manifest requires a macOS server.

## Installation

```bash
npm install @framers/agentos-ext-channel-imessage
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-imessage',
        options: {
          serverUrl: process.env.IMESSAGE_SERVER_URL ?? process.env.BLUEBUBBLES_SERVER_URL,
          password: process.env.IMESSAGE_PASSWORD ?? process.env.BLUEBUBBLES_PASSWORD,
          webhookPath: process.env.BLUEBUBBLES_WEBHOOK_PATH ?? process.env.IMESSAGE_WEBHOOK_PATH,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then environment variables.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `serverUrl` | `imessage.serverUrl` | `IMESSAGE_SERVER_URL`, `BLUEBUBBLES_SERVER_URL` | Yes | None; throws when missing |
| `password` | `imessage.password` | `IMESSAGE_PASSWORD`, `BLUEBUBBLES_PASSWORD` | Yes | None; throws when missing |
| `webhookPath` | None | `BLUEBUBBLES_WEBHOOK_PATH`, `IMESSAGE_WEBHOOK_PATH` | No | `/bluebubbles-webhook` |
| `maxBodyBytes` | None | None | No | `1048576` |
| `priority` | None | None | No | `50` |
| `secrets` | None | None | No | Unset |

The server URL is trimmed, gains `http://` when no HTTP scheme is present and loses trailing slashes. The webhook path gains a leading slash and loses a trailing slash. Invalid or nonpositive `maxBodyBytes` values use the default.

## Tools

| Tool | What it does |
| --- | --- |
| `imessageChannelSendMessage` | Sends a text message through the iMessage BlueBubbles adapter. |

### `imessageChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target BlueBubbles `chatGuid` (conversation ID) |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `imessage`. Activation marks the service connected. Sending posts the first text block to `/api/v1/message/text` with the conversation's `chatGuid`, a generated `tempGuid` and the password as a query parameter.

The `imessageWebhook` HTTP handler receives BlueBubbles JSON payloads and dispatches message events. It accepts nested message data, derives sender and chat identifiers, and maps group or direct chats using the chat GUID or explicit group flags. It ignores messages sent by the bridge's own user and messages without a sender or chat GUID. Messages without text become `<media:message>`. Typing indicators do nothing.

## Notes

Sending creates remote messages and requires a BlueBubbles macOS server. Missing server URL or password throws during pack creation. Sending before activation or with an empty conversation ID or text fails. Successful responses without a message identifier return `ok`.

Webhook GET requests return a health response. POST requests authenticate against the configured password. Header precedence is `x-guid`, `x-password`, `x-bluebubbles-guid`, then `authorization`; without a header, query parameters use `guid`, then `password`. A bearer prefix is removed before comparison.

Authentication failures, oversized request bodies and invalid JSON are rejected. Other HTTP methods are rejected. Requests outside the configured webhook path are not handled.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
