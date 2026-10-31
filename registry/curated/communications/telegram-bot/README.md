# Telegram Bot Extension

Telegram Bot API communication tools for AgentOS agents.

## What It Provides

- `telegramSendMessage`
- `telegramSendPhoto`
- `telegramSendDocument`
- `telegramManageChat`
- `telegramPollMessages`

## Runtime Status

- This is a curated tool pack, not a background-installed plugin.
- AgentOS only loads it when the package is installed and your host includes it in the extension manifest.
- Use `createCuratedManifest({ tools: 'all', channels: 'none' })` for the simplest curated setup, or add it to a custom manifest explicitly.

## Required Secret

- `telegram.botToken`

## Source of Truth

- `manifest.json` defines the public tool descriptors.
- `src/` contains the tool implementations that are compiled into `dist/`.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
