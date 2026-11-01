# WebChat Channel Extension

Lightweight web chat channel adapter for AgentOS.

## What It Provides

- `webchatChannelSendMessage`
- `webchatChannel`

## Runtime Status

- This is a curated channel pack.
- Channels stay opt-in because they can connect to host transport layers.
- Enable it through `createCuratedManifest({ channels: ['webchat'] })` or a custom extension manifest.
- The adapter delegates transport to the host gateway rather than shipping an external SDK.

## Required Secrets

- None

## Source of Truth

- `manifest.json` defines the exported tool and messaging-channel descriptor.
- `src/` contains the adapter implementation.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
