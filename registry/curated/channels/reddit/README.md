# Reddit channel

This pack gives an agent tools for Reddit posts, comments, votes, search, trends, subscriptions, private messages and account analytics. Its channel adapter uses `snoowrap` for outbound actions and inbox polling.

## Installation

```bash
npm install @framers/agentos-ext-channel-reddit
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-reddit',
        options: {
          clientId: process.env.REDDIT_CLIENT_ID,
          clientSecret: process.env.REDDIT_CLIENT_SECRET,
          username: process.env.REDDIT_USERNAME,
          password: process.env.REDDIT_PASSWORD,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then the environment.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `clientId` | `reddit.clientId` | `REDDIT_CLIENT_ID` | yes | None |
| `clientSecret` | `reddit.clientSecret` | `REDDIT_CLIENT_SECRET` | yes | None |
| `username` | `reddit.username` | `REDDIT_USERNAME` | yes | None |
| `password` | `reddit.password` | `REDDIT_PASSWORD` | yes | None |
| `userAgent` | None | None | no | Generated AgentOS identifier containing the username |
| `priority` | None | None | no | `50` |
| `secrets` | Credential ids above | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `reddit.post` | Submits a text, link, image or poll post to a subreddit. |
| `reddit.comment` | Comments on a post or replies to a comment. |
| `reddit.vote` | Upvotes, downvotes or removes a vote on a post or comment. |
| `reddit.search` | Searches posts across Reddit or within a subreddit. |
| `reddit.trending` | Gets posts from the front page or a subreddit with a selected sort order. |
| `reddit.subscribe` | Joins or leaves a subreddit. |
| `reddit.inbox` | Reads inbox messages or sends a private message. |
| `reddit.analytics` | Gets user karma and activity analytics, defaulting to the authenticated account. |

### `reddit.post`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `subreddit` | string | yes | Target subreddit name (without `r/` prefix) |
| `title` | string | yes | Post title (max `300` characters) |
| `content` | string | yes | Post body text (for text/poll), URL (for link/image) |
| `type` | string: `text`, `link`, `image`, `poll` | yes | Post type: text, link, image, or poll |
| `pollOptions` | string[] | no | Poll answer options (required for poll type) |
| `pollDurationDays` | number | no | Poll duration in days (`1` to `7`, default `3`) |
| `flairId` | string | no | Optional flair ID for the post |
| `nsfw` | boolean | no | Mark post as NSFW |
| `spoiler` | boolean | no | Mark post as spoiler |

### `reddit.comment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `thingId` | string | yes | Reddit fullname of the post (`t3_xxx`) or comment (`t1_xxx`) to reply to |
| `text` | string | yes | Comment text (supports Reddit Markdown, max `10000` characters) |

### `reddit.vote`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `thingId` | string | yes | Reddit fullname of the post (`t3_xxx`) or comment (`t1_xxx`) to vote on |
| `direction` | string: `up`, `down`, `none` | yes | Vote direction: up (upvote), down (downvote), or none (remove vote) |

### `reddit.search`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Search query string |
| `subreddit` | string | no | Optional subreddit to search within (without `r/` prefix) |
| `sort` | string: `relevance`, `hot`, `top`, `new`, `comments` | no | Sort order for results (default: `relevance`) |
| `time` | string: `hour`, `day`, `week`, `month`, `year`, `all` | no | Time filter for results (default: `all`) |
| `limit` | number, minimum `1`, maximum `100` | no | Maximum number of results to return (`1` to `100`, default: `25`) |

### `reddit.trending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `subreddit` | string | no | Optional subreddit to fetch trending from (without `r/` prefix). Omit for front page. |
| `sort` | string: `hot`, `top`, `rising`, `new`, `controversial` | no | Sort order (default: `hot`) |
| `time` | string: `hour`, `day`, `week`, `month`, `year`, `all` | no | Time filter (applies to top and controversial, default: `day`) |
| `limit` | number, minimum `1`, maximum `100` | no | Maximum number of results (`1` to `100`, default: `25`) |

### `reddit.subscribe`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `subreddit` | string | yes | Subreddit name to subscribe/unsubscribe (without `r/` prefix) |
| `action` | string: `subscribe`, `unsubscribe` | yes | Action to perform: subscribe (join) or unsubscribe (leave) |

### `reddit.inbox`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `read`, `send` | yes | Action: read (fetch inbox) or send (compose message) |
| `filter` | string: `unread`, `all` | no | Filter for read action: unread or all (default: `all`) |
| `limit` | number, minimum `1`, maximum `100` | no | Max messages to fetch for read action (`1` to `100`, default: `25`) |
| `to` | string | no | Recipient username for send action (without `u/` prefix) |
| `subject` | string | no | Message subject for send action |
| `body` | string | no | Message body for send action (supports Reddit Markdown) |

### `reddit.analytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `username` | string | no | Reddit username to analyze (without `u/` prefix). Omit for self. |

## Channel adapter

The adapter registers platform `reddit`. Activation authenticates through `snoowrap` and starts inbox polling. It emits inbox bodies as direct messages under `u/<author>`, or thread messages when a parent id exists.

Sending to `r/<subreddit>` creates a post, using `platformOptions.title` or `Untitled`. Sending to a fullname beginning with `t3_` or `t1_` replies to that post or comment. Sending to `u/<username>` sends a private message with subject `Message from agent`. Other identifiers fall back to a comment reply. Reactions map to votes. Typing indicators do nothing.

## Notes

Posting, commenting, voting, subscribing and sending private messages change the Reddit account or publish content. Image posts submit the image URL as a link. Poll posts submit text containing the poll options; `pollDurationDays` does not affect the service's submission.

Missing required credentials make pack creation throw. Activation fetches the authenticated user and throws if authentication fails. Post titles are limited to `300` characters, comments to `10000`, and poll posts require at least `2` options. The send action of `reddit.inbox` requires `to`, `subject` and `body` at execution.

Inbox polling runs every `60000` ms and fetches up to `10` unread messages. The SDK uses a `1000` ms request delay, a `5000` ms retry delay and at most `3` retry attempts, and continues after rate limit errors. Analytics requests up to `100` submissions and `100` comments, and returns the most active subreddits, limited to `10`.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
