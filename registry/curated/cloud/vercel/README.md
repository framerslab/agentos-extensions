# Vercel cloud

This pack gives an agent tools to deploy projects from Git repositories, list projects, check deployment status, manage custom domains, and set or list environment variables through the Vercel REST API.

## Installation

```bash
npm install @framers/agentos-ext-cloud-vercel
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-cloud-vercel',
        options: {
          token: process.env.VERCEL_TOKEN,
          teamId: process.env.VERCEL_TEAM_ID,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `vercel.token` | `VERCEL_TOKEN` | Yes | Empty string |
| `teamId` | `vercel.teamId` | `VERCEL_TEAM_ID` | No | `undefined`, personal account scope |
| `secrets` | `vercel.token`, `vercel.teamId` | None | No | Context `secrets`, then an empty object |

Credentials resolve from the corresponding option, the selected secret map, then the environment variable. `options.secrets` takes precedence over context `secrets`. A supplied `teamId` is appended to API requests as a query parameter.

## Tools

| Tool | What it does |
| --- | --- |
| `vercelDeploy` | Deploys a project from a Git repository URL and creates the project if it does not exist. |
| `vercelListProjects` | Lists account projects with framework, linked Git repository, and latest deployment status. |
| `vercelGetDeployment` | Checks deployment state, URL, and inspector link by deployment ID. |
| `vercelConfigureDomain` | Adds, removes, or lists project domains and checks DNS configuration. |
| `vercelSetEnvVars` | Sets or lists project environment variables for production, preview, and development targets. |

### `vercelDeploy`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `gitUrl` | string | Yes | Git repository URL. |
| `projectName` | string | No | Vercel project name, derived from the repository name if omitted. |
| `framework` | string | No | Framework preset, such as `nextjs`, `vite`, or `gatsby`; auto-detected if omitted. |
| `buildCommand` | string | No | Build command override. |
| `outputDirectory` | string | No | Output directory override, such as `dist`, `.next`, or `build`. |
| `envVars` | object | No | Project environment variables as key-value pairs. |
| `target` | string | No | Deployment target: `production` or `preview`; schema default: `production`. |

### `vercelListProjects`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | No | Maximum number of projects to return. |

### `vercelGetDeployment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `deploymentId` | string | Yes | Deployment ID or URL to check. |

### `vercelConfigureDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | Vercel project ID or name. |
| `domain` | string | Yes | Custom domain, such as `example.com` or `www.example.com`. |
| `action` | string | No | `add`, `remove`, `list`, or `check`; default: `add`. |
| `gitBranch` | string | No | Git branch to link the domain to. |

### `vercelSetEnvVars`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | Vercel project ID or name. |
| `vars` | object | No | Key-value pairs of environment variables to set. |
| `action` | string | No | `set` or `list`; default: `set`. |
| `target` | array of string | No | Variable targets: `production`, `preview`, and `development`; defaults to all listed targets. |

## Notes

Activation requires a Vercel API token. It fails if the token is missing or the user-info authentication request fails.

The Git URL parser accepts GitHub, GitLab, and Bitbucket URLs. Deployment reuses a project found by name or attempts to create it when lookup fails. Repository, framework, and build settings are passed when creating a project. Deployment returns its state without waiting for completion; use `vercelGetDeployment` to check it.

The `vercelDeploy` schema exposes `target`, but execution does not forward it. This tool triggers a production deployment even when `preview` is supplied.

Deployment, project creation, domain addition or removal, and environment variable writes modify remote resources. Domain configuration returns DNS instructions without writing DNS records. After adding a domain, failure to fetch its DNS configuration is ignored.

Setting environment variables requires a nonempty `vars` object. Writes use `encrypted` as the variable type and try to patch an existing variable when the API returns `ENV_ALREADY_EXISTS` with a variable ID. Listing returns the API value or `(encrypted)` if no value is provided.

Domain removal does not check the HTTP response status. Environment variable writes do not throw for unhandled HTTP errors or failed patch responses, so a successful tool result does not confirm those changes took effect.

## License

Apache-2.0
