# Mastodon channel

This pack gives an agent status posting, replies, boosts, favourites, search, trending content, follows and engagement metrics through the Mastodon API using `masto`.

## Installation

```bash
npm install @framers/agentos-ext-channel-mastodon
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-mastodon',
        options: {
          accessToken: process.env.MASTODON_ACCESS_TOKEN,
          instanceUrl: process.env.MASTODON_INSTANCE_URL,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `mastodon.accessToken` | `MASTODON_ACCESS_TOKEN` | Yes | Empty string |
| `instanceUrl` | `mastodon.instanceUrl` | `MASTODON_INSTANCE_URL` | No | `https://mastodon.social` |
| `secrets` | | | No | Context `secrets`, then `{}` |

Options take precedence over secrets, then environment variables. Option `secrets` takes precedence over context `secrets`. Activation tries `FileTokenStore` for `mastodon` when the access token is empty. Stored metadata can override `instanceUrl` when a stored token is loaded.

## Tools

| Tool | What it does |
| --- | --- |
| `mastodonPost` | Posts a status with optional content warning, visibility and media. |
| `mastodonReply` | Replies to an existing status. |
| `mastodonBoost` | Boosts or unboosts a status. |
| `mastodonFavourite` | Favourites or unfavourites a status. |
| `mastodonSearch` | Searches accounts, hashtags or statuses. |
| `mastodonTrending` | Gets trending tags, statuses or links on the instance. |
| `mastodonFollow` | Follows or unfollows an account. |
| `mastodonAnalytics` | Gets boosts, favourites and replies for a status. |

### `mastodonPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Status text |
| `spoilerText` | string | No | Content warning / spoiler text |
| `visibility` | string, enum: `public`, `unlisted`, `private`, `direct` | No | Post visibility (default: `public`) |
| `mediaPath` | string | No | Path to media file to attach |
| `sensitive` | boolean | No | Mark media as sensitive |
| `language` | string | No | Language code (e.g. `en`) |

### `mastodonReply`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `statusId` | string | Yes | ID of the status to reply to |
| `text` | string | Yes | Reply text |
| `spoilerText` | string | No | Content warning / spoiler text |

### `mastodonBoost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `statusId` | string | Yes | ID of the status to boost |
| `undo` | boolean | No | Set to true to unboost; default: `false`. |

### `mastodonFavourite`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `statusId` | string | Yes | ID of the status |
| `undo` | boolean | No | Set to true to unfavourite; default: `false`. |

### `mastodonSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string, enum: `accounts`, `hashtags`, `statuses` | No | Filter results by type |
| `limit` | number | No | Max results to return |

### `mastodonTrending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | string, enum: `tags`, `statuses`, `links` | No | Type of trending content (default: `tags`) |
| `limit` | number | No | Max results to return |

### `mastodonFollow`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | Yes | ID of the account to follow |
| `undo` | boolean | No | Set to true to unfollow; default: `false`. |

### `mastodonAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `statusId` | string | Yes | ID of the status to analyze |

## Channel adapter

The adapter registers platform `mastodon` and initializes the REST client with an instance URL and access token. It posts text with image or video attachments, spoiler text, `replyToMessageId` and `platformOptions.visibility`. It ignores `conversationId` when posting. Reactions become favourites and typing indicators do nothing. It stores handlers but has no inbound event delivery code.

## Notes

Posts, replies, boosts, favourites and follows change the configured Mastodon account. Media uploads read local files; the adapter treats media block `url` values as file paths and skips failed uploads. The post tool returns an error when its media upload fails.

Initialization throws if no access token is available after the token-store fallback. Client-dependent calls fail before initialization. Search and trending limits are passed to the SDK; schema descriptions mention defaults and a search maximum, but the service does not supply those numeric defaults or enforce that maximum. Visibility is passed through to the SDK rather than defaulted locally.

The exported `MastodonService` also supports deleting statuses, reading timelines and server-side scheduled posting through `scheduledAt`; these are not registered tools.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
