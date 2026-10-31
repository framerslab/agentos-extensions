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

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
