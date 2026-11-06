# Discord Channel Extension

Bidirectional Discord messaging for AgentOS via `discord.js`.

## What It Provides

- `discordChannelSendMessage`
- `discordChannelSendMedia`
- `discordChannel`

## Runtime Status

- This is a curated channel pack.
- Channels stay opt-in because they can connect, poll, or receive webhooks.
- Enable it through `createCuratedManifest({ channels: ['discord'] })` or a custom extension manifest.

## Required Secret

- `discord.botToken`

## Direct messages and unmentioned server messages

Three options decide which messages reach the host and where the pack reaches Discord. Each falls back to an environment variable, then to a default that keeps the pack's behaviour as it has always been:

| Option | Environment variable | Values | Default |
|---|---|---|---|
| `directMessages` | `DISCORD_DIRECT_MESSAGES` | `ignore`, `accept` | `ignore` |
| `channelMessages` | `DISCORD_CHANNEL_MESSAGES` | `delayed`, `immediate` | `delayed` |
| `apiBase` | `DISCORD_API_BASE` | the REST API's base address | discord.js's own, `https://discord.com/api` |

```ts
createExtensionPack({
  options: { botToken, directMessages: 'accept', channelMessages: 'immediate' },
});
```

**`directMessages`.** With `ignore`, the pack drops every direct message (its default intents do not ask Discord for them), and a slash command sent in a direct message is answered "Use me in server channels (not DMs)." With `accept`, the pack adds the `DirectMessages` intent to its intents at login, the defaults or the ones the `intents` option names, and turns on discord.js's `Channel` partial. Discord sends a direct message to a bot only under that intent ([gateway intents](https://discord.com/developers/docs/events/gateway#list-of-intents)), a standard intent that needs no switch in the Developer Portal, and a direct message's content arrives without the privileged Message Content intent. discord.js drops a message in a channel it has not cached unless the `Channel` partial is on, and a first direct message from anyone is in such a channel. Each direct message then reaches the host at once, with `conversationType: 'direct'`, and a slash command sent in a direct message runs as it does in a server channel.

**`channelMessages`.** This decides what happens to a server message that neither mentions the bot nor replies to it. A mention or a reply always reaches the host at once. With `delayed`, the pack drops such a message in a feed channel (`#tech-news`, `#world-news` and the others the adapter lists) or when it opens with a greeting or filler word, is five characters or fewer, or is a lone custom emoji or link. It holds any other for two minutes and drops it when anyone else posts in that channel first. With `immediate`, every such message reaches the host at once, and none is dropped, held or cancelled. The host's input guardrails then see every message the bot can read, and the agent's turn decides whether to answer. Each message is a turn, so in a busy server `immediate` costs a model call for every message posted where the bot can read.

**`apiBase`.** This becomes discord.js's `rest.api`, and the gateway's address comes from `GET /gateway/bot` there, as it comes from Discord. Tests point it at a stand-in Discord.

An unknown value of `directMessages` or `channelMessages`, in the options or the environment, fails the pack's creation with an error that names the setting, so a misspelt policy never runs as the default. Environment values are read trimmed and in any case.

## A rejected bot token

When Discord rejects the bot token, the adapter emits one `error` event per start of the service, and the service stops:

```ts
adapter.on((event) => {
  if (event.data?.code === 'auth_failed') {
    // event.data is { code: 'auth_failed', channel: 'discord' }: ask for a new token.
  }
}, ['error']);
```

Discord rejects a token in three ways, and each one counts:

- the login fails with discord.js's `TokenInvalid` error, because the gateway lookup (`GET /gateway/bot`) answered 401; the start rejects with that error;
- a REST call made with the bot token answers 401 (a send, a fetch, the slash command sync); interaction replies use the interaction's own token and do not count;
- the gateway closes the session with code 4004, Authentication failed; discord.js does not reconnect after it.

The event names the channel and carries no token and no message text. A token rejected while the pack activates is rejected before a host can subscribe, so a handler that subscribes for `error` events afterwards gets the event once, right after it subscribes. The service writes one warning, which names no token. `DiscordService` exposes `tokenRejected` and `onTokenRejected(handler)`, and the pack exports `CHANNEL_AUTH_FAILED_CODE` and `isDiscordTokenRejected(err)`, which says whether an error from discord.js is a rejected bot token (a 401 on an interaction's or a webhook's own route is not).

A server error (500 and up) or a dropped connection is not a rejected token: the REST client retries a 5xx three times, as discord.js does, and the channel keeps running.

A slash command sync at start that Discord refuses with a 401 makes the start reject with that error; with `DISCORD_GUILD_ID` set, the sync does not go on to the global commands. If the sync fails for any other reason, the service writes one warning and starts without its slash commands.

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
