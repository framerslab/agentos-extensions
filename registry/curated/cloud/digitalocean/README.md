# DigitalOcean cloud

This pack gives agents tools to create App Platform apps and Droplets, trigger deployments, list or delete resources, and manage domains and DNS records. It uses the DigitalOcean REST API with bearer-token authentication.

## Installation

```bash
npm install @framers/agentos-ext-cloud-digitalocean
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-cloud-digitalocean',
        options: {
          token: process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `digitalocean.token` | `DIGITALOCEAN_TOKEN`, then `DO_API_TOKEN` | Yes | Empty string |
| `secrets` | | | No | `context.secrets`, then `{}` |

Explicit options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `doCreateApp` | Creates an App Platform service or static site from a Git repository. |
| `doCreateDroplet` | Creates a Droplet with a specified region, size, OS image, and optional setup fields. |
| `doListResources` | Lists apps, Droplets, or both, with an optional Droplet tag filter. |
| `doDeployApp` | Triggers a deployment on an existing app with an optional full rebuild. |
| `doManageDns` | Lists or adds domains and creates, reads, updates, or deletes DNS records. |
| `doDeleteResource` | Permanently deletes an App Platform app or Droplet. |

### `doCreateApp`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | App name using lowercase alphanumeric characters and hyphens. |
| `gitUrl` | string | Yes | Git repository clone URL. |
| `branch` | string | No | Git branch to deploy, default `main`. |
| `region` | string | No | Region slug, default `nyc`. |
| `buildCommand` | string | No | Build command override. |
| `runCommand` | string | No | Run command for services. |
| `outputDir` | string | No | Output directory for static sites. |
| `isStatic` | boolean | No | Deploy as a static site, default `false`, which deploys a service. |
| `envVars` | object | No | Environment variables as key-value pairs. |
| `instanceSizeSlug` | string | No | Instance size slug. |

### `doCreateDroplet`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Droplet hostname. |
| `region` | string | Yes | Region slug. |
| `size` | string | Yes | Size slug. |
| `image` | string | Yes | Image slug or ID. |
| `sshKeys` | (string or number)[] | No | SSH key IDs or fingerprints to embed in the Droplet. |
| `userData` | string | No | Cloud-init user data script for automated setup. |
| `backups` | boolean | No | Enable weekly backups, default `false`. |
| `ipv6` | boolean | No | Enable IPv6 networking, default `false`. |
| `tags` | string[] | No | Tags for organization and filtering. |

### `doListResources`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `resourceType` | string: `apps`, `droplets`, `all` | No | Resource type to list, default `all`. |
| `page` | number | No | Page number, default 1. |
| `perPage` | number | No | Items per page, default 20, schema description maximum 200. |
| `tag` | string | No | Filter Droplets by tag name. |

### `doDeployApp`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appId` | string | Yes | App ID to deploy, available from `doListResources`. |
| `forceBuild` | boolean | No | Force a complete rebuild instead of an incremental build, default `false`. |

### `doManageDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string: `list-domains`, `add-domain`, `list`, `add`, `update`, `delete` | Yes | Action to perform on DNS. |
| `domain` | string | No | Domain name, required except for `list-domains`. |
| `recordId` | number | No | Record ID, required for update and delete. |
| `recordType` | string | No | DNS record type, such as `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV`, `NS`, or `CAA`. |
| `name` | string | No | Record name or hostname. |
| `data` | string | No | Record data or value, such as an IP address, CNAME target, or MX server. |
| `ttl` | number | No | Time-to-live in seconds, schema description default 1800. |
| `priority` | number | No | Priority for MX and SRV records. |
| `port` | number | No | Port for SRV records. |
| `weight` | number | No | Weight for SRV records. |

### `doDeleteResource`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `resourceType` | string: `app`, `droplet` | Yes | Resource type to delete. |
| `resourceId` | string | Yes | App UUID or numeric Droplet ID to delete. |

## Notes

Activation fails when the token is missing and validates supplied tokens by fetching account information.

App and Droplet creation provision remote resources. Service apps use the fixed environment slug `node-js` and default size `basic-xxs`. Static sites default `outputDir` to `build`. App variables use type `GENERAL` with scope `RUN_AND_BUILD_TIME`.

Deployment triggers a remote build and returns its phase without waiting for completion. Resource deletion is permanent and destroys associated data according to the deletion tool's description. A Droplet ID that cannot be parsed as a number returns an error.

DNS actions add domains and add, update, or delete records. All actions except `list-domains` require `domain`; adding a record also requires `recordType`, `name`, and `data`; updating or deleting requires `recordId`. The request code omits `ttl` when it is absent; the response mapping uses the schema description's default when the response omits it.

Resource listing fetches the requested page and does not enforce the schema description's `perPage` maximum. Domain and record listing do not follow pagination.

## License

Apache-2.0
