# Postgres memory

This pack gives an agent a memory provider with Postgres configuration hooks and an in-process store. It registers an AgentOS `memory-provider` descriptor and stores records in JavaScript maps.

## Installation

This pack is private and is not published to npm.

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-postgres-memory' }],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `priority` | None | None | No | `40` |
| Provider initialization `connectionString`, then `postgresConnectionString` | `POSTGRES_CONNECTION_STRING` | `POSTGRES_CONNECTION_STRING`, then `DATABASE_URL` | No | `undefined` |

The factory reads the connection string through `getSecret('POSTGRES_CONNECTION_STRING')`, then the environment fallbacks. The provider's `initialize` method accepts `connectionString` or `postgresConnectionString` to override that value. These fields belong to provider initialization, not factory options. The descriptor marks the secret optional.

## Notes

The pack registers provider `postgres-memory` with descriptor id `wilds-postgres-memory`, enabled by default. It exposes `initialize`, `store`, `query`, `delete`, `getStats`, and `shutdown` through the provider payload. It registers no callable tools.

The provider supports `episodic`, `semantic`, `procedural`, `prospective`, and `relational` records. Unrecognized record types become `episodic`. Searchable content comes from a string value, a string `content` field, a string `input` field, or JSON serialization.

Queries accept a string or an object with `text` or `query`, optional `type`, and optional `limit`. They use case-insensitive substring matching and filter by type when supplied. The default `limit` is `10`; numeric limits use `Math.max(1, Math.min(100, limit))`. Records remain scoped to their collection.

`store` adds records with generated ids and timestamps. `delete` removes selected records. `shutdown` clears all collections. The implementation does not connect to Postgres, use pgvector, or persist records across process restarts. A missing connection string leaves the in-process store available.

## License

Apache-2.0
