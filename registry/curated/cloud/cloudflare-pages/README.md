# Cloudflare Pages and Workers

This pack gives agents tools to deploy Pages projects from Git repositories, list projects, manage DNS records, and upload Worker scripts. It uses the Cloudflare REST API with bearer-token authentication.

## Installation

```bash
npm install @framers/agentos-ext-cloud-cloudflare-pages
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-cloud-cloudflare-pages',
        options: {
          apiToken: process.env.CLOUDFLARE_API_TOKEN,
          accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiToken` | `cloudflare.apiToken` | `CLOUDFLARE_API_TOKEN` | Yes | Empty string |
| `accountId` | `cloudflare.accountId` | `CLOUDFLARE_ACCOUNT_ID` | Yes | Empty string |
| `secrets` | | | No | `context.secrets`, then `{}` |

Explicit options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `cfDeployPages` | Deploys a Pages project from a Git repository, creating the project if needed. |
| `cfListProjects` | Lists Pages projects with their repository, branch, subdomain, and latest deployment status. |
| `cfConfigureDns` | Adds, removes, lists, or updates DNS records after looking up the zone by domain. |
| `cfCreateWorker` | Deploys a Worker script with route patterns, a compatibility date, and environment bindings. |

### `cfDeployPages`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `gitUrl` | string | Yes | Git repository URL. |
| `projectName` | string | No | Pages project name, auto-generated from the repository name if omitted. |
| `productionBranch` | string | No | Production branch name, default `main`. |
| `buildCommand` | string | No | Build command override. |
| `buildOutputDirectory` | string | No | Build output directory. |
| `envVars` | object | No | Environment variables to set on the project as key-value pairs. |

### `cfListProjects`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | No | Maximum projects to return, default 25, schema description maximum 100. |

### `cfConfigureDns`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `domain` | string | Yes | Root domain for the Cloudflare zone. |
| `action` | string: `add`, `remove`, `list`, `update` | No | Action to perform, default `list`. |
| `recordType` | string: `A`, `AAAA`, `CNAME`, `TXT`, `MX` | No | DNS record type, described as required for add and update. |
| `name` | string | No | Record name or hostname. |
| `content` | string | No | IP address, hostname, or text content. |
| `ttl` | number | No | TTL in seconds, default 1, which selects automatic TTL. |
| `proxied` | boolean | No | Whether to proxy through Cloudflare, default `false`. |
| `priority` | number | No | Priority for MX records. |
| `comment` | string | No | Optional comment for the record. |
| `recordId` | string | No | Record ID, required for update and remove. |

### `cfCreateWorker`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Worker script name used as its identifier. |
| `script` | string | Yes | JavaScript or TypeScript source in ES modules format with a default export. |
| `routes` | string[] | No | Route patterns to bind the Worker to. |
| `compatibilityDate` | string | No | Runtime compatibility date, default `2024-01-01`. |
| `bindings` | object | No | Environment variable bindings as key-value pairs. |

## Notes

Activation fails if the API token or account ID is missing. It verifies the token through the Cloudflare token verification endpoint.

Pages deployment creates projects, sets production environment variables, and triggers a remote build without waiting for completion. The tool ignores `projectName` and derives the name from `gitUrl`. The URL parser accepts GitHub, GitLab, and Bitbucket hosts, but project creation always sends the source type `github`. Build settings are sent when creating a project.

Project environment variables and Worker bindings use `plain_text`. Worker source is uploaded as `worker.js` with a JavaScript module content type; the service does not transpile TypeScript. Worker route setup errors are ignored.

DNS add, update, and remove actions change remote records. Adding requires `recordType`, `name`, and `content`; updating and removing require `recordId`. Updating allows partial fields, including omission of `recordType`. A domain with no matching zone returns an error.

Project listing forwards `limit` without enforcing the schema description's maximum. Project and DNS listing fetch a page without following pagination.

## License

Apache-2.0
