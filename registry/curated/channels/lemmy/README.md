# Lemmy channel

This pack gives an agent posts, comments, voting, search, community subscriptions and feeds through the Lemmy HTTP API using `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-lemmy
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-channel-lemmy';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    instanceUrl: process.env.LEMMY_INSTANCE_URL,
    username: process.env.LEMMY_USERNAME,
    password: process.env.LEMMY_PASSWORD,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `instanceUrl` | `lemmy.instanceUrl` | `LEMMY_INSTANCE_URL` | Yes | Empty string |
| `username` | `lemmy.username` | `LEMMY_USERNAME` | Yes | Empty string |
| `password` | `lemmy.password` | `LEMMY_PASSWORD` | Yes | Empty string |
| `secrets` | | | No | Context `secrets`, then `{}` |

Options take precedence over secrets, then environment variables. Option `secrets` takes precedence over context `secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `lemmyPost` | Creates a post in a Lemmy community. |
| `lemmyComment` | Creates a comment on a post, optionally replying to another comment. |
| `lemmyVote` | Upvotes, downvotes or resets a vote on a post or comment. |
| `lemmySearch` | Searches posts, comments and communities. |
| `lemmySubscribe` | Subscribes to or unsubscribes from a community. |
| `lemmyFeed` | Gets feed posts by type and sort order. |

### `lemmyPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `communityId` | number | Yes | ID of the community to post in |
| `name` | string | Yes | Post title |
| `body` | string | No | Post body text (Markdown supported) |
| `url` | string | No | Optional URL to link |

### `lemmyComment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | number | Yes | ID of the post to comment on |
| `content` | string | Yes | Comment text (Markdown supported) |
| `parentId` | number | No | ID of parent comment for threaded replies |

### `lemmyVote`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string, enum: `post`, `comment` | Yes | Whether to vote on a post or comment |
| `id` | number | Yes | ID of the post or comment |
| `score` | number, enum: `1`, `0`, `-1` | Yes | `1` = upvote, `-1` = downvote, `0` = reset vote |

### `lemmySearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string, enum: `All`, `Posts`, `Comments`, `Communities` | No | Type of content to search (default `All`) |
| `limit` | number | No | Max results to return |

### `lemmySubscribe`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `communityId` | number | Yes | ID of the community |
| `follow` | boolean | No | `true` to subscribe, `false` to unsubscribe (default `true`) |

### `lemmyFeed`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string, enum: `All`, `Local`, `Subscribed` | No | Feed type (default `All`) |
| `sort` | string, enum: `Hot`, `New`, `Top` | No | Sort order (default `Hot`) |
| `limit` | number | No | Max posts to return |

## Channel adapter

The adapter registers platform `lemmy` and logs in using the configured instance and credentials. It sends a post using text, title and link blocks and `platformOptions.communityId`. A supplied `replyToMessageId` makes it create a comment on that post instead. The `conversationId` argument does not select the community. Reactions become post upvotes. Typing indicators do nothing. The adapter stores handlers but has no inbound event delivery code.

## Notes

Posts, comments, votes and subscription changes write to the configured instance. The exported `LemmyService.deletePost` method deletes a post, but is not a registered tool. Initialization throws for missing instance URL, username or password, or a login response without a JWT. Subsequent requests use the JWT as a bearer token. Activation initializes the service directly and again through the adapter.

## License

Apache-2.0
