# LinkedIn channel

This pack gives an agent feed posts, comments, likes, reshares, search, analytics and scheduled posts through the LinkedIn Marketing and Community Management APIs using `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-linkedin
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-channel-linkedin';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    accessToken: process.env.LINKEDIN_ACCESS_TOKEN,
    organizationId: process.env.LINKEDIN_ORGANIZATION_ID,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `linkedin.accessToken` | `LINKEDIN_ACCESS_TOKEN` | Yes | None |
| `clientId` | `linkedin.clientId` | `LINKEDIN_CLIENT_ID` | No | None |
| `clientSecret` | `linkedin.clientSecret` | `LINKEDIN_CLIENT_SECRET` | No | None |
| `organizationId` | `linkedin.organizationId` | `LINKEDIN_ORGANIZATION_ID` | No | None |
| `secrets` | | | No | Context `secrets`, then `{}` |

Options take precedence over secrets, then environment variables. Option `secrets` takes precedence over context `secrets`. Activation tries `FileTokenStore` for `linkedin` when no access token is available. The factory resolves `clientId` and `clientSecret`, but the service does not use them to obtain or refresh tokens. Configured `organizationId` is used for analytics; company posting uses the tool's `organizationId` argument.

## Tools

| Tool | What it does |
| --- | --- |
| `linkedinPost` | Posts text with optional media or an article link and visibility control. |
| `linkedinComment` | Comments on a LinkedIn post. |
| `linkedinLike` | Likes or unlikes a post. |
| `linkedinShare` | Reshares a post with optional commentary. |
| `linkedinSearch` | Searches posts, people or companies. |
| `linkedinAnalytics` | Gets engagement metrics for a post. |
| `linkedinSchedule` | Schedules a post or publishes it immediately when the requested time has passed. |
| `linkedinOrgPost` | Posts to a company page with organization admin access. |

### `linkedinPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Post text content |
| `mediaPath` | string | No | URL or local path to media file (image/video) to attach |
| `articleUrl` | string | No | URL of article to share |
| `articleTitle` | string | No | Title for the article link preview |
| `visibility` | string, enum: `PUBLIC`, `CONNECTIONS` | No | Post visibility (default `PUBLIC`) |

### `linkedinComment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID or URN of the LinkedIn post to comment on |
| `text` | string | Yes | Comment text |

### `linkedinLike`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID or URN of the LinkedIn post |
| `unlike` | boolean | No | Set to true to unlike; default: `false`. |

### `linkedinShare`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID or URN of the LinkedIn post to reshare |
| `commentary` | string | No | Optional commentary to add when sharing |

### `linkedinSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Search query |
| `type` | string, enum: `posts`, `people`, `companies` | No | Type of search (default `posts`) |
| `limit` | number | No | Max results to return |

### `linkedinAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `postId` | string | Yes | ID or URN of the LinkedIn post to analyze |

### `linkedinSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `text` | string | Yes | Post text content |
| `scheduledAt` | string | Yes | ISO timestamp for when to post |
| `mediaPath` | string | No | Optional URL or path to media file |
| `visibility` | string, enum: `PUBLIC`, `CONNECTIONS` | No | Post visibility (default `PUBLIC`) |

### `linkedinOrgPost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `organizationId` | string | Yes | LinkedIn organization ID (numeric) |
| `text` | string | Yes | Post text content |
| `mediaPath` | string | No | Optional URL or path to media file (image/video) |
| `articleUrl` | string | No | Optional URL of article to share |
| `articleTitle` | string | No | Title for the article link preview |
| `visibility` | string, enum: `PUBLIC`, `CONNECTIONS` | No | Post visibility (default `PUBLIC`) |

## Channel adapter

The adapter registers platform `linkedin` and initializes a bearer-authenticated HTTP client. It converts text, image, video and article blocks into a personal feed post, with visibility from `platformOptions.visibility`. It ignores `conversationId` when posting. Reactions call the like method; typing indicators do nothing. It stores handlers but has no inbound event delivery code.

## Notes

Posting, commenting, liking, unliking and resharing change LinkedIn content. Media sources are downloaded from URLs or read from local files and uploaded through the image upload endpoint. Article attachments take precedence over media attachments. Although schemas mention video, the service has no separate video upload implementation. The exported `LinkedInService.deletePost` method deletes posts but is not a registered tool.

Scheduled posts use process-local timers and an in-memory map. Scheduled publishing failures are swallowed. Shutdown does not clear those timers. Initialization throws when the token-store fallback supplies no access token. Selected API methods report expired or invalid tokens and request a refreshed token; the pack does not refresh it automatically. Organization statistics failures leave impressions and clicks at zero. Service operations wait a tenth of a second at their rate-limit checkpoints.

## License

Apache-2.0
