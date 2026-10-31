# YouTube channel

This pack gives an agent video and Shorts uploads, comments, search, trends, statistics, playlist management and scheduled publishing through the YouTube Data API using `googleapis`.

## Installation

```bash
npm install @framers/agentos-ext-channel-youtube
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-youtube',
        options: { apiKey: process.env.YOUTUBE_API_KEY },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` | `youtube.apiKey` | Variable named by `apiKeyEnv`, then `YOUTUBE_API_KEY`, then `GOOGLE_API_KEY` | Yes | None |
| `apiKeyEnv` | None | None | No | `YOUTUBE_API_KEY` |
| `oauth` | None | None | No | Resolved credentials if complete, otherwise none |
| `oauth.clientId` | `youtube.oauth.clientId` | `YOUTUBE_OAUTH_CLIENT_ID` | No | None |
| `oauth.clientSecret` | `youtube.oauth.clientSecret` | `YOUTUBE_OAUTH_CLIENT_SECRET` | No | None |
| `oauth.refreshToken` | `youtube.oauth.refreshToken` | `YOUTUBE_OAUTH_REFRESH_TOKEN` | No | None |
| `priority` | None | None | No | `50` |
| `secrets` | `youtube.apiKey`, `youtube.oauth.clientId`, `youtube.oauth.clientSecret`, `youtube.oauth.refreshToken` | None | No | None |

The API key resolves from options, then `options.secrets`, then environment variables. The first environment lookup uses `apiKeyEnv`, which defaults to `YOUTUBE_API_KEY`. An explicit `oauth` object overrides OAuth secret and environment resolution. Otherwise each OAuth field resolves from secrets before its environment variable, and OAuth is enabled only when all fields resolve. The `oauth` interface requires all fields when the object is supplied.

## Tools

| Tool | What it does |
| --- | --- |
| `youtubeUpload` | Upload a video with title, description, tags and privacy settings. |
| `youtubeShort` | Upload a Short with a `#Shorts` tag. |
| `youtubeComment` | Post a comment or reply to an existing comment. |
| `youtubeSearch` | Search videos, channels or playlists by keyword. |
| `youtubeTrending` | Get popular videos by region and category. |
| `youtubeAnalytics` | Get video or channel performance metrics. |
| `youtubePlaylist` | Create, list, add videos to or delete playlists. |
| `youtubeSchedule` | Upload a private video for scheduled public publishing. |

### `youtubeUpload`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoUrl` | string | Yes | URL of the video file to upload |
| `title` | string | Yes | Video title (max `100` chars) |
| `description` | string | Yes | Video description (max `5000` chars) |
| `tags` | string[] | No | Video tags for discoverability |
| `categoryId` | string | No | YouTube category ID (default: `22`, People & Blogs) |
| `privacyStatus` | string: `public`, `private`, `unlisted` | No | Privacy status (default: `public`) |
| `mimeType` | string | No | Video MIME type (default: `video/mp4`) |

### `youtubeShort`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoUrl` | string | Yes | URL of the short-form video file |
| `title` | string | Yes | Short title (max `100` chars) |
| `description` | string | No | Short description |
| `tags` | string[] | No | Additional tags (besides `#Shorts`) |
| `privacyStatus` | string: `public`, `private`, `unlisted` | No | Privacy status (default: `public`) |

### `youtubeComment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoId` | string | Yes | YouTube video ID |
| `text` | string | Yes | Comment text |
| `parentCommentId` | string | No | Parent comment ID for replying to a comment |

### `youtubeSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string: `video`, `channel`, `playlist` | No | Search type (default: `video`) |
| `maxResults` | number | No | Max results to return (default: `10`, max: `50`) |
| `order` | string: `relevance`, `date`, `rating`, `viewCount`, `title` | No | Sort order (default: `relevance`) |
| `regionCode` | string | No | ISO 3166-1 alpha-2 region code (e.g., `US`, `GB`) |

### `youtubeTrending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `regionCode` | string | No | ISO 3166-1 alpha-2 region code (default: `US`) |
| `categoryId` | string | No | YouTube video category ID (e.g., `10` for Music, `17` for Sports, `20` for Gaming) |
| `maxResults` | number | No | Max results to return (default: `20`, max: `50`) |

### `youtubeAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string: `video`, `channel` | Yes | Whether to get analytics for a video or a channel |
| `videoId` | string | No | Video ID (required when `type` is `video`) |
| `channelId` | string | No | Channel ID (optional for `type` `channel`, defaults to own channel if OAuth is set up) |

### `youtubePlaylist`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `create`, `list`, `listItems`, `addVideo`, `delete` | Yes | Playlist action to perform |
| `title` | string | No | Playlist title (required for create) |
| `description` | string | No | Playlist description |
| `privacyStatus` | string: `public`, `private`, `unlisted` | No | Privacy status (default: `public`) |
| `playlistId` | string | No | Playlist ID (required for `listItems`, `addVideo`, `delete`) |
| `videoId` | string | No | Video ID (required for `addVideo`) |
| `channelId` | string | No | Channel ID (optional for list, defaults to own channel) |
| `maxResults` | number | No | Max results for list operations |

### `youtubeSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoUrl` | string | Yes | URL of the video file to upload |
| `title` | string | Yes | Video title (max `100` chars) |
| `description` | string | Yes | Video description (max `5000` chars) |
| `publishAt` | string | Yes | ISO 8601 datetime for scheduled publish time |
| `tags` | string[] | No | Video tags for discoverability |
| `categoryId` | string | No | YouTube category ID (default: `22`, People & Blogs) |
| `mimeType` | string | No | Video MIME type (default: `video/mp4`) |

## Channel adapter

The adapter registers platform `youtube`. Activation initializes the API service, and connection status follows its running state. A video block triggers an upload from its HTTPS URL; metadata comes from `platformOptions.title`, `platformOptions.tags`, `platformOptions.categoryId` and `platformOptions.privacyStatus`. The title falls back to the video caption, then `Untitled`; a text block supplies the description before the caption fallback.

Without a video block, sending posts a comment using `conversationId` as the video ID and `replyToMessageId` as the optional parent comment ID. Empty video IDs or comment text throw. The adapter stores event handlers but emits no inbound events. Typing indicators do nothing.

## Notes

Creating the pack throws if no API key resolves. Uploads, comments, playlist creation, playlist additions and playlist deletion require OAuth credentials and change content on the account. Listing the account's own playlists also requires OAuth. Channel analytics require `channelId` when OAuth is absent.

Upload tools fetch HTTP or HTTPS video URLs and stream responses to the API. They set no download timeout, check no HTTP response status and implement no redirect handling. The service defaults uploads to `public`, `video/mp4` and the People & Blogs category, and sets `selfDeclaredMadeForKids` to `false`.

Shorts uploads add `Shorts` to tags and append `#Shorts` to the description. The code does not validate duration or orientation. Scheduling rejects invalid or past dates, then uploads with `private` privacy and `publishAt`; it uses no local publishing timer.

Search, trending and playlist listing requests are capped at `50` results. Playlist lists default to `25` results. Tool failures return `success: false` and an error message. Action-specific playlist fields and video analytics IDs are checked during execution despite being optional in their schemas.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
