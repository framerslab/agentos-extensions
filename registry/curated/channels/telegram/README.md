# Telegram Channel Extension

Bidirectional Telegram messaging for AgentOS via `grammY`.

## What It Provides

- `telegramChannelSendMessage`
- `telegramChannelSendMedia`
- `telegramChannel`

## Runtime Status

- This is a curated channel pack.
- Channels stay opt-in because they can connect, poll, or receive webhooks.
- Enable it through `createCuratedManifest({ channels: ['telegram'] })` or a custom extension manifest.

## Required Secret

- `telegram.botToken`

## Telegram Business updates

A Telegram Business account can connect a bot to its private chats, and Telegram then sends that bot `business_connection`, `business_message`, `edited_business_message` and `deleted_business_messages` updates. To keep a bot out of those chats, turn business updates off:

```ts
createExtensionPack({ options: { botToken, dropBusinessUpdates: true } });
```

or set `TELEGRAM_BUSINESS_UPDATES=off` in the environment, which makes `dropBusinessUpdates` default to `true` (an explicit `dropBusinessUpdates: false` wins over it).

With business updates off:

- Long polling sends `getUpdates` an `allowed_updates` list of grammY's default update kinds (`API_CONSTANTS.DEFAULT_UPDATE_TYPES`) less the four business kinds, and a webhook is registered with the same list, so Telegram stops delivering them. `chat_member`, `message_reaction` and `message_reaction_count` stay off, as they are by default.
- A business update that still arrives, one Telegram queued before the list changed, is dropped before any handler runs. The pack writes one warning a minute at most, with the count and the kinds and nothing from the update itself.

The list is exported as `TELEGRAM_BUSINESS_UPDATE_TYPES`, and `allowedUpdatesWithoutBusiness()` returns the `allowed_updates` list the pack sends. The list is read from grammY's `API_CONSTANTS`, which grammY exports from 1.21.1 on, so the pack depends on `grammy` `^1.21.1`.

## A rejected bot token

When Telegram rejects the bot token (a 401 on any Bot API call), the adapter emits one `error` event per start of the service, and the service stops polling:

```ts
adapter.on((event) => {
  if (event.data?.code === 'auth_failed') {
    // event.data is { code: 'auth_failed', channel: 'telegram' }: ask for a new token.
  }
}, ['error']);
```

- At start, grammY's first call (`getMe`), or `setWebhook` for a webhook bot, answers 401: the start rejects with that error.
- While polling, `getUpdates` answers 401: grammY ends its polling loop.
- While the channel runs, any other call answers 401 (a send, an edit, a lookup): the service stops and ends the polling loop.

The event names the channel and carries no token and no message text. A token rejected while the pack activates is rejected before a host can subscribe, so a handler that subscribes for `error` events afterwards gets the event once, right after it subscribes. The service writes one warning, which names no token. `TelegramService` exposes `tokenRejected` and `onTokenRejected(handler)`, and the pack exports `CHANNEL_AUTH_FAILED_CODE` and `isTelegramTokenRejected(err)`.

A server error (500 and up) or a dropped connection is not a rejected token: grammY waits 3 s and polls again, and the channel keeps running.

## Bot API server

The pack calls `https://api.telegram.org` unless told otherwise. To use a [local Bot API server](https://core.telegram.org/bots/api#using-a-local-bot-api-server), or a test server, pass its address without a trailing slash:

```ts
createExtensionPack({ options: { botToken, apiRoot: 'http://127.0.0.1:8081' } });
```

or set `TELEGRAM_API_ROOT` in the environment. The option wins over the variable. The bot token is part of every request's path, so point it only at a server you run.

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
