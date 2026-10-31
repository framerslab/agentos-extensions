# WhatsApp Channel Extension

Bidirectional WhatsApp messaging for AgentOS via Baileys.

## What It Provides

- `whatsappChannelSendMessage`
- `whatsappChannelSendMedia`
- `whatsappChannel`

## Runtime Status

- This is a curated channel pack.
- Channels stay opt-in because they can connect, poll, or receive webhooks.
- Enable it through `createCuratedManifest({ channels: ['whatsapp'] })` or a custom extension manifest.
- Session bootstrap is transport-specific, so hosts should treat this adapter as an explicitly configured integration.

## Required Secrets

- None in the manifest; authentication/session setup is handled by the adapter runtime.

## Source of Truth

- `manifest.json` defines the exported tools and messaging-channel descriptor.
- `src/` contains the adapter and tool implementations.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.
