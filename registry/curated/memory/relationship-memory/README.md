# Relationship memory

This pack gives an agent tools for querying relationship events, recording boundaries and anchor moments, and computing relationship scores. It uses an in-process JavaScript map and Node.js `randomUUID` for event ids.

## Installation

This pack is private and is not published to npm.

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-relationship-memory';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({ options: {} }));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `priority` | None | None | No | `50` |

## Tools

| Tool | What it does |
| --- | --- |
| `trust_ledger_query` | Queries trust and relationship events with derived relationship scores. |
| `record_boundary` | Records a trust, boundary, or anchor-moment event between an account and a companion. |
| `anchor_moment_recall` | Recalls shared anchor moments with optional tag or emotion filters. |
| `intimacy_score` | Computes a relationship summary using trust, intimacy, anchor, and violation signals. |

### `trust_ledger_query`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | `string` | Yes | Account UUID for the relationship owner. |
| `companionId` | `string` | Yes | Companion UUID for the relationship target. |
| `limit` | `integer` | No | Maximum events to return. |
| `includeBoundaryEvents` | `boolean` | No | When false, hides `boundary_*` events and returns trust/anchor events only. |

### `record_boundary`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | `string` | Yes | Account UUID for the relationship owner. |
| `companionId` | `string` | Yes | Companion UUID for the relationship target. |
| `eventType` | `string`, enum: `trust_event`, `boundary_asserted`, `boundary_violated`, `boundary_negotiated`, `anchor_moment` | Yes | Type of relationship event being recorded. |
| `description` | `string` | Yes | Human-readable description of the event. |
| `trustDelta` | `number` | No | Trust score adjustment for this event. |
| `intimacyDelta` | `number` | No | Intimacy score adjustment for this event. |
| `emotionalValence` | `number` | No | Emotional valence of the event from negative to positive. |
| `tags` | `array` of `string` | No | Optional tags for later filtering and anchor recall. |

### `anchor_moment_recall`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | `string` | Yes | Account UUID for the relationship owner. |
| `companionId` | `string` | Yes | Companion UUID for the relationship target. |
| `limit` | `integer` | No | Maximum anchor moments to return. |
| `tag` | `string` | No | Optional tag filter. |
| `minValence` | `number` | No | Optional minimum emotional valence. |

### `intimacy_score`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | `string` | Yes | Account UUID for the relationship owner. |
| `companionId` | `string` | Yes | Companion UUID for the relationship target. |

## Notes

`record_boundary` appends events to a module-level map shared by pack instances in the process. Events do not persist across process restarts. The other tools read this map. Tool descriptors are enabled by default and declare `capability:memory`.

Missing or empty `accountId` or `companionId` causes execution to throw. Execution checks that these ids are non-empty strings but does not validate UUID formatting.

Ledger queries and anchor recall return the latest matching events first. `includeBoundaryEvents` defaults to `true`; the ledger summary still uses all relationship events when boundary events are hidden. Recording defaults omitted score deltas and emotional valence to zero and filters tags to strings.

Ledger `limit` defaults to `20` and is clamped between `1` and `100`. Anchor recall `limit` defaults to `10` and is clamped between `1` and `50`. The schemas bound `emotionalValence` and `minValence` between `-1` and `1`; recording also clamps `emotionalValence` to that range.

Summaries return `trustScore`, `intimacyScore`, `affectionScore`, `eventCount`, `anchorMoments`, and `boundaryViolations`. The scores use fixed arithmetic over recorded deltas, anchor moments, and boundary violations, with clamping.

## License

Apache-2.0
