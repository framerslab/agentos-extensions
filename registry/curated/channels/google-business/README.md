# Google Business channel

This pack gives an agent tools to create local posts, reply to reviews, retrieve insights and update Google Business Profile information using the Google My Business API through `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-google-business
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-google-business',
        options: {
          accessToken: process.env.GOOGLE_ACCESS_TOKEN,
          refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
          locationId: process.env.GOOGLE_LOCATION_ID,
        },
      },
    ],
  },
});
```

## Configuration

Options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `google.accessToken` | `GOOGLE_ACCESS_TOKEN` | Yes | `''` |
| `refreshToken` | `google.refreshToken` | `GOOGLE_REFRESH_TOKEN` | No | Unset |
| `locationId` | `google.locationId` | `GOOGLE_LOCATION_ID` | No | Unset |
| `secrets` | None | None | No | `context.secrets`, then `{}` |

## Tools

| Tool | What it does |
| --- | --- |
| `gbpAnalytics` | Retrieves analytics insights for a business location. |
| `gbpCreatePost` | Creates a local post with optional media and a call to action. |
| `gbpReply` | Replies to a customer review. |
| `gbpUpdateInfo` | Updates a location's description, website or phone number. |

### `gbpAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `locationName` | string | Yes | Location resource name (e.g. "locations/123") |
| `metrics` | array of string | Yes | Metrics to retrieve (e.g. "QUERIES_DIRECT", "QUERIES_INDIRECT", "VIEWS_MAPS", "VIEWS_SEARCH", "ACTIONS_WEBSITE", "ACTIONS_PHONE", "ACTIONS_DRIVING_DIRECTIONS") |

### `gbpCreatePost`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `locationName` | string | Yes | Location resource name (e.g. "locations/123") |
| `summary` | string | Yes | Post text content |
| `topicType` | string: `STANDARD`, `EVENT`, `OFFER` | No | Post type (default "STANDARD") |
| `callToActionType` | string | No | CTA button type (e.g. "LEARN_MORE", "BOOK", "ORDER", "SHOP", "SIGN_UP", "CALL") |
| `callToActionUrl` | string | No | CTA button URL |
| `mediaUrl` | string | No | URL of image to attach |

### `gbpReply`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `reviewName` | string | Yes | Review resource name (e.g. "locations/123/reviews/456") |
| `comment` | string | Yes | Reply text |

### `gbpUpdateInfo`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `locationName` | string | Yes | Location resource name (e.g. "locations/123") |
| `description` | string | No | Updated business description |
| `websiteUri` | string | No | Updated website URL |
| `primaryPhone` | string | No | Updated primary phone number |

## Channel adapter

The adapter registers platform `google-business` and initializes an HTTP client with a bearer token. The configured `locationId` becomes the adapter's default `locations/<locationId>` resource name. Sending uses `platformOptions.locationName`, then the adapter default, then `conversationId`.

The first text block becomes a local post summary, with an optional image URL. When `replyToMessageId` is present, sending replies to that review instead. The adapter stores event handlers but does not fetch or dispatch inbound events. Typing indicators and reactions do nothing.

## Notes

Creating posts, replying to reviews and updating business information change remote content. The exported service also exposes `deleteLocalPost`.

Activation tries `FileTokenStore` from `@framers/agentos/auth` when the access token is missing. Initialization throws if no access token is available. The resolved refresh token is stored but is not used to refresh access tokens.

Post requests set `languageCode` to `en` and default `topicType` to `STANDARD`. The create-post tool includes a call to action only when both its type and URL are provided. Insight requests cover the preceding `30` days. Business updates send an update mask for the supplied fields, even when no fields are supplied.

## License

Apache-2.0
