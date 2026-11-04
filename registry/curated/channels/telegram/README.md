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

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
