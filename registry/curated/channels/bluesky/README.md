# Bluesky channel

This pack gives an agent posting, engagement, search, feed and analytics tools for Bluesky using the AT Protocol through `@atproto/api`.

## Installation

```bash
npm install @framers/agentos-ext-channel-bluesky
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-channel-bluesky';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    handle: process.env.BLUESKY_HANDLE ?? process.env.BSKY_HANDLE,
    appPassword: process.env.BLUESKY_APP_PASSWORD ?? process.env.BSKY_APP_PASSWORD,
    service: process.env.BLUESKY_SERVICE ?? process.env.BSKY_SERVICE,
  },
}));
```

## Configuration

Options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `handle` | `bluesky.handle` | `BLUESKY_HANDLE`, `BSKY_HANDLE` | Yes | `''` |
| `appPassword` | `bluesky.appPassword` | `BLUESKY_APP_PASSWORD`, `BSKY_APP_PASSWORD` | Yes | `''` |
| `service` | `bluesky.service` | `BLUESKY_SERVICE`, `BSKY_SERVICE` | No | `https://bsky.social` |
| `secrets` | None | None | No | `context.secrets`, then `{}` |

## Tools

| Tool | What it does |
| --- | --- |
| `blueskyAnalytics` | Retrieves likes, reposts and replies for a post. |
| `blueskyFeed` | Retrieves the authenticated user's timeline or an author's feed. |
| `blueskyFollow` | Follows or unfollows a Bluesky user. |
| `blueskyLike` | Likes or unlikes a Bluesky post. |
| `blueskyPost` | Creates a Bluesky post with text, images and language tags. |
| `blueskyReply` | Replies to a post with parent and root thread references. |
| `blueskyRepost` | Reposts a post or removes a repost. |
| `blueskySearch` | Searches Bluesky posts or people. |

### `blueskyAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string | Yes | AT URI of the post to analyze |

### `blueskyFeed`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string: `timeline`, `author` | No | Feed type (default: `timeline`) |
| `handle` | string | No | Author handle (required when `type` is `author`) |
| `limit` | number | No | Max posts to return (default 50, max 100) |

### `blueskyFollow`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `handle` | string | Yes | Bluesky handle to follow (e.g. "alice.bsky.social") |
| `unfollow` | boolean | No | Set to true to unfollow (`handle` should then be the follow record URI) |

### `blueskyLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string | Yes | AT URI of the post to like |
| `cid` | string | Yes | CID of the post to like |
| `unlike` | boolean | No | Set to true to unlike (`uri` should then be the like record URI) |

### `blueskyPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Post text (max 300 graphemes). Mentions (@handle), links, and #hashtags are auto-detected. |
| `imagePaths` | array of string | No | File paths to images to attach (max 4) |
| `langs` | array of string | No | Language tags (e.g. ["en", "ja"]) |

### `blueskyReply`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `parentUri` | string | Yes | AT URI of the post to reply to |
| `parentCid` | string | Yes | CID of the post to reply to |
| `rootUri` | string | No | AT URI of the thread root (defaults to parent) |
| `rootCid` | string | No | CID of the thread root (defaults to parent) |
| `text` | string | Yes | Reply text |

### `blueskyRepost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `uri` | string | Yes | AT URI of the post to repost |
| `cid` | string | Yes | CID of the post to repost |
| `undo` | boolean | No | Set to true to undo repost (`uri` should then be the repost record URI) |

### `blueskySearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string: `posts`, `people` | No | Search type (default: `posts`) |
| `limit` | number | No | Max results to return (default 25, max 100) |

## Channel adapter

The adapter registers platform `bluesky` and logs in through `BskyAgent`. Sending creates a post from the first text block and image blocks containing `data`. Replies use `replyToMessageId` and `platformOptions.cid`. Reactions fetch the post CID and create a like. The adapter stores event handlers but does not fetch or dispatch inbound events. Typing indicators do nothing.

## Notes

Posting, replying, liking, reposting and following change remote records. Undo operations delete the corresponding like, repost or follow record. For undo operations, pass the record URI returned by the original operation.

The app password is generated through Settings > App Passwords. Activation attempts to load missing credentials through `FileTokenStore` from `@framers/agentos/auth`, then throws if the handle or app password remains missing. The service detects mentions, links and hashtags through `RichText` and uploads attached images as blobs.

## License

Apache-2.0
