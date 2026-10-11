# Threads channel

This pack gives an agent tools to publish Threads posts, replies and quotes, change likes, browse recent posts and read engagement metrics. Its channel adapter calls Meta's Threads Publishing API through `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-threads
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-threads',
        options: {
          accessToken: process.env.THREADS_ACCESS_TOKEN,
          userId: process.env.THREADS_USER_ID,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from direct options, then the selected secrets map, then the environment. The secrets map is `options.secrets` when supplied, otherwise `context.secrets`; the maps are not merged.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `threads.accessToken` | `THREADS_ACCESS_TOKEN`, `META_ACCESS_TOKEN` | yes | Empty string; activation attempts token-store fallback |
| `userId` | `threads.userId` | `THREADS_USER_ID` | no | Resolved from `/me` during initialization |
| `secrets` in options or context | `threads.accessToken`, `threads.userId` | None | no | Empty map |

## Tools

| Tool | What it does |
| --- | --- |
| `threadsPost` | Creates a post with text and optional image, video or carousel items. |
| `threadsReply` | Replies to a post with text and optional media. |
| `threadsLike` | Likes or unlikes a post. |
| `threadsSearch` | Browses recent user posts and optionally filters their text. |
| `threadsAnalytics` | Gets views, likes, replies, reposts and quotes for a post. |
| `threadsQuote` | Quotes a post with a comment. |

### `threadsPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | yes | Post text (max `500` characters) |
| `imageUrl` | string | no | URL of image to attach |
| `videoUrl` | string | no | URL of video to attach |
| `carouselItems` | object[] | no | Carousel items (array of image/video objects) |

Each object in `carouselItems` has this schema:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string: `IMAGE`, `VIDEO` | yes | Media type |
| `url` | string | yes | Media URL |

### `threadsReply`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | yes | ID of the Threads post to reply to |
| `text` | string | yes | Reply text |
| `mediaUrl` | string | no | Optional image or video URL to attach |

### `threadsLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | yes | ID of the Threads post |
| `unlike` | boolean | no | Set to true to unlike; defaults to `false` |

### `threadsSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | no | Optional filter keyword (client-side filtering on returned posts) |
| `limit` | number | no | Max posts to return (default `25`, max `100`) |

### `threadsAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | yes | ID of the Threads post to analyze |

### `threadsQuote`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | yes | ID of the Threads post to quote |
| `text` | string | yes | Your quote comment |

## Channel adapter

The adapter registers platform `threads`. Initialization creates an authenticated HTTP client and resolves the user id. Sending ignores `conversationId`: it uses `replyToMessageId` for replies, then selects `carousel_item` blocks, video, image or text content for a new post. Each carousel block uses `mediaType` and `url`. Reactions like the specified message regardless of the reaction value. The adapter stores handlers but does not emit inbound events. Typing indicators do nothing.

## Notes

Posting, replying and quoting publish content; liking and unliking change account interactions. The exported `ThreadsService.deletePost` deletes a post, but the factory does not register a deletion tool.

When the resolved token is empty, activation attempts to load the `threads` token through `FileTokenStore` from `@framers/agentos/auth`. Activation throws if no token is available. An omitted `userId` triggers a profile request.

Media publishing creates containers and waits for `FINISHED` before publishing. Image, carousel child and media reply polling allows `20` attempts with a `1000` ms interval. Standalone video polling allows `30` attempts with a `2000` ms interval. An `ERROR` status or exhausted attempts makes publishing fail.

`threadsSearch` retrieves the configured user's recent posts and filters the returned text locally, ignoring case. It does not perform a remote keyword search. The post schema describes a `500`-character text limit; the tool does not enforce that limit locally.

## License

Apache-2.0
