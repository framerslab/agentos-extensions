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

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
