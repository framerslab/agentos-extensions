# Facebook channel

This pack gives an agent tools for Facebook posts, comments, likes, shares, searches, scheduling and page analytics using the Meta Graph API through `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-facebook
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-channel-facebook';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    accessToken: process.env.FACEBOOK_ACCESS_TOKEN,
    pageId: process.env.FACEBOOK_PAGE_ID,
    pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
  },
}));
```

## Configuration

Options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `facebook.accessToken` | `FACEBOOK_ACCESS_TOKEN` | Yes | Unset |
| `pageId` | `facebook.pageId` | `FACEBOOK_PAGE_ID` | No | Unset |
| `pageAccessToken` | `facebook.pageAccessToken` | `FACEBOOK_PAGE_ACCESS_TOKEN` | No | Unset; page requests use `accessToken` |
| `secrets` | None | None | No | `context.secrets`, then `{}` |

## Tools

| Tool | What it does |
| --- | --- |
| `facebookAnalytics` | Retrieves impressions, engaged users, clicks and reactions for a page post. |
| `facebookComment` | Adds a comment to a Facebook post. |
| `facebookLike` | Likes or unlikes a Facebook post. |
| `facebookPagePost` | Posts text, a link or media to a managed page. |
| `facebookPost` | Posts text, a link, a photo or a video to a page or profile. |
| `facebookSchedule` | Schedules a page post through the Graph API. |
| `facebookSearch` | Searches Facebook posts, pages or groups. |
| `facebookShare` | Shares a post to the user's feed with optional commentary. |

### `facebookAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID of the post to analyze |

### `facebookComment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID of the post to comment on |
| `text` | string | Yes | Comment text |

### `facebookLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID of the post |
| `unlike` | boolean | No | Set to true to unlike |

### `facebookPagePost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `pageId` | string | Yes | ID of the managed page |
| `text` | string | Yes | Post text content |
| `link` | string | No | URL to attach to the post |
| `mediaPath` | string | No | URL of photo or video to attach |

### `facebookPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Post text content |
| `link` | string | No | URL to attach to the post |
| `mediaPath` | string | No | URL of photo or video to attach |
| `mediaType` | string: `photo`, `video` | No | Type of media attachment |
| `pageId` | string | No | Page ID to post to (omit for personal profile) |

### `facebookSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Post text content |
| `scheduledTime` | string | Yes | ISO 8601 timestamp for when to publish |
| `pageId` | string | No | Page ID to post to (falls back to configured default) |
| `mediaPath` | string | No | Optional URL of photo to attach |

### `facebookSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string: `post`, `page`, `group` | No | Type of content to search for (default: post) |
| `limit` | number | No | Max results to return (default 10) |

### `facebookShare`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID of the post to share |
| `commentary` | string | No | Optional text to accompany the share |

## Channel adapter

The adapter registers platform `facebook` and initializes an HTTP client with a bearer token. Sending posts to `platformOptions.pageId` or `conversationId`. It uses the first text block, prioritizes an image URL over a video URL, and otherwise sends text with an optional link URL. Reactions create likes. Event handlers are stored but inbound events are not fetched or dispatched. Typing indicators do nothing.

## Notes

Posting, commenting, sharing, scheduling and liking change remote content. Unliking deletes the like. The exported service also exposes `deletePost`.

Activation tries `FileTokenStore` from `@framers/agentos/auth` if the access token is missing. Initialization throws if no token is available. Search access is restricted for some content types according to the tool description.

The resolved `pageId` is not used as a default by the posting service. Pass a page ID to page tools. `facebookSchedule` passes an empty page ID when omitted, despite its schema description. Past schedule times post immediately. Photo uploads do not forward scheduling fields. `facebookPagePost` treats `mediaPath` as a photo URL. `facebookPost` ignores media when posting to the personal profile.

## License

Apache-2.0
