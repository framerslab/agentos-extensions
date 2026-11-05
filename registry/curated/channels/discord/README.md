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
