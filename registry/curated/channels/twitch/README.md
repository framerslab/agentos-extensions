# Twitch channel

This pack gives an agent inbound and outbound Twitch IRC chat messaging through `tmi.js`.

## Installation

```bash
npm install @framers/agentos-ext-channel-twitch
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-twitch',
        options: {
          oauthToken: process.env.TWITCH_OAUTH_TOKEN,
          username: process.env.TWITCH_USERNAME,
          channel: process.env.TWITCH_CHANNEL,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `oauthToken` | `twitch.oauthToken` | `TWITCH_OAUTH_TOKEN` | Yes | None |
| `username` | `twitch.username` | `TWITCH_USERNAME`, then `TWITCH_CHANNEL` through channel fallback | Yes, by manifest | Channel name without `#` |
| `channel` | `twitch.channel` | `TWITCH_CHANNEL` | Yes | None |
| `ignoreSelfMessages` | None | None | No | `true` |
| `priority` | None | None | No | `50` |
| `secrets` | `twitch.oauthToken`, `twitch.username`, `twitch.channel` | None | No | None |

Credentials resolve from options, then `options.secrets`, then environment variables. If no username resolves, the code uses the channel from options, secrets or `TWITCH_CHANNEL`, in that order. The manifest declares `twitch.username` required.

## Tools

| Tool | What it does |
| --- | --- |
| `twitchChannelSendMessage` | Send a chat message to a Twitch channel name. |

### `twitchChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target channel name (without `#`) |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `twitch`. Activation connects a `tmi.js` client with a secure connection, automatic reconnection, the configured identity and channel. Incoming IRC messages become channel text events with sender information from IRC tags. Self messages are ignored unless `ignoreSelfMessages` is `false`.

Sending uses the first text block and calls `say` for the target channel. The service uses the configured channel if the target is empty. Channel names accept a leading `#`. Typing indicators do nothing.

## Notes

Creating the pack throws if the OAuth token or channel is missing. Activation rejects an empty normalized token or channel. Tokens accept an `oauth:` prefix, a `Bearer ` prefix or a bare token; the service normalizes them to IRC authentication format.

Sending posts chat text. Returned outbound message IDs are generated locally rather than supplied by Twitch. Shutdown removes client listeners and disconnects the IRC client.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
