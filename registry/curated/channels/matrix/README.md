# Matrix channel

This pack gives an agent inbound and outbound Matrix text messaging through `@vector-im/matrix-bot-sdk`.

## Installation

```bash
npm install @framers/agentos-ext-channel-matrix
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-channel-matrix';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    homeserverUrl: process.env.MATRIX_HOMESERVER_URL,
    accessToken: process.env.MATRIX_ACCESS_TOKEN,
  },
  logger: console,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `homeserverUrl` | `matrix.homeserverUrl` | `MATRIX_HOMESERVER_URL` | Yes | None |
| `accessToken` | `matrix.accessToken` | `MATRIX_ACCESS_TOKEN` | Yes | None |
| `detectDirectRooms` | | | No | `true` |
| `priority` | | | No | `50` |
| `secrets` | | | No | None |
| Context `logger` | | | No | `console` for service logging |

Credentials resolve from options, then option `secrets`, then environment variables.

## Tools

| Tool | What it does |
| --- | --- |
| `matrixChannelSendMessage` | Sends a text message through the Matrix channel. |

### `matrixChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target Matrix room ID (e.g., `!room:server`) |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `matrix`. Activation starts a `MatrixClient` with the homeserver URL, access token and `MemoryStorageProvider`, and configures `AutojoinRoomsMixin`. Received room messages with a body and type `m.text`, `m.notice` or no message type become message events. Messages from the client's own user id are ignored once that id is known.

Direct-room detection uses SDK DM hints, joined-member counts and `m.room.member` state flags. Disabling `detectDirectRooms` classifies inbound conversations as groups. Outbound text blocks are sent as `m.text` messages to the room id. Typing indicators call the SDK's `setTyping` method; errors are ignored.

## Notes

Sending writes messages to Matrix rooms. Activation starts sync and enables automatic room joining through the SDK mixin. It also sets the SDK's global `LogService` level to `LogLevel.ERROR`. Sync storage and the direct-room caches are held in memory. DM hints and member counts use `30000` ms cache intervals. Typing requests use a `10000` ms timeout.

Missing homeserver URL or access token causes a factory error. Sending requires an initialized client, a nonempty room id and nonempty text. Startup failures are recorded in connection status and rethrown. Shutdown stops the client and clears caches and handlers. Outbound replies and rich formatting are not added by the send implementation.

Node.js requirement: `>=22`.

## License

Apache-2.0
