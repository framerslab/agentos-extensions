# Instagram channel

This pack gives an agent media publishing, comments, hashtag lookup and engagement analytics through the Instagram Graph API using `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-instagram
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-instagram',
        options: {
          accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
          igUserId: process.env.INSTAGRAM_USER_ID,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `instagram.accessToken` | `INSTAGRAM_ACCESS_TOKEN` | Yes, manifest | Empty string |
| `igUserId` | `instagram.igUserId` | `INSTAGRAM_USER_ID` | No | None |
| `secrets` | | | No | Context `secrets`, then `{}` |
| | `instagram.username` | | No | Unused manifest secret |
| | `instagram.password` | | No | Unused manifest secret |

Options take precedence over secrets, then environment variables. Option `secrets` takes precedence over context `secrets`. On activation, an empty access token triggers a lookup in `FileTokenStore` for `instagram`; stored metadata can also supply `igUserId`. Without `igUserId`, the service reads the account id from `/me`.

## Tools

| Tool | What it does |
| --- | --- |
| `instagramPost` | Posts a photo or image carousel with a caption. |
| `instagramReel` | Uploads a video as an Instagram Reel. |
| `instagramStory` | Posts an image as an Instagram Story. |
| `instagramDm` | Requests a direct message, but returns a permissions error. |
| `instagramLike` | Requests a like, but only logs the intent. |
| `instagramComment` | Posts a comment on an Instagram media item. |
| `instagramFollow` | Requests a follow or unfollow, but returns an unsupported-action error. |
| `instagramHashtags` | Searches hashtags and retrieves their top media. |
| `instagramExplore` | Reads recent media from the authenticated account. |
| `instagramAnalytics` | Reads post or account engagement analytics. |

### `instagramPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imageUrls` | string[] | Yes | Image URLs for a single post or carousel. |
| `caption` | string | No | Post caption with hashtags |

### `instagramReel`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `videoUrl` | string | Yes | URL of the video file |
| `caption` | string | No | Reel caption with hashtags |
| `coverUrl` | string | No | Cover image URL |

### `instagramStory`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `imageUrl` | string | Yes | URL of the image to post as a story |

### `instagramDm`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string, enum: `send` | Yes | DM action |
| `recipientId` | string | Yes | Instagram user ID to message |
| `text` | string | Yes | Message text |

### `instagramLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `mediaId` | string | Yes | Instagram media ID to like |

### `instagramComment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `mediaId` | string | Yes | Instagram media ID to comment on |
| `text` | string | Yes | Comment text |

### `instagramFollow`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `userId` | string | Yes | Instagram user ID to follow/unfollow |
| `unfollow` | boolean | No | Set to true to unfollow; default: `false`. |

### `instagramHashtags`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `hashtag` | string | Yes | Hashtag to research (without #) |
| `action` | string, enum: `search`, `topMedia` | No | `search` to find hashtag, `topMedia` to get its top posts; default: `search`. |
| `hashtagId` | string | No | Hashtag ID (required for `topMedia` action) |

### `instagramExplore`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | No | Number of recent posts to fetch |

### `instagramAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `scope` | string, enum: `post`, `account` | No | Whether to get post-level or account-level analytics; default: `account`. |
| `mediaId` | string | No | Media ID to analyze (required for post scope) |

## Channel adapter

The adapter registers platform `instagram` and initializes an authenticated Graph API client. It maps image, carousel, reel, story and video blocks to media publishing, using a text block as the caption. Text-only messages fail. It stores event handlers but has no inbound event delivery code. Typing indicators do nothing; reactions call the logging-only like method.

## Notes

Publishing and commenting write to Instagram. Reel publishing polls media processing every `3000` ms for up to `60000` ms and throws on failure or timeout. The DM and follow tools return errors directing the caller to browser automation; this pack does not implement that fallback. The like tool reports success after logging, without an API request.

The manifest requires an access token, but the factory does not reject an empty token locally. Activation attempts the token-store fallback and then initializes the service. Calls requiring a client fail before initialization. Missing media insights are returned as zero-valued metrics.

## License

Apache-2.0
