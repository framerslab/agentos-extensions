# Fly.io cloud

This pack gives agents tools to deploy Docker images, list apps and machines, scale machines, and create persistent volumes on Fly.io. It uses the Machines REST API and Fly.io GraphQL API with bearer-token authentication.

## Installation

```bash
npm install @framers/agentos-ext-cloud-flyio
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-cloud-flyio';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    token: process.env.FLY_API_TOKEN,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `fly.token` | `FLY_API_TOKEN` | Yes | Empty string |
| `secrets` | | | No | `context.secrets`, then `{}` |

Explicit options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `flyDeployApp` | Deploys a Docker image by creating a machine and creates the app if needed. |
| `flyListApps` | Lists apps or retrieves a named app, with optional machine details. |
| `flyScaleApp` | Creates, destroys, or resizes machines to reach a desired scale. |
| `flyCreateVolume` | Creates a persistent volume with encryption enabled by default. |

### `flyDeployApp`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | Fly app name. |
| `image` | string | Yes | Docker image to deploy. |
| `region` | string | No | Fly region code, described as defaulting to closest. |
| `cpus` | number | No | CPUs, default 1. |
| `cpuKind` | string: `shared`, `performance` | No | CPU type, default `shared`. |
| `memoryMb` | number | No | Memory in MB, default 256. |
| `env` | object | No | Environment variables as key-value pairs. |
| `internalPort` | number | No | Internal app port, default 8080. |
| `autoDestroy` | boolean | No | Destroy the machine when it exits, default `false`. |
| `createApp` | boolean | No | Create the app if it does not exist, default `true`. |
| `org` | string | No | Fly organization slug, default `personal`. |

### `flyListApps`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | No | Filter to a named app; omitting it lists apps. |
| `includeMachines` | boolean | No | Include machine details for each app, default `true`. |

### `flyScaleApp`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | App name to scale. |
| `count` | number | Yes | Desired machines, with zero described as stopping all. |
| `cpus` | number | No | CPUs per new or resized machine. |
| `cpuKind` | string: `shared`, `performance` | No | CPU type for new or resized machines. |
| `memoryMb` | number | No | Memory in MB per new or resized machine. |
| `region` | string | No | Region for new machines. |

### `flyCreateVolume`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | App in which to create the volume. |
| `name` | string | Yes | Volume name used in mount configuration. |
| `region` | string | Yes | Volume region, which must match the machine region. |
| `sizeGb` | number | Yes | Volume size in GB, described minimum 1. |
| `encrypted` | boolean | No | Encrypt the volume, default `true`. |

## Notes

Activation fails when the token is missing and validates supplied tokens through a GraphQL `currentUser` query. A response without a user ID fails activation.

Deployment creates remote apps and machines from an existing Docker image. It exposes HTTP and HTTPS, enables automatic start and stop, and redirects HTTP to HTTPS. An omitted `region` is left out of the request. With `createApp` set to `false`, a failed app lookup returns an error.

Scaling down stops and destroys excess machines, including all machines when `count` is zero. Scaling up clones the first existing machine's configuration; without an existing machine, it sends an empty image. Resizing sends a guest configuration update. The tool does not validate `count` as a nonnegative integer.

Volume creation provisions remote storage without attaching it to a machine. The described minimum size is not enforced locally.

When listing apps without `appName`, a machine lookup failure becomes an empty machine list for that app. A machine lookup failure for a named app returns an error.

## License

Apache-2.0
