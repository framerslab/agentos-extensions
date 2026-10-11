# Bulk scheduler

This pack gives an agent a tool to validate and schedule batches of social posts, expand content templates and delegate scheduling to a supplied `schedulePost` tool executor.

## Installation

```bash
npm install @framers/agentos-ext-tool-bulk-scheduler
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-tool-bulk-scheduler';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  logger: console,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `logger` | None | None | No | None |

## Tools

| Tool | What it does |
| --- | --- |
| `bulkSchedule` | Schedules batches of social posts with template expansion, scheduling validation and per-post results. |

### `bulkSchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `posts` | `array` of `object` | Yes | Array of posts to schedule. |

Each object in `posts` has this schema:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `content` | `string` | Yes | Post content text. Supports template vars: `{{date}}`, `{{time}}`, `{{day}}`, `{{platform}}`. |
| `platforms` | `array` of `string` | Yes | Target platforms (e.g. `twitter`, `linkedin`, `instagram`). |
| `scheduledAt` | `string` | Yes | ISO scheduled time. |
| `mediaUrls` | `array` of `string` | No | Media URLs or asset IDs to attach. |
| `hashtags` | `array` of `string` | No | Hashtags to include with the post. |

## Notes

The factory creates a tool without an executor. In this mode, the tool validates and previews posts, marking valid posts as `scheduled` without sending them to a backend. An orchestrator supplies actual scheduling through the tool's `setToolExecutor` method. The executor receives `schedulePost` calls with the expanded content, platforms, scheduled time, media URLs and hashtags.

The tool expands `{{date}}`, `{{time}}`, `{{day}}`, `{{month}}`, `{{year}}` and `{{iso}}` from the scheduled date. Date and time use the runtime's locale; weekday and month names use English. `{{platform}}` remains unexpanded.

Accepted platform identifiers are `twitter`, `instagram`, `reddit`, `youtube`, `tiktok`, `pinterest`, `linkedin`, `facebook`, `threads`, `bluesky`, `mastodon`, `farcaster`, `lemmy`, `devto` and `medium`.

Empty batches fail. Invalid dates, missing platforms, unsupported platforms, empty content and executor failures produce per-post errors. Past scheduled dates are accepted. Posts are processed in input order, and the tool reports success when any post has a `scheduled` result.

## License

Apache-2.0
