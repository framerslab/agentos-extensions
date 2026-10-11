# Railway cloud

This pack gives an agent tools to create or redeploy services, list projects and services, provision database plugins, and retrieve deployment or build logs through the Railway GraphQL API.

## Installation

```bash
npm install @framers/agentos-ext-cloud-railway
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-cloud-railway';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    token: process.env.RAILWAY_TOKEN,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `railway.token` | `RAILWAY_TOKEN` | Yes | Empty string |
| `secrets` | `railway.token` | None | No | Context `secrets`, then an empty object |

The token resolves from `options.token`, the selected secret map, then the environment variable. `options.secrets` takes precedence over context `secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `railwayDeployService` | Creates a service from a GitHub repository or redeploys an existing service with optional environment variables. |
| `railwayListServices` | Lists projects with their environments and services, optionally filtered by project ID. |
| `railwayAddDatabase` | Provisions a PostgreSQL, Redis, MySQL, or MongoDB database plugin in a project. |
| `railwayGetLogs` | Retrieves timestamped deployment or build log entries with severity levels. |

### `railwayDeployService`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | No | Project ID to deploy into; a new project is created if omitted and `projectName` is given. |
| `projectName` | string | No | Name for a new project, used only when `projectId` is omitted. |
| `repo` | string | No | GitHub repository, such as `user/repo`; described as required for new services. |
| `serviceName` | string | No | Name for the service. |
| `serviceId` | string | No | Existing service ID to redeploy and rebuild the latest commit. |
| `environmentId` | string | No | Environment ID for redeployment; the schema describes it as required with `serviceId` and defaulting to production. |
| `variables` | object | No | Environment variables as key-value pairs. |

### `railwayListServices`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | No | Filter to a project ID; lists all projects if omitted. |

### `railwayAddDatabase`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | Railway project ID to add the database to. |
| `plugin` | string | Yes | Database type: `postgresql`, `redis`, `mysql`, or `mongodb`. |

### `railwayGetLogs`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `deploymentId` | string | Yes | Deployment ID to retrieve logs for. |
| `type` | string | No | `deploy` for runtime logs or `build` for build logs; default: `deploy`. |

## Notes

Activation requires a Railway API token. It queries the current user and fails if the token is missing, the request fails, or no user ID is returned.

Service creation, project creation, redeployment, database provisioning, and variable updates modify remote resources.

Redeployment requires both `serviceId` and `environmentId` in execution. There is no production environment fallback for this path. Without both fields, the tool creates a service, even if `serviceId` is supplied. If `projectId` is absent, it creates a project using `projectName` or a generated timestamp-based name. The schema has no required fields, and execution permits creating a service without `repo`.

For a new service, variables are written after service creation to the first non-ephemeral project environment, or the first environment if none is non-ephemeral. If there is no environment, the variable write is skipped. For redeployment, variables are written before triggering the redeploy.

Redeployment fetches the latest deployment without waiting for completion. If none is returned, its ID is empty and its status is `unknown`. Log retrieval returns an array from a GraphQL query.

## License

Apache-2.0
