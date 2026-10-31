# Tlon channel

This pack gives an agent direct and group text messaging on Tlon through an Urbit ship's HTTP API and SSE subscriptions. It uses `@urbit/aura` to format direct-message identifiers.

## Installation

```bash
npm install @framers/agentos-ext-channel-tlon
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-tlon',
        options: {
          shipUrl: process.env.TLON_SHIP_URL,
          code: process.env.TLON_CODE,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `shipUrl` | `tlon.shipUrl` | `TLON_SHIP_URL` | Yes | None |
| `code` | `tlon.code` | `TLON_CODE` | Yes | None |
| `groupChannels` | None | `TLON_GROUP_CHANNELS` | No | `[]` |
| `autoSubscribeDms` | None | None | No | `true` |
| `autoReconnect` | None | None | No | `true` |
| `priority` | None | None | No | `50` |
| `secrets` | `tlon.shipUrl`, `tlon.code` | None | No | None |

Credentials resolve from options, then `options.secrets`, then environment variables. A nonempty `groupChannels` array overrides the comma-separated `TLON_GROUP_CHANNELS` value. Group subscription targets use `chat/~host/channel`.

## Tools

| Tool | What it does |
| --- | --- |
| `tlonChannelSendMessage` | Send a text message through the Tlon/Urbit channel adapter. |

### `tlonChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target: `dm/~ship` \| `~ship` \| `chat/~host/channel` \| `group:~host/channel` |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `tlon`. Activation authenticates with `code` at `/~/login`, reads the ship name from `/~/name`, and opens an SSE stream at `/~/channel/<id>`. It discovers direct-message subscriptions through `/~/scry/chat/dm.json` when `autoSubscribeDms` is enabled and subscribes to configured group channels.

Sending uses the first text block. Direct messages poke the `chat` app with `chat-dm-action`; group messages poke the `channels` app with `channel-action-1`. Inbound direct messages, group posts and group replies become text message events. Empty text and messages authored by the connected ship are ignored. Typing indicators do nothing.

## Notes

An Urbit ship URL and login code are required. Creating the pack throws if either credential is missing. URLs without a scheme receive `http://`. Sending trims text and rejects empty text or an invalid target. Messages are sent to the selected ship or group channel.

Login requests time out after `15000` ms; ship-name, channel-write and scry requests time out after `30000` ms. SSE reconnection uses exponential delay capped at `30000` ms when `autoReconnect` is enabled. Failed direct-message discovery logs a warning and allows group subscriptions to continue.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
