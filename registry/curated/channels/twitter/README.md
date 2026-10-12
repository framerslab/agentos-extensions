# Twitter channel

This pack gives an agent tweet posting, replies, quotes, threads, engagement, search, trends, direct messages, analytics and scheduling through `twitter-api-v2`.

## Installation

```bash
npm install @framers/agentos-ext-channel-twitter
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-twitter',
        options: {
          bearerToken: process.env.TWITTER_BEARER_TOKEN,
          apiKey: process.env.TWITTER_API_KEY,
          apiSecret: process.env.TWITTER_API_SECRET,
          accessToken: process.env.TWITTER_ACCESS_TOKEN,
          accessSecret: process.env.TWITTER_ACCESS_SECRET,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `bearerToken` | `twitter.bearerToken` | `TWITTER_BEARER_TOKEN`, `X_BEARER_TOKEN` | Yes, by manifest | None |
| `apiKey` | `twitter.apiKey` | `TWITTER_API_KEY`, `X_API_KEY`, `X_CONSUMER_KEY`, `TWITTER_CONSUMER_KEY` | No | None |
| `apiSecret` | `twitter.apiSecret` | `TWITTER_API_SECRET`, `X_API_SECRET`, `X_CONSUMER_SECRET`, `X_CONSUMER_SECRET_KEY`, `TWITTER_CONSUMER_SECRET` | No | None |
| `accessToken` | `twitter.accessToken` | `TWITTER_ACCESS_TOKEN`, `X_ACCESS_TOKEN` | No | None |
| `accessSecret` | `twitter.accessSecret` | `TWITTER_ACCESS_SECRET`, `X_ACCESS_SECRET`, `X_ACCESS_TOKEN_SECRET`, `TWITTER_ACCESS_TOKEN_SECRET` | No | None |
| `secrets` | All credential secret ids above | None | No | `context.secrets`, then `{}` |

Credentials resolve from options, then secrets, then the listed environment variables in order. `options.secrets` takes precedence over `context.secrets`. Resolution uses nullish fallback, so an empty string blocks later values.

## Tools

| Tool | What it does |
| --- | --- |
| `twitterPost` | Post a tweet with optional media and a poll. |
| `twitterReply` | Reply to an existing tweet. |
| `twitterQuote` | Quote an existing tweet with a comment. |
| `twitterLike` | Like or unlike a tweet. |
| `twitterRetweet` | Retweet or undo a retweet. |
| `twitterSearch` | Search tweets with filters and sorting. |
| `twitterTrending` | Get trending topics for a location, defaulting to worldwide. |
| `twitterTimeline` | Get the authenticated user's home timeline. |
| `twitterDm` | Send or list direct messages. |
| `twitterAnalytics` | Get likes, retweets, replies and impressions for a tweet. |
| `twitterSchedule` | Schedule a tweet for future posting. |
| `twitterThread` | Post tweet texts as sequential replies. |

### `twitterPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Tweet text (max `280` characters) |
| `mediaPath` | string | No | Path to media file to attach |
| `pollOptions` | string[] | No | Poll options (`2` to `4` choices) |
| `pollDurationMinutes` | number | No | Poll duration in minutes (default `1440`, a day) |

### `twitterReply`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tweetId` | string | Yes | ID of the tweet to reply to |
| `text` | string | Yes | Reply text |

### `twitterQuote`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tweetId` | string | Yes | ID of the tweet to quote |
| `text` | string | Yes | Your quote comment |

### `twitterLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tweetId` | string | Yes | ID of the tweet |
| `unlike` | boolean | No | Set to `true` to unlike; default `false` |

### `twitterRetweet`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tweetId` | string | Yes | ID of the tweet to retweet |
| `undo` | boolean | No | Set to `true` to unretweet; default `false` |

### `twitterSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query (supports Twitter search operators) |
| `maxResults` | number | No | Max tweets to return (default `10`, max `100`) |
| `sortOrder` | string: `recency`, `relevancy` | No | Sort order |

### `twitterTrending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `woeid` | number | No | Yahoo WOEID for location (`1` = worldwide, `23424977` = US); default `1` |

### `twitterTimeline`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `maxResults` | number | No | Max tweets to return (default `20`, max `100`) |

### `twitterDm`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `send`, `list` | Yes | Action to perform |
| `recipientId` | string | No | User ID to send DM to (required for send) |
| `text` | string | No | Message text (required for send) |
| `maxResults` | number | No | Max DM events to return (for list); default `20` |

### `twitterAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tweetId` | string | Yes | ID of the tweet to analyze |

### `twitterSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Tweet text |
| `scheduledAt` | string | Yes | ISO 8601 timestamp for when to post |
| `mediaPath` | string | No | Optional media file path |

### `twitterThread`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `tweets` | string[]; minimum `2` items | Yes | Array of tweet texts (each max `280` characters). Posted as a sequential thread. |

## Channel adapter

The adapter registers platform `twitter`. Sending posts the first text block, uploads image and video blocks through the SDK, attaches poll options and converts poll duration from hours to minutes. It reads `replyToMessageId` for replies and ignores `conversationId`. Failed media uploads are skipped. Reactions call the like operation regardless of the supplied reaction.

Activation initializes API clients. Connection status follows the service's running state, with initialization errors exposed in connection information. The adapter stores handlers but emits no inbound events. Typing indicators do nothing.

## Notes

A bearer token supplies the read client. Posting, engagement, media uploads, home timeline and direct messages require `apiKey`, `apiSecret`, `accessToken` and `accessSecret` together. The service also uses that write client for reads when no bearer token is set, although the manifest declares `twitter.bearerToken` required.

If neither `bearerToken` nor `apiKey` is set, activation attempts to load a stored Twitter access token through `FileTokenStore` from `@framers/agentos/auth`. Initialization throws if no read or write client can be created.

Write tools publish tweets, send messages or change likes and retweets. Threads post sequentially without rollback. `recipientId` is passed directly to the SDK's `sendDmInConversation` method. Timeline and direct-message listing requests are capped at `100` results; search forwards `maxResults` without a local cap and defaults to `relevancy` sorting.

Scheduling stores timers in memory without persistence or cancellation. A past timestamp posts immediately and ignores `mediaPath`. Future scheduled posts upload media at execution time and silently discard failures. Pack deactivation shuts down the service but does not clear scheduled timers.

## License

Apache-2.0
