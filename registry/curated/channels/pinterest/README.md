# Pinterest channel

This pack gives an agent tools for pins, boards, search, trends, analytics and publishing, plus a Pinterest channel adapter. It calls the Pinterest API through `axios`.

## Installation

```bash
npm install @framers/agentos-ext-channel-pinterest
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-pinterest',
        options: {
          accessToken: process.env.PINTEREST_ACCESS_TOKEN,
        },
      },
    ],
  },
});
```

## Configuration

The token resolves from `accessToken`, then `options.secrets`, then the environment names below in order.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accessToken` | `pinterest.accessToken` | Value of `accessTokenEnv` (defaults to `PINTEREST_ACCESS_TOKEN`), `PINTEREST_ACCESS_TOKEN`, `PINTEREST_TOKEN` | yes | None |
| `accessTokenEnv` | None | None | no | `PINTEREST_ACCESS_TOKEN` |
| `defaultBoardId` | None | None | no | None |
| `priority` | None | None | no | `50` |
| `secrets` | `pinterest.accessToken` | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `pinterestPin` | Creates a pin with an image, video or carousel of images. |
| `pinterestBoard` | Creates, lists or deletes boards. |
| `pinterestSearch` | Searches pins or boards by keyword. |
| `pinterestTrending` | Gets trending pins and topics by region. |
| `pinterestAnalytics` | Gets impressions, saves, clicks and closeups for a pin or board. |
| `pinterestSchedule` | Accepts a future publishing time for a pin. |

### `pinterestPin`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `boardId` | string | yes | Board ID to pin to |
| `title` | string | no | Pin title |
| `description` | string | no | Pin description |
| `link` | string | no | Destination URL |
| `mediaType` | string: `image`, `video`, `carousel` | yes | Type of media: image, video, or carousel |
| `mediaUrl` | string | yes | Primary media URL (image URL or video ID) |
| `mediaUrls` | string[] | no | Multiple image URLs for carousel pins |
| `coverImageUrl` | string | no | Cover image URL for video pins |
| `altText` | string | no | Alt text for accessibility |
| `hashtags` | string[] | no | Hashtags to append to description |

### `pinterestBoard`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `create`, `list`, `listPins`, `delete` | yes | Board action to perform |
| `name` | string | no | Board name (required for `create`) |
| `description` | string | no | Board description |
| `privacy` | string: `PUBLIC`, `PROTECTED`, `SECRET` | no | Board privacy setting |
| `boardId` | string | no | Board ID (required for `listPins`, `delete`) |
| `maxResults` | number | no | Max results to return |

### `pinterestSearch`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Search query |
| `type` | string: `pins`, `boards` | no | Search type: pins or boards (default: `pins`) |
| `maxResults` | number | no | Max results to return (default: `10`, max: `100`) |

### `pinterestTrending`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `region` | string | no | Region code, e.g. `US`, `GB`, `DE` (default: `US`) |
| `maxResults` | number | no | Max results to return (default: `20`, max: `50`) |

### `pinterestAnalytics`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | string | yes | Pin ID or Board ID |
| `type` | string: `pin`, `board` | yes | Whether to fetch analytics for a pin or board |
| `startDate` | string | yes | Start date (`YYYY-MM-DD`) |
| `endDate` | string | yes | End date (`YYYY-MM-DD`) |

### `pinterestSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `boardId` | string | yes | Board ID to pin to |
| `title` | string | no | Pin title |
| `description` | string | no | Pin description |
| `link` | string | no | Destination URL |
| `mediaUrl` | string | yes | Image URL for the pin |
| `altText` | string | no | Alt text for accessibility |
| `hashtags` | string[] | no | Hashtags to append to description |
| `publishAt` | string | yes | ISO 8601 datetime for scheduled publish time |

## Channel adapter

The adapter registers platform `pinterest`. Activation initializes an authenticated HTTP client. Sending creates a pin on the board identified by `conversationId`, falling back to `defaultBoardId`. It selects carousel, image or video content, uses text as the description and reads `link` and `hashtags` from `platformOptions`. It has no inbound event delivery implementation. Typing indicators do nothing.

## Notes

Pin creation publishes content; board creation and deletion change the account's boards. `pinterestSchedule` validates that `publishAt` is a valid future date, then creates the pin immediately. Deferred publishing needs an external job scheduler.

Missing `accessToken` makes pack creation throw. Adapter sends require a board and image, video or carousel media. Video media uses an existing video ID. Hashtags are appended to the description. Board privacy defaults to `PUBLIC`.

HTTP requests time out after `30000` ms. Board listing requests `25` entries; board pin listing defaults to `25` and caps at `100`. Search caps results at `100`; trends cap at `50`.

## License

Apache-2.0
