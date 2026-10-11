# Notifications

This pack gives an agent tools to send, broadcast, and schedule notifications through the pack's `NotificationService`. Delivery uses registered channel callbacks.

## Installation

```bash
npm install @framers/agentos-ext-notifications
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-notifications' }],
  },
});
```

## Tools

| Tool | What it does |
| --- | --- |
| `notifySend` | Sends a notification through a specified channel or the highest-priority available channel. |
| `notifyBroadcast` | Broadcasts a notification to all registered channels or a specified subset. |
| `notifySchedule` | Schedules, cancels, or lists pending notifications. |

### `notifySend`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `channel` | `string` | No | Target channel id. If omitted, the highest-priority channel is used. |
| `message` | `string` | Yes | Notification body text. |
| `subject` | `string` | No | Optional subject or title for the notification. |
| `metadata` | `object` | No | Arbitrary metadata forwarded to the channel. |

### `notifyBroadcast`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `message` | `string` | Yes | Notification body text. |
| `subject` | `string` | No | Optional subject or title for the notification. |
| `channels` | `array` of `string` | No | Subset of channel ids to target. If omitted, all registered channels are used. |
| `metadata` | `object` | No | Arbitrary metadata forwarded to every channel. |

### `notifySchedule`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | `string`, enum: `schedule`, `cancel`, `list` | Yes | Action to perform: "schedule" to create, "cancel" to remove, or "list" to view pending notifications. |
| `channel` | `string` | No | Target channel id (used with "schedule" action). |
| `message` | `string` | No | Notification body text (required for "schedule" action). |
| `subject` | `string` | No | Optional subject or title (used with "schedule" action). |
| `sendAt` | `string` | No | ISO 8601 timestamp for when to send (required for "schedule" action). |
| `scheduleId` | `string` | No | Schedule id to cancel (required for "cancel" action). |

## Notes

- The factory reads no options, secrets, or environment variables. It creates a service with an empty channel registry and does not expose that service in the returned pack.
- The exported `NotificationService` supports `registerChannel`, `unregisterChannel`, and `listChannels`. A channel supplies `id`, `name`, `priority`, and a `sendFn` callback. The exported tool classes accept a service instance in their constructors.
- Sending invokes the channel's `sendFn` with the message, subject, and metadata. A missing channel makes `notifySend` return `success: false`. With no registered channels, sending fails with "No notification channels registered".
- Broadcast sends to channels sequentially, skips unknown ids in a requested subset, and fails if no target channels remain.
- Channel callback failures appear as `delivered: false` with an error in the returned data. The send and broadcast tools still return `success: true` when the service returns those delivery results.
- Scheduling stores notifications in memory and uses `setTimeout`. A past `sendAt` triggers delivery without waiting. Deactivation cancels and clears pending notifications.
- The schedule action checks for `message` and `sendAt`; the cancel action checks for `scheduleId`. These fields remain optional in the input schema.
- Scheduled delivery failures are swallowed, and the pending entry is removed after the delivery attempt.

## License

Apache-2.0
