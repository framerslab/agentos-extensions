# Multi-channel post

This pack gives an agent a tool that adapts content and delegates posting to platform tools for social services including Twitter, Instagram, Reddit, YouTube, TikTok, Pinterest, LinkedIn, Facebook, Threads, Bluesky and Mastodon. It uses a tool executor callback.

## Installation

```bash
npm install @framers/agentos-ext-tool-multi-channel-post
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-tool-multi-channel-post';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  logger: console,
}));
```

## Tools

| Tool | What it does |
| --- | --- |
| `multiChannelPost` | Publishes content to social media platforms with platform-specific content adaptation. |

### `multiChannelPost` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | `string` | Yes | Base content text to publish across platforms |
| `platforms` | `array<string>` | Yes | Target platforms: `twitter`, `instagram`, `reddit`, `youtube`, `tiktok`, `pinterest`, `linkedin`, `facebook`, `threads`, `bluesky`, `mastodon` |
| `adaptations` | `object<string, string>` | No | Optional per-platform content overrides (platform name -> custom text) |
| `mediaUrls` | `array<string>` | No | Media URLs or file paths to attach |
| `platformConfigs` | `object<string, object>` | No | Optional per-platform tool argument overrides (e.g. `subreddit`, `boardId`, `videoUrl`, `communityId`). |
| `hashtags` | `array<string>` | No | Hashtags to include (adapted per platform conventions) |
| `dryRun` | `boolean` | No | If true, return adapted content without posting |

## Notes

The factory does not attach a tool executor. The host attaches one through `MultiChannelPostTool.setToolExecutor` on the tool payload and provides the platform tools. Without an executor, posting returns a failure for each platform. `dryRun` returns adapted content without invoking the executor.

Posting runs sequentially and can publish content through the delegated tools. Results include per-platform success, adapted content, errors and any returned post ID or URL. The overall result succeeds when any platform succeeds.

Automatic adaptation appends hashtags according to platform conventions and truncates text to the platform limit stored in the tool. Explicit `adaptations` bypass automatic adaptation.

Instagram requires image URLs. YouTube and TikTok require a video URL. Pinterest requires `boardId` and a media URL. Lemmy requires `communityId`. Missing required platform arguments produce a per-platform error before the executor runs.

## License

Apache-2.0
