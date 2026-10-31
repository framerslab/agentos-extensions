# TikTok channel

This pack gives an agent video publishing, content search, trends, analytics and engagement through TikTok API for Business using `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-tiktok
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-tiktok',
        options: { accessToken: process.env.TIKTOK_ACCESS_TOKEN },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `tiktok.accessToken` | Variable named by `accessTokenEnv`, then `TIKTOK_ACCESS_TOKEN`, then `TIKTOK_TOKEN` | Yes | None |
| `accessTokenEnv` | None | None | No | `TIKTOK_ACCESS_TOKEN` |
| `username` | `tiktok.username` | None | No | None |
| `password` | `tiktok.password` | None | No | None |
| `priority` | None | None | No | `50` |
| `secrets` | `tiktok.accessToken`, `tiktok.username`, `tiktok.password` | None | No | None |

Secrets are read from `options.secrets`. Direct credentials take precedence over secrets. The first environment lookup uses `accessTokenEnv`, which defaults to `TIKTOK_ACCESS_TOKEN`.

## Tools

| Tool | What it does |
| --- | --- |
| `tiktokUpload` | Upload a video with caption, hashtags and privacy settings. |
| `tiktokTrending` | Get trending sounds and hashtags. |
| `tiktokSearch` | Search videos or creators by keyword. |
| `tiktokAnalytics` | Get video or creator performance metrics. |
| `tiktokEngage` | Like or comment on a video. |
| `tiktokDiscover` | Browse recommended videos from the For You page. |

### `tiktokUpload`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoUrl` | string | Yes | URL of the video to upload |
| `caption` | string | Yes | Video caption |
| `hashtags` | string[] | No | Hashtags to append to caption |
| `privacyLevel` | string: `PUBLIC_TO_EVERYONE`, `MUTUAL_FOLLOW_FRIENDS`, `FOLLOWER_OF_CREATOR`, `SELF_ONLY` | No | Privacy level (default: `PUBLIC_TO_EVERYONE`) |
| `disableComment` | boolean | No | Disable comments on this video |
| `disableDuet` | boolean | No | Disable duets for this video |
| `disableStitch` | boolean | No | Disable stitches for this video |
| `coverTimestampMs` | number | No | Timestamp in ms for cover image |

### `tiktokTrending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string: `hashtags`, `sounds`, `both` | No | Type of trending content to retrieve (default: `both`) |
| `maxResults` | number | No | Max results per category (default: `20`, max: `100`) |

### `tiktokSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string: `video`, `user` | No | Search type: video or user (default: `video`) |
| `maxResults` | number | No | Max results to return (default: `10`, max: `100`) |
| `cursor` | number | No | Pagination cursor for next page |

### `tiktokAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string: `video`, `creator` | Yes | Whether to get analytics for a specific video or the creator account |
| `videoId` | string | No | Video ID (required when `type` is `video`) |

### `tiktokEngage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `like`, `comment` | Yes | Engagement action to perform |
| `videoId` | string | Yes | Video ID to engage with |
| `text` | string | No | Comment text (required for comment action) |

### `tiktokDiscover`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `maxResults` | number | No | Max videos to retrieve (default: `20`, max: `20`) |

## Channel adapter

The adapter registers platform `tiktok`. Sending publishes a video or reel URL, using its caption or a text block as a fallback. It merges reel hashtags with `platformOptions.hashtags` and reads `platformOptions.privacyLevel`. It ignores `conversationId` and throws if no video or reel block is present.

Activation initializes the HTTP service. Connection status follows the service's running state. The adapter stores event handlers but emits no inbound events, and typing indicators do nothing.

## Notes

Creating the pack throws when no access token resolves. Uploads publish videos, and engagement calls like videos or post comments. Uploads pull video content from a URL. Privacy defaults to `PUBLIC_TO_EVERYONE`; comment, duet and stitch disabling default to `false`.

`username` and `password` are passed into the service configuration but are not used for authentication. Tool errors return `success: false` with the error message. Video analytics require `videoId`, and comments require `text`, although those fields are optional in their schemas.

HTTP requests have a `60000` ms timeout. Search and trending requests are capped at `100` results; discovery is capped at `20`.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
