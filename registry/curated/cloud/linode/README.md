# Linode cloud

This pack gives an agent tools to provision Linode instances, deploy StackScripts, manage DNS, delete instances, and create NodeBalancers through the Linode REST API.

## Installation

```bash
npm install @framers/agentos-ext-cloud-linode
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-cloud-linode';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    token: process.env.LINODE_TOKEN ?? process.env.LINODE_API_TOKEN,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `linode.token` | `LINODE_TOKEN`, then `LINODE_API_TOKEN` | Yes | Empty string |
| `baseUrl` | None | None | No | `https://api.linode.com/v4` |
| `secrets` | `linode.token` | None | No | Context `secrets`, then an empty object |

The token resolves from `options.token`, the selected secret map, then the environment variables. `options.secrets` takes precedence over context `secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `linodeCreateInstance` | Creates a Linode VPS instance with a region, plan, OS image, and optional SSH keys. |
| `linodeListInstances` | Lists account instances with status, IP addresses, specs, tags, and pagination. |
| `linodeDeployStackScript` | Deploys a new instance using a StackScript for automated setup on first boot. |
| `linodeManageDns` | Creates DNS zones and adds, lists, updates, or deletes DNS records. |
| `linodeDeleteInstance` | Permanently deletes an instance and its associated disks, IPs, and backups. |
| `linodeCreateNodeBalancer` | Creates a NodeBalancer with protocol, health checks, and backend nodes in the same region. |

### `linodeCreateInstance`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `region` | string | Yes | Region slug. |
| `plan` | string | Yes | Instance type or plan. |
| `image` | string | Yes | OS image ID. |
| `label` | string | No | Human-readable label for the instance. |
| `rootPass` | string | Yes | Root password with length and complexity requirements. |
| `tags` | array of string | No | Tags for organizing instances. |
| `authorizedKeys` | array of string | No | Authorized SSH public keys. |
| `backupsEnabled` | boolean | No | Enable automatic backups, default: `false`. |
| `privateIp` | boolean | No | Allocate a private IP address, default: `false`. |

### `linodeListInstances`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `page` | number | No | Page number for pagination. |
| `pageSize` | number | No | Number of results per page. |

### `linodeDeployStackScript`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `stackscriptId` | number | Yes | StackScript ID from Linode Cloud Manager or the API. |
| `region` | string | Yes | Region slug. |
| `plan` | string | Yes | Instance type or plan. |
| `image` | string | Yes | OS image compatible with the StackScript. |
| `rootPass` | string | Yes | Root password for the instance. |
| `stackscriptData` | object | No | StackScript user-defined fields as key-value pairs; check the StackScript for required fields. |
| `label` | string | No | Human-readable label for the instance. |
| `tags` | array of string | No | Tags for organizing instances. |
| `authorizedKeys` | array of string | No | Authorized SSH public keys. |
| `backupsEnabled` | boolean | No | Enable automatic backups, default: `false`. |
| `privateIp` | boolean | No | Allocate a private IP address, default: `false`. |

### `linodeManageDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `action` | string | Yes | DNS action: `createZone`, `listZones`, `addRecord`, `listRecords`, `updateRecord`, or `deleteRecord`. |
| `domain` | string | No | Domain name for `createZone`. |
| `soaEmail` | string | No | SOA email address, required for `createZone`. |
| `domainId` | number | No | Domain zone ID, required for record operations. |
| `recordId` | number | No | Record ID, required for `updateRecord` and `deleteRecord`. |
| `recordType` | string | No | DNS record type: `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `SRV`, `NS`, `CAA`, or `PTR`; required for `addRecord`. |
| `name` | string | No | Record name or hostname. |
| `target` | string | No | Record target or value, such as an IP address, hostname, or text value. |
| `priority` | number | No | MX or SRV priority; lower means higher priority. |
| `weight` | number | No | SRV weight. |
| `port` | number | No | SRV port. |
| `ttlSec` | number | No | TTL in seconds; zero uses the zone default. |
| `tag` | string | No | CAA tag, such as `issue`, `issuewild`, or `iodef`. |
| `tags` | array of string | No | Tags for the domain zone. |
| `description` | string | No | Description for the domain zone. |

### `linodeDeleteInstance`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `instanceId` | number | Yes | Numeric ID of the Linode instance to delete. |

### `linodeCreateNodeBalancer`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `region` | string | Yes | Region slug; must match the region of backend instances. |
| `label` | string | No | Human-readable label for the NodeBalancer. |
| `clientConnThrottle` | number | No | Maximum new TCP connections per second per client IP; zero means unlimited and is the schema default. |
| `tags` | array of string | No | Tags for organizing NodeBalancers. |
| `config` | object | No | Initial port, protocol, algorithm, health checks, and backend nodes. |
| `config.port` | number | No | Port to listen on. |
| `config.protocol` | string | No | `http`, `https`, or `tcp`; default: `http`. |
| `config.algorithm` | string | No | `roundrobin`, `leastconn`, or `source`; default: `roundrobin`. |
| `config.check` | string | No | Health check type: `none`, `connection`, `http`, or `http_body`. |
| `config.checkInterval` | number | No | Health check interval in seconds. |
| `config.checkTimeout` | number | No | Health check timeout in seconds. |
| `config.checkAttempts` | number | No | Number of failed checks before marking unhealthy. |
| `config.checkPath` | string | No | HTTP health check path. |
| `config.stickiness` | string | No | Session stickiness: `none`, `table`, or `http_cookie`. |
| `config.nodes` | array of object | No | Backend Linode instances in the same region. |
| `config.nodes[].address` | string | Yes, within each node | Backend address as private IP and port. |
| `config.nodes[].label` | string | Yes, within each node | Node label. |
| `config.nodes[].weight` | number | No | Load balancing weight. |
| `config.nodes[].mode` | string | No | Node mode: `accept`, `reject`, `drain`, or `backup`. |

## Notes

Activation fails if the token is missing. It validates authentication by fetching account information and fails if that request fails.

Instance creation, StackScript deployment, DNS changes, and NodeBalancer creation modify cloud resources. Instance deletion is irreversible and removes associated disks, IPs, and backups.

For `linodeManageDns`, the Required column follows the schema. Execution also requires `domain` and `soaEmail` for `createZone`; `domainId`, `recordType`, `name`, and `target` for `addRecord`; `domainId` for `listRecords`; and `domainId` with `recordId` for `updateRecord` and `deleteRecord`.

## License

Apache-2.0
