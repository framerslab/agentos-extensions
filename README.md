<p align="center">
  <a href="https://agentos.sh"><img src="logos/agentos-primary-no-tagline-transparent-2x.png" alt="AgentOS" height="56" /></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://frame.dev"><img src="logos/frame-logo-green-transparent-4x.png" alt="Frame.dev" height="40" /></a>
</p>

# AgentOS Extensions

Extension source code for AgentOS — tools, channel adapters, integrations, and starter templates.

[![CI Status](https://github.com/framerslab/agentos-extensions/workflows/CI/badge.svg)](https://github.com/framerslab/agentos-extensions/actions)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![API Docs](https://img.shields.io/badge/docs-TypeDoc-blue)](https://framerslab.github.io/agentos-extensions/)
[![npm: registry](https://img.shields.io/npm/v/@framers/agentos-extensions-registry?label=registry)](https://www.npmjs.com/package/@framers/agentos-extensions-registry)
[![npm: catalog](https://img.shields.io/npm/v/@framers/agentos-extensions?label=catalog)](https://www.npmjs.com/package/@framers/agentos-extensions)
[![NVIDIA Inception](https://img.shields.io/badge/NVIDIA_Inception-Member-76B900?logo=nvidia&logoColor=white)](https://www.nvidia.com/en-us/startups/)

## What This Package Is

This package contains the **actual implementation source code** for AgentOS extensions:
the Telegram adapter, web-search tool, voice providers, browser automation, channel adapters
for 37 platforms, and more. It also ships **starter templates** (`templates/`) for creating
new extensions from scratch.

**This is NOT a registry.** It is the source code that registries catalog. The relationship
between the two sibling packages is:

| Package | Role |
|---------|------|
| **`@framers/agentos-extensions`** (this package) | Implementation source code, manifests, and templates |
| **`@framers/agentos-extensions-registry`** | Catalog/SDK that references this package's metadata and exposes `createCuratedManifest()` |

**Dependency direction:** `agentos-extensions-registry` depends on metadata from this package,
not the other way around. Extensions here are self-contained and can be installed individually
without the registry.

## Published Extensions

All extensions are published to npm under the `@framers` scope.

### Extensions

| Package | Description | npm |
|---------|-------------|-----|
| [`@framers/agentos-ext-web-search`](./registry/curated/research/web-search) | Multi-provider web search & fact-checking | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-web-search)](https://www.npmjs.com/package/@framers/agentos-ext-web-search) |
| [`@framers/agentos-ext-web-browser`](./registry/curated/research/web-browser) | Browser automation & content extraction | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-web-browser)](https://www.npmjs.com/package/@framers/agentos-ext-web-browser) |
| [`@framers/agentos-ext-web-scraper`](./registry/curated/research/web-scraper) | Progressive scraping with fetch, Playwright, stealth, recipes, and LLM fallback extraction | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-web-scraper)](https://www.npmjs.com/package/@framers/agentos-ext-web-scraper) |
| [`@framers/agentos-ext-news-search`](./registry/curated/research/news-search) | News article search via NewsAPI | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-news-search)](https://www.npmjs.com/package/@framers/agentos-ext-news-search) |
| [`@framers/agentos-ext-giphy`](./registry/curated/media/giphy) | GIF & sticker search via Giphy API | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-giphy)](https://www.npmjs.com/package/@framers/agentos-ext-giphy) |
| [`@framers/agentos-ext-image-search`](./registry/curated/media/image-search) | Stock photo search (Pexels, Unsplash, Pixabay) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-image-search)](https://www.npmjs.com/package/@framers/agentos-ext-image-search) |
| [`@framers/agentos-ext-letterboxd`](./registry/curated/media/letterboxd) | Letterboxd movie lookup with review extraction and direct page fallback | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-letterboxd)](https://www.npmjs.com/package/@framers/agentos-ext-letterboxd) |
| [`@framers/agentos-ext-omdb`](./registry/curated/media/omdb) | Movie and TV metadata with IMDB, Rotten Tomatoes, and Metacritic ratings | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-omdb)](https://www.npmjs.com/package/@framers/agentos-ext-omdb) |
| [`@framers/agentos-ext-voice-synthesis`](./registry/curated/media/voice-synthesis) | Text-to-speech via ElevenLabs | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-voice-synthesis)](https://www.npmjs.com/package/@framers/agentos-ext-voice-synthesis) |
| [`@framers/agentos-ext-cli-executor`](./registry/curated/system/cli-executor) | Shell command execution & file management | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-cli-executor)](https://www.npmjs.com/package/@framers/agentos-ext-cli-executor) |
| [`@framers/agentos-ext-auth`](./registry/curated/auth) | JWT authentication & subscription management | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-auth)](https://www.npmjs.com/package/@framers/agentos-ext-auth) |
| [`@framers/agentos-ext-clearbit`](./registry/curated/integrations/clearbit) | Company and person enrichment via Clearbit | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-clearbit)](https://www.npmjs.com/package/@framers/agentos-ext-clearbit) |
| [`@framers/agentos-ext-telegram`](./registry/curated/integrations/telegram) | Telegram Bot API integration | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-telegram)](https://www.npmjs.com/package/@framers/agentos-ext-telegram) |
| [`@framers/agentos-ext-wunderbot-feeds`](https://www.npmjs.com/package/@framers/agentos-ext-wunderbot-feeds) | Wunderbot feed ingestion + social content pipeline integration | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-wunderbot-feeds)](https://www.npmjs.com/package/@framers/agentos-ext-wunderbot-feeds) |
| [`@framers/agentos-ext-telegram-bot`](./registry/curated/communications/telegram-bot) | Telegram bot communications handler | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-telegram-bot)](https://www.npmjs.com/package/@framers/agentos-ext-telegram-bot) |
| [`@framers/agentos-ext-anchor-providers`](./registry/curated/provenance/anchor-providers) | Solana on-chain provenance anchoring | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-anchor-providers)](https://www.npmjs.com/package/@framers/agentos-ext-anchor-providers) |
| [`@framers/agentos-ext-tip-ingestion`](https://www.npmjs.com/package/@framers/agentos-ext-tip-ingestion) | Tip content processing pipeline (published package; not vendored in this workspace) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-tip-ingestion)](https://www.npmjs.com/package/@framers/agentos-ext-tip-ingestion) |
| [`@framers/agentos-ext-browser-automation`](./registry/curated/system/browser-automation) | Full browser automation (Playwright) — 10 tools | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-browser-automation)](https://www.npmjs.com/package/@framers/agentos-ext-browser-automation) |
| [`@framers/agentos-ext-deep-research`](./registry/curated/research/deep-research) | Multi-source research & investigation — 5 tools | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-deep-research)](https://www.npmjs.com/package/@framers/agentos-ext-deep-research) |
| [`@framers/agentos-ext-content-extraction`](./registry/curated/research/content-extraction) | Content extraction (URLs, YouTube, PDF) — 5 tools | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-content-extraction)](https://www.npmjs.com/package/@framers/agentos-ext-content-extraction) |
| [`@framers/agentos-ext-credential-vault`](./registry/curated/system/credential-vault) | Encrypted credential management — 5 tools | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-credential-vault)](https://www.npmjs.com/package/@framers/agentos-ext-credential-vault) |
| [`@framers/agentos-ext-document-export`](./registry/curated/productivity/document-export) | Export reports and decks to PDF, DOCX, PPTX, XLSX, and CSV | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-document-export)](https://www.npmjs.com/package/@framers/agentos-ext-document-export) |
| [`@framers/agentos-ext-widget-generator`](./registry/curated/productivity/widget-generator) | Generate self-contained interactive HTML widgets with file management | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-widget-generator)](https://www.npmjs.com/package/@framers/agentos-ext-widget-generator) |
| [`@framers/agentos-ext-notifications`](./registry/curated/communications/notifications) | Multi-channel notification router — 3 tools | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-notifications)](https://www.npmjs.com/package/@framers/agentos-ext-notifications) |

### Channel Adapters

| Package | Description | npm |
|---------|-------------|-----|
| [`@framers/agentos-ext-channel-telegram`](./registry/curated/channels/telegram) | Telegram messaging channel (grammY) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-telegram)](https://www.npmjs.com/package/@framers/agentos-ext-channel-telegram) |
| [`@framers/agentos-ext-channel-whatsapp`](./registry/curated/channels/whatsapp) | WhatsApp messaging channel (Baileys) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-whatsapp)](https://www.npmjs.com/package/@framers/agentos-ext-channel-whatsapp) |
| [`@framers/agentos-ext-channel-discord`](./registry/curated/channels/discord) | Discord messaging channel (discord.js) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-discord)](https://www.npmjs.com/package/@framers/agentos-ext-channel-discord) |
| [`@framers/agentos-ext-channel-slack`](./registry/curated/channels/slack) | Slack messaging channel (Bolt) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-slack)](https://www.npmjs.com/package/@framers/agentos-ext-channel-slack) |
| [`@framers/agentos-ext-channel-webchat`](./registry/curated/channels/webchat) | Built-in WebChat channel (Socket.IO) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-webchat)](https://www.npmjs.com/package/@framers/agentos-ext-channel-webchat) |
| [`@framers/agentos-ext-channel-twitter`](./registry/curated/channels/twitter) | Twitter/X social channel (twitter-api-v2) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-twitter)](https://www.npmjs.com/package/@framers/agentos-ext-channel-twitter) |
| [`@framers/agentos-ext-channel-instagram`](./registry/curated/channels/instagram) | Instagram social channel (Graph API) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-instagram)](https://www.npmjs.com/package/@framers/agentos-ext-channel-instagram) |
| [`@framers/agentos-ext-channel-reddit`](./registry/curated/channels/reddit) | Reddit social channel (snoowrap) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-reddit)](https://www.npmjs.com/package/@framers/agentos-ext-channel-reddit) |
| [`@framers/agentos-ext-channel-youtube`](./registry/curated/channels/youtube) | YouTube social channel (googleapis) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-youtube)](https://www.npmjs.com/package/@framers/agentos-ext-channel-youtube) |
| [`@framers/agentos-ext-channel-linkedin`](./registry/curated/channels/linkedin) | LinkedIn social channel (Marketing API) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-linkedin)](https://www.npmjs.com/package/@framers/agentos-ext-channel-linkedin) |
| [`@framers/agentos-ext-channel-facebook`](./registry/curated/channels/facebook) | Facebook social channel (Meta Graph API) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-facebook)](https://www.npmjs.com/package/@framers/agentos-ext-channel-facebook) |
| [`@framers/agentos-ext-channel-threads`](./registry/curated/channels/threads) | Threads social channel (Meta Graph API) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-threads)](https://www.npmjs.com/package/@framers/agentos-ext-channel-threads) |
| [`@framers/agentos-ext-channel-bluesky`](./registry/curated/channels/bluesky) | Bluesky social channel (AT Protocol) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-bluesky)](https://www.npmjs.com/package/@framers/agentos-ext-channel-bluesky) |
| [`@framers/agentos-ext-channel-mastodon`](./registry/curated/channels/mastodon) | Mastodon social channel (federated) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-mastodon)](https://www.npmjs.com/package/@framers/agentos-ext-channel-mastodon) |
| [`@framers/agentos-ext-channel-farcaster`](./registry/curated/channels/farcaster) | Farcaster social channel (Neynar API) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-farcaster)](https://www.npmjs.com/package/@framers/agentos-ext-channel-farcaster) |
| [`@framers/agentos-ext-channel-lemmy`](./registry/curated/channels/lemmy) | Lemmy federated social channel | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-lemmy)](https://www.npmjs.com/package/@framers/agentos-ext-channel-lemmy) |
| [`@framers/agentos-ext-channel-google-business`](./registry/curated/channels/google-business) | Google Business Profile channel | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-google-business)](https://www.npmjs.com/package/@framers/agentos-ext-channel-google-business) |
| [`@framers/agentos-ext-channel-blog-publisher`](./registry/curated/channels/blog-publisher) | Blog publisher (Dev.to, Hashnode, Medium, WordPress) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-blog-publisher)](https://www.npmjs.com/package/@framers/agentos-ext-channel-blog-publisher) |
| [`@framers/agentos-ext-channel-pinterest`](./registry/curated/channels/pinterest) | Pinterest social channel (API v5) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-pinterest)](https://www.npmjs.com/package/@framers/agentos-ext-channel-pinterest) |
| [`@framers/agentos-ext-channel-tiktok`](./registry/curated/channels/tiktok) | TikTok social channel (API for Business) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-tiktok)](https://www.npmjs.com/package/@framers/agentos-ext-channel-tiktok) |
| [`@framers/agentos-ext-channel-email`](./registry/curated/channels/email) | Email messaging channel (nodemailer/imapflow) | [![npm](https://img.shields.io/npm/v/@framers/agentos-ext-channel-email)](https://www.npmjs.com/package/@framers/agentos-ext-channel-email) |

## Two-Tier Extension Pattern

AgentOS extensions are organized into two tiers with different versioning and
release strategies:

### Core Extensions (monorepo root)

Seven foundational packages live at the monorepo root under `packages/agentos-ext-*`.
These are **independently versioned** with semantic-release CI/CD and have their own
GitHub Actions workflows:

| Package | Description |
|---------|-------------|
| `agentos-ext-code-safety` | Static code analysis guardrail (injection, XSS, secrets) |
| `agentos-ext-pii-redaction` | PII detection & redaction pipeline |
| `agentos-ext-grounding-guard` | Claim extraction & source verification |
| `agentos-ext-ml-classifiers` | ML-based content classification (toxicity, jailbreak, injection) |
| `agentos-ext-topicality` | Topic drift detection & off-topic filtering |
| `agentos-ext-http-api` | HTTP API server for AgentOS |
| `agentos-ext-skills` | Skill loading & execution tooling |

Each has its own `.github/` CI workflow, `.releaserc.json`, and publishes to npm
independently. Version bumps here do **not** affect curated extension versions.

### Curated Extensions (this submodule)

~107 packages inside `registry/curated/` use coordinated versioning via
[Changesets](https://github.com/changesets/changesets). These are the full
extension catalog: channel adapters, integrations, research tools, media tools,
and more.

Version bumps here are batched into "Version Packages" PRs and published together.

### Why two tiers?

- **Core extensions** are safety-critical guardrails and foundational infrastructure.
  They need independent semver to signal breaking changes without forcing a catalog-wide
  release. Their CI runs on every PR to the monorepo root.
- **Curated extensions** are the broader catalog. Coordinated changesets keep their
  interdependencies aligned and simplify bulk releases.

### Where do safety guardrails live?

The `registry/curated/safety/` directory contains **stub READMEs** pointing to the
canonical core packages at the monorepo root. The actual source code for code-safety,
pii-redaction, and grounding-guard lives exclusively in `packages/agentos-ext-*` at
the monorepo root. The ml-classifiers and topicality packages still have curated
copies with additional modules (ClassifierOrchestrator, TopicDriftTracker, etc.) that
have not yet been merged upstream to the root packages.

## Repository Structure

```
agentos-extensions/
├── .changeset/            # Changesets for versioning & publishing
├── .github/workflows/     # CI, release, TypeDoc pages
├── logos/                 # Branding assets
├── templates/             # Starter templates for new extensions
│   ├── basic-tool/        # Single tool template
│   ├── multi-tool/        # Multiple tools template
│   ├── guardrail/         # Safety/compliance template
│   └── workflow/          # Multi-step process template
├── registry/
│   ├── curated/           # Official & verified extensions
│   │   ├── auth/          # Authentication & subscriptions
│   │   ├── channels/      # Messaging & social channels (37 platform packs)
│   │   ├── communications/# Telegram bot, notifications
│   │   ├── integrations/  # External services (Telegram API)
│   │   ├── media/         # Giphy, image search, voice synthesis
│   │   ├── provenance/    # On-chain anchoring (tip-ingestion package is published separately)
│   │   ├── research/      # Web search, deep research, content extraction
│   │   ├── safety/        # Stub READMEs -> core packages (see above)
│   │   ├── system/        # CLI executor, browser automation, credential vault
│   │   ├── voice/         # Twilio, Telnyx, Plivo voice providers
│   │   └── productivity/  # Google Calendar, Gmail
│   └── community/         # Community-contributed extensions
├── scripts/               # Registry build & scaffolding tools
├── registry.json          # Auto-generated extension manifest
├── pnpm-workspace.yaml    # Workspace packages for publishing
└── typedoc.json           # API docs config
```

## Quick Start

### Install the registry (recommended)

Load all extensions at once via the curated registry:

```bash
npm install @framers/agentos-extensions-registry
```

```typescript
import { AgentOS } from '@framers/agentos';
import { createCuratedManifest } from '@framers/agentos-extensions-registry';

const manifest = await createCuratedManifest({
  tools: 'all',
  channels: 'none',
  secrets: {
    'serper.apiKey': process.env.SERPER_API_KEY!,
    'giphy.apiKey': process.env.GIPHY_API_KEY!,
  },
});

const agentos = new AgentOS();
await agentos.initialize({ extensionManifest: manifest });
```

Only extensions whose npm packages are installed will load — missing packages are skipped silently.

### Install individual extensions

```bash
npm install @framers/agentos-ext-web-search
```

```typescript
import { AgentOS } from '@framers/agentos';
import webSearch from '@framers/agentos-ext-web-search';

const agentos = new AgentOS();
await agentos.initialize({
  extensionManifest: {
    packs: [{
      factory: () => webSearch({ /* config */ })
    }]
  }
});
```

## How extensions stay optional and lazy

The extension surface is dependency-injected at four layers. Each layer is opt-in by default, so a host that installs five extensions does not pay the cost of the other 95, and an extension that needs a 110MB NER model does not load it until the first call.

### Layer 1: package install gates everything

Every extension is its own npm package. Nothing is imported until you `npm install` it. The `@framers/agentos-extensions-registry` SDK depends on the extension packages as `peerDependenciesMeta.optional`, so installing the registry alone gives you the catalog metadata without pulling any extension source. Add `@framers/agentos-ext-pii-redaction` to your `package.json` and the registry sees it; remove it and the registry drops it on the next manifest build.

### Layer 2: registry resolve skips uninstalled packages

`createCuratedManifest()` calls `import.meta.resolve()` on every catalog entry before adding it to the manifest. If the resolution throws, the entry is omitted. The runtime never sees it. There is no error, no warning, no missing-module crash. This is the difference between a catalog (metadata) and a registry that only emits packs you can actually run.

```typescript
// Even if you ask for `tools: 'all'`, only installed packages reach the runtime.
const manifest = await createCuratedManifest({ tools: 'all' });
// → manifest.packs contains only @framers/agentos-ext-* packages found on disk.
```

### Layer 3: `requiredSecrets` gates descriptor activation

Inside a pack, each descriptor (a single tool, guardrail, channel, or workflow) can declare `requiredSecrets`. Before activation, `ExtensionManager` checks whether each non-optional secret is resolvable from the secret store, the pack options, or the environment. Missing a secret? The descriptor is skipped and the rest of the pack still activates. Optional secrets unlock optional features (like the PII redaction extension's LLM-judge tier) without making them required.

```typescript
// pii-redaction declares its LLM judge as an optional dependency.
{
  id: 'pii_judge_resolver',
  kind: 'tool',
  requiredSecrets: [{ id: 'anthropic.apiKey', optional: true }],
  // ...
}
// No ANTHROPIC_API_KEY in env? The judge is skipped, the rest of the pack works.
```

### Layer 4: `SharedServiceRegistry.getOrCreate()` defers heavy resources

ML models, embedding indexes, ONNX runtimes, NER pipelines, and database pools are not loaded at activation. They are registered as factories and only constructed on the first call that needs them. The same instance is shared across descriptors in the same pack and (with a namespaced key) across packs.

```typescript
async onActivate(ctx) {
  // The 110MB BERT NER model. Not loaded yet.
  const nerModel = await ctx.services.getOrCreate('pii:ner-model', async () => {
    const { NerModel } = await import('./NerModel.js');
    return NerModel.load();
  });
  this.scanTool.setNerModel(nerModel);
  this.streamingGuardrail.setNerModel(nerModel);
}
```

The `import('./NerModel.js')` is a dynamic import: the model file itself does not enter the module graph until something asks for the service. First call pays the load cost; subsequent calls hit the cache. Tear-down releases everything via the registry's lifecycle.

### What this looks like end-to-end for a guardrail

A host installing `@framers/agentos-ext-pii-redaction`:

1. **Install.** `npm install @framers/agentos-ext-pii-redaction @framers/agentos-extensions-registry @framers/agentos`. Nothing else.
2. **Manifest build.** `createCuratedManifest({ tools: 'all' })` resolves only the installed PII pack and emits a single-pack manifest.
3. **Activation.** `ExtensionManager.loadManifest()` runs `pack.onActivate(ctx)`, which registers a `pii:ner-model` factory in `SharedServiceRegistry`. The model file is not loaded.
4. **Descriptor registration.** Two tool descriptors (`pii_scan`, `pii_redact`) and one guardrail descriptor land in the kind-specific registries. The guardrail descriptor's `config.canSanitize = true` and `config.evaluateStreamingChunks = true` flag it for the two-phase dispatcher.
5. **First request.** A user message hits the input pipeline. The two-phase dispatcher runs Phase 1 sequentially: the PII guardrail's `evaluateInput()` fires, calls into the NER pipeline, and the model loads on this first call. Subsequent requests hit the cached model.
6. **Streaming output.** As the model generates a response, each `TEXT_DELTA` chunk passes through the guardrail's `evaluateOutput()`. The dispatcher returns `SANITIZE` results with redacted text deterministically (Phase 1 chains sequentially), then runs all Phase 2 classifiers in parallel for any remaining checks.
7. **Tear-down.** `pack.onDeactivate(ctx)` runs in reverse order on shutdown. The shared service registry releases the model.

Same pattern for the four other guardrail packs: `@framers/agentos-ext-ml-classifiers` lazy-loads ONNX BERT models, `@framers/agentos-ext-grounding-guard` lazy-loads the NLI pipeline, `@framers/agentos-ext-topicality` lazy-loads embeddings, `@framers/agentos-ext-code-safety` is regex-only and pays no load cost.

This is the same auto-discovery surface that runtime-forged tools join: an agent that invents a function in session N can promote it via `SkillExporter` into a `SKILL.md` that the registry picks up on the next process start. Forging grows the surface mid-run; auto-discovery ships it as a first-class capability.

For the dispatcher mechanics (Phase 1 sanitizers, Phase 2 parallel classifiers, worst-action aggregation, mid-stream override), see [Guardrails](https://docs.agentos.sh/features/guardrails). For lifecycle internals, see [Extension Loading](https://docs.agentos.sh/architecture/extension-loading).

### Registry options

`createCuratedManifest()` accepts:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `tools` | `string[] \| 'all' \| 'none'` | `'all'` | Which tool extensions to enable. Pass an array of names (e.g. `['web-search', 'giphy']`) to selectively load. |
| `channels` | `ChannelPlatform[] \| 'all' \| 'none'` | `'all'` | Which messaging channels to enable. |
| `secrets` | `Record<string, string>` | `{}` | API keys and tokens. Falls back to environment variables. |
| `logger` | `RegistryLogger` | `console` | Custom logger (`info`, `warn`, `error`, `debug` methods). |
| `basePriority` | `number` | `0` | Base priority for all extensions. |
| `overrides` | `Record<string, ExtensionOverrideConfig>` | — | Per-extension overrides for `enabled`, `priority`, and `options`. |

#### Secret keys

| Secret ID | Environment Variable | Extension |
|-----------|---------------------|-----------|
| `serper.apiKey` | `SERPER_API_KEY` | web-search |
| `serpapi.apiKey` | `SERPAPI_API_KEY` | web-search |
| `brave.apiKey` | `BRAVE_API_KEY` | web-search |
| `giphy.apiKey` | `GIPHY_API_KEY` | giphy |
| `omdb.apiKey` | `OMDB_API_KEY` | omdb |
| `clearbit.apiKey` | `CLEARBIT_API_KEY` | clearbit |
| `elevenlabs.apiKey` | `ELEVENLABS_API_KEY` | voice-synthesis |
| `pexels.apiKey` | `PEXELS_API_KEY` | image-search |
| `unsplash.apiKey` | `UNSPLASH_ACCESS_KEY` | image-search |
| `pixabay.apiKey` | `PIXABAY_API_KEY` | image-search |
| `newsapi.apiKey` | `NEWSAPI_API_KEY` | news-search |
| `telegram.botToken` | `TELEGRAM_BOT_TOKEN` | channel-telegram |
| `discord.botToken` | `DISCORD_BOT_TOKEN` | channel-discord |
| `slack.botToken` | `SLACK_BOT_TOKEN` | channel-slack |
| `slack.appToken` | `SLACK_APP_TOKEN` | channel-slack |
| `twitter.bearerToken` | `TWITTER_BEARER_TOKEN` | channel-twitter |
| `twitter.apiKey` | `TWITTER_API_KEY` | channel-twitter |
| `twitter.apiSecret` | `TWITTER_API_SECRET` | channel-twitter |
| `twitter.accessToken` | `TWITTER_ACCESS_TOKEN` | channel-twitter |
| `twitter.accessSecret` | `TWITTER_ACCESS_SECRET` | channel-twitter |
| `instagram.accessToken` | `INSTAGRAM_ACCESS_TOKEN` | channel-instagram |
| `linkedin.accessToken` | `LINKEDIN_ACCESS_TOKEN` | channel-linkedin |
| `facebook.accessToken` | `FACEBOOK_ACCESS_TOKEN` | channel-facebook |
| `threads.accessToken` | `THREADS_ACCESS_TOKEN` | channel-threads |
| `bluesky.handle` | `BLUESKY_HANDLE` | channel-bluesky |
| `bluesky.appPassword` | `BLUESKY_APP_PASSWORD` | channel-bluesky |
| `mastodon.accessToken` | `MASTODON_ACCESS_TOKEN` | channel-mastodon |
| `farcaster.neynarApiKey` | `FARCASTER_NEYNAR_API_KEY` | channel-farcaster |
| `farcaster.signerUuid` | `FARCASTER_SIGNER_UUID` | channel-farcaster |
| `lemmy.instanceUrl` | `LEMMY_INSTANCE_URL` | channel-lemmy |
| `lemmy.username` | `LEMMY_USERNAME` | channel-lemmy |
| `lemmy.password` | `LEMMY_PASSWORD` | channel-lemmy |
| `google.accessToken` | `GOOGLE_ACCESS_TOKEN` | channel-google-business |
| `reddit.clientId` | `REDDIT_CLIENT_ID` | channel-reddit |
| `reddit.clientSecret` | `REDDIT_CLIENT_SECRET` | channel-reddit |
| `reddit.username` | `REDDIT_USERNAME` | channel-reddit |
| `reddit.password` | `REDDIT_PASSWORD` | channel-reddit |
| `youtube.apiKey` | `YOUTUBE_API_KEY` | channel-youtube |
| `pinterest.accessToken` | `PINTEREST_ACCESS_TOKEN` | channel-pinterest |
| `tiktok.accessToken` | `TIKTOK_ACCESS_TOKEN` | channel-tiktok |
| `email.smtpHost` | `SMTP_HOST` | channel-email |
| `email.smtpUser` | `SMTP_USER` | channel-email |
| `email.smtpPassword` | `SMTP_PASSWORD` | channel-email |

#### Selective loading examples

```typescript
// Only web search and giphy, no channels
const manifest = await createCuratedManifest({
  tools: ['web-search', 'giphy'],
  channels: 'none',
});

// Only Telegram and Discord channels, all tools
const manifest = await createCuratedManifest({
  channels: ['telegram', 'discord'],
  tools: 'all',
  secrets: {
    'telegram.botToken': process.env.TELEGRAM_BOT_TOKEN!,
    'discord.botToken': process.env.DISCORD_BOT_TOKEN!,
  },
});

// Override specific extension options
const manifest = await createCuratedManifest({
  tools: 'all',
  channels: 'none',
  overrides: {
    'web-search': { priority: 10 },
    'cli-executor': { enabled: false },
  },
});
```

### Create a new extension

```bash
# Use the scaffolding script
pnpm run create-extension

# Or copy a template
cp -r templates/basic-tool registry/curated/category/my-extension
cd registry/curated/category/my-extension
pnpm install
pnpm run dev
```

## Releasing & Publishing

This repo uses [Changesets](https://github.com/changesets/changesets) for multi-package versioning and npm publishing. See [RELEASING.md](./RELEASING.md) for the full workflow.

### TL;DR

```bash
# 1. Make your changes to one or more extensions

# 2. Add a changeset describing what changed
pnpm changeset

# 3. Commit and push to master
git add . && git commit -m "feat: my changes" && git push

# 4. The GitHub Action opens a "Version Packages" PR
#    → Merge it to publish updated packages to npm
```

Each extension is versioned and published independently. A change to `web-search` does not bump `telegram`.

## Naming Convention

| Type | Pattern | Example |
|------|---------|---------|
| Extension | `@framers/agentos-ext-{name}` | `@framers/agentos-ext-web-search` |
| Template | `@framers/agentos-template-{type}` | `@framers/agentos-template-basic-tool` |

## CI/CD

All extensions get free CI/CD via GitHub Actions:

- **CI** (`ci.yml`): Lint, test, typecheck on every PR
- **Release** (`release.yml`): Changesets auto-version PRs + npm publish on merge
- **TypeDoc** (`pages-typedoc.yml`): API docs deployed to [framerslab.github.io/agentos-extensions](https://framerslab.github.io/agentos-extensions/)
- **Extension validation** (`extension-validation.yml`): Manifest & structure checks
- **Dependabot**: Automated dependency updates with auto-merge for patches

## Quality Standards

### All Extensions

- TypeScript with strict mode
- >80% test coverage
- Apache 2.0 license
- No hardcoded secrets

### Additional for Curated

- Professional code review
- Performance benchmarks
- Integration tests
- Migration guides

## Documentation

- [API Reference (TypeDoc)](https://framerslab.github.io/agentos-extensions/)
- [How Extensions Work](./HOW_EXTENSIONS_WORK.md)
- [Extension Architecture](./EXTENSION_ARCHITECTURE.md)
- [Auto-Loading Extensions](./AUTO_LOADING_EXTENSIONS.md)
- [Agency Collaboration Examples](./AGENCY_COLLABORATION_EXAMPLE.md)
- [Self-Hosted Registries](./SELF_HOSTED_REGISTRIES.md)
- [Migration Guide](./MIGRATION_GUIDE.md)
- [Releasing & Publishing](./RELEASING.md)
- [Contributing](./CONTRIBUTING.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for detailed guidelines.

- [Submit New Extension](https://github.com/framerslab/agentos-extensions/issues/new?template=new-extension.yml)
- [Report Bug](https://github.com/framerslab/agentos-extensions/issues/new?template=bug-report.yml)
- [Request Feature](https://github.com/framerslab/agentos-extensions/discussions)

## Links

- **AgentOS**: [agentos.sh](https://agentos.sh)
- **AgentOS GitHub**: [github.com/framerslab/agentos](https://github.com/framerslab/agentos)
- **Extensions GitHub**: [github.com/framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions)
- **npm**: [@framers](https://www.npmjs.com/org/framers)
- **API Docs**: [framerslab.github.io/agentos-extensions](https://framerslab.github.io/agentos-extensions/)
- **Discord**: [wilds.ai/discord](https://wilds.ai/discord)
- **Website**: [frame.dev](https://frame.dev)
- **Contact**: [team@frame.dev](mailto:team@frame.dev)

## License

All extensions in this repository are Apache 2.0 licensed.

---

<p align="center">
  <a href="https://agentos.sh"><img src="logos/agentos-primary-no-tagline-transparent-2x.png" alt="AgentOS" height="36" /></a>
  &nbsp;&nbsp;&nbsp;
  <a href="https://frame.dev"><img src="logos/frame-logo-green-transparent-4x.png" alt="Frame.dev" height="36" /></a>
</p>

<p align="center">
  Built by <a href="https://frame.dev">Frame</a><br>
  Contact: <a href="mailto:team@frame.dev">team@frame.dev</a>
</p>
