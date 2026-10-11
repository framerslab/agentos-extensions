# IRC channel

This pack gives an agent inbound and outbound IRC text messaging through TCP or TLS using `node:net` and `node:tls`.

## Installation

```bash
npm install @framers/agentos-ext-channel-irc
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-irc',
        options: {
          host: process.env.IRC_HOST,
          nick: process.env.IRC_NICK,
          channels: process.env.IRC_CHANNELS?.split(','),
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `host`, `irc.host` | `irc.host` | `IRC_HOST` | Yes | None |
| `port` | `irc.port` | `IRC_PORT` | Yes, manifest | `6667` |
| `tls` | `irc.tls` | `IRC_TLS` | No | `false` |
| `nick`, `irc.nick` | `irc.nick` | `IRC_NICK` | Yes | None |
| `username`, `irc.username` | `irc.username` | `IRC_USERNAME` | No | Resolved `nick` |
| `realname`, `irc.realname` | `irc.realname` | `IRC_REALNAME` | No | `AgentOS` |
| `password`, `irc.password` | `irc.password` | `IRC_PASSWORD` | No | None |
| `channels` | `irc.channels` | `IRC_CHANNELS` | Yes | None |
| `nickServ.password`, `irc.nickservPassword` | `irc.nickservPassword` | `IRC_NICKSERV_PASSWORD` | No | Empty string |
| `nickServ.service`, `irc.nickservService` | `irc.nickservService` | `IRC_NICKSERV_SERVICE` | No | `NickServ` |
| `autoReconnect` | | | No | `true` |
| `connectTimeoutMs` | | | No | `15000` milliseconds |
| `messageChunkMaxChars` | | | No | `350` characters |
| `priority` | | | No | `20` |
| `secrets` | | | No | None |
| Context `logger` | | | No | None |

The factory reads secrets from option `secrets`. String settings listed with dotted option names also accept those keys in `options`. Channel secrets and environment values are comma-separated lists. Channels without a `#` or `&` prefix receive a `#` prefix. The manifest marks `irc.port` as required even though the code supplies a default.

## Tools

| Tool | What it does |
| --- | --- |
| `ircSendMessage` | Sends a text message to an IRC channel or user nick. |

### `ircSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target channel (e.g. #general) or nick. |
| `text` | string | Yes | Message text. |

## Channel adapter

The adapter registers platform `irc`. It connects over TCP or TLS, sends the IRC handshake, joins configured channels after the welcome response and optionally identifies with NickServ. It responds to `PING` with `PONG` and reconnects when enabled. Received `PRIVMSG` lines become message events, with channel targets mapped to group conversations and other targets mapped to direct conversations using the sender's nick.

Outbound messages use a text block and are sent as `PRIVMSG`. Newlines become spaces and long text is split according to `messageChunkMaxChars`. Typing indicators do nothing.

## Notes

Sending writes messages to the configured IRC server. Missing host, nick or channels cause factory errors. Sending requires a connected, ready socket and nonempty target and text. Socket connection failures are recorded in connection status and trigger retries after `3000` ms when `autoReconnect` is enabled. Shutdown sends `QUIT` and destroys the socket.

Node.js requirement: `>=22`.

## License

Apache-2.0
