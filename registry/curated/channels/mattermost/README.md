# Mattermost channel

This pack gives an agent outbound Mattermost posts through REST using `fetch` and inbound message events through WebSocket using `ws`.

## Installation

```bash
npm install @framers/agentos-ext-channel-mattermost
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-mattermost',
        options: {
          url: process.env.MATTERMOST_URL,
          token: process.env.MATTERMOST_TOKEN,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `url` | `mattermost.url` | `MATTERMOST_URL` | Yes | None |
| `token` | `mattermost.token` | `MATTERMOST_TOKEN` | Yes | None |
| `reconnectDelayMs` | | | No | `2500` milliseconds |
| `priority` | | | No | `50` |
| `secrets` | | | No | None |
| Context `logger` | | | No | `console` for service logging |

Credentials resolve from options, then option `secrets`, then environment variables. URLs without an HTTP scheme receive `https://`; trailing slashes are removed.

## Tools

| Tool | What it does |
| --- | --- |
| `mattermostChannelSendMessage` | Sends a text message through the Mattermost channel. |

### `mattermostChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target Mattermost channel id |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `mattermost`. Activation looks up the authenticated user through REST and opens a WebSocket connection. On opening, the socket sends an `authentication_challenge` containing the token. Received `posted` events with nonempty text become message events. Channel type `D` maps to direct conversations; other types map to groups. Self echoes are ignored when the authenticated user id is known.

Outbound text blocks create posts with bearer authentication. The adapter maps `replyToMessageId` to `root_id` for thread replies; the tool exposes only channel id and text. Typing indicators do nothing. The socket reconnects after closing while the service is running.

## Notes

Sending creates posts in the target Mattermost channel. Missing URL or token causes a factory error. Sending requires a running service, a nonempty channel id and nonempty text. Failed REST sends return an error containing the response status and body. A failed authenticated-user lookup does not prevent the WebSocket connection attempt, but leaves self-echo filtering without a user id.

The connection reports connected when the socket opens, before authentication confirmation is processed. WebSocket errors are recorded and close the socket. Reconnect delays have a minimum of half a second. Shutdown cancels reconnect timers, closes the socket and clears handlers. The implementation uses `fetch` and `ws`; it does not import the SDK named in the manifest.

Node.js requirement: `>=22`.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
