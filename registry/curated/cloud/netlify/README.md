# Netlify cloud

This pack gives an agent tools to deploy sites from Git repositories, list sites, configure custom domains, and manage environment variables through the Netlify REST API.

## Installation

```bash
npm install @framers/agentos-ext-cloud-netlify
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-cloud-netlify';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: {
    token: process.env.NETLIFY_AUTH_TOKEN ?? process.env.NETLIFY_TOKEN,
  },
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `token` | `netlify.token` | `NETLIFY_AUTH_TOKEN`, then `NETLIFY_TOKEN` | Yes | Empty string |
| `secrets` | `netlify.token` | None | No | Context `secrets`, then an empty object |

The token resolves from `options.token`, the selected secret map, then the environment variables. `options.secrets` takes precedence over context `secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `netlifyDeploySite` | Deploys a site from a Git repository URL and creates the site if it does not exist. |
| `netlifyListSites` | Lists account sites with names, URLs, Git repositories, custom domains, and deployment states. |
| `netlifyConfigureDomain` | Handles custom domain actions and returns DNS setup instructions. |
| `netlifySetEnvVars` | Sets or lists site environment variables with deploy context scoping. |

### `netlifyDeploySite`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `gitUrl` | string | Yes | Git repository URL. |
| `siteName` | string | No | Globally unique Netlify site name, derived from the repository name if omitted. |
| `buildCommand` | string | No | Build command. |
| `publishDirectory` | string | No | Publish directory, such as `dist`, `build`, `public`, or `.next`. |
| `branch` | string | No | Git branch to deploy from, default: `main`. |
| `envVars` | object | No | Site environment variables as key-value pairs. |

### `netlifyListSites`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | number | No | Maximum number of sites to return. |

### `netlifyConfigureDomain`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `siteId` | string | Yes | Netlify site ID or name. |
| `domain` | string | Yes | Custom domain, such as `example.com` or `www.example.com`. |
| `action` | string | No | `add`, `remove`, `list`, or `check`; default: `add`. |

### `netlifySetEnvVars`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `siteId` | string | Yes | Netlify site ID or name. |
| `vars` | object | No | Key-value pairs of environment variables to set. |
| `action` | string | No | `set` or `list`; default: `set`. |
| `context` | string | No | Deploy context: `all`, `dev`, `branch-deploy`, `deploy-preview`, or `production`; default: `all`. |

## Notes

Activation requires a Netlify personal access token. It fails if the token is missing or the current-user authentication request fails.

The Git URL parser accepts GitHub, GitLab, and Bitbucket URLs. Deployment reuses a site found by name or attempts to create it when lookup fails. Repository and build settings are passed when creating a site. The tool triggers a deployment and returns its state without waiting for completion.

Deployment, domain configuration, and environment variable writes modify remote resources. Domain setup returns DNS instructions; it does not create DNS records. The `check` action reads Netlify DNS zones and records.

The `remove` action passes an empty custom domain to the service, but the service omits empty values from its update request. The tool reports removal without sending a domain-clearing field.

Setting environment variables requires a nonempty `vars` object. With an account slug, variables use the account environment API and the selected context. Without an account slug, writes fall back to site build settings and omit context scoping. Listing returns values supplied by the API. The site mapper omits build environment values, so the build-settings listing fallback returns an empty array.

## License

Apache-2.0
