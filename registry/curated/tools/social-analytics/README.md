# Social analytics

This pack gives an agent a tool that aggregates engagement metrics from social platforms. It calls platform analytics tools through a tool executor callback and combines their results into per-platform data and totals.

## Installation

```bash
npm install @framers/agentos-ext-tool-social-analytics
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-tool-social-analytics';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  logger: console,
}));
```

## Tools

| Tool | What it does |
| --- | --- |
| `crossPlatformAnalytics` | Aggregates likes, comments, shares, impressions and engagement metrics across social platforms. |

### `crossPlatformAnalytics` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `platforms` | `array<string>` | Yes | Platforms to query analytics from |
| `postIds` | `object<string, string>` | No | Platform-to-`postId` mapping (e.g., `{ twitter: "123", linkedin: "456" }`) |
| `timeRange` | `string`, enum: `24h`, `7d`, `30d`, `90d` | No | Time range for analytics (default: `7d`) |

## Notes

The factory does not attach a tool executor. The host attaches one through `CrossPlatformAnalyticsTool.setToolExecutor` on the tool payload and supplies tools named `<platform>Analytics`. Each query passes the platform's `postId` and `timeRange` to its analytics tool.

Although `postIds` is optional in the schema, a platform without a post ID returns an error instead of metrics. A platform with a post ID but no executor returns a missing executor error. Platform errors appear in the returned platform data, and the overall tool result remains successful even when every platform fails.

The tool is marked as having no side effects and queries platforms sequentially. It normalizes alternate metric fields such as `favouritesCount`, `repliesCount`, `retweets`, `reblogsCount`, `reposts` and `views` for the totals. Overall engagement is the sum of likes, comments and shares divided by impressions, expressed as a percentage.

## License

Apache-2.0
