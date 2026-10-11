# Site deploy

This pack gives an agent a deployment tool for Vercel, Cloudflare Pages, DigitalOcean, Netlify, Heroku, AWS, Linode, Railway and Fly.io, with optional domain registration and DNS setup. It delegates to cloud and registrar tools through a tool executor callback.

## Installation

```bash
npm install @framers/agentos-ext-tool-site-deploy
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-tool-site-deploy';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  logger: console,
}));
```

## Tools

| Tool | What it does |
| --- | --- |
| `siteDeploy` | Deploys a site from a Git repository or local directory with optional custom domain registration and DNS configuration. |

### `siteDeploy` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | `string` | Yes | Git repository URL or local directory path |
| `cloudProvider` | `string`, enum: `vercel`, `cloudflare`, `digitalocean`, `netlify`, `heroku`, `aws`, `linode`, `railway`, `flyio` | No | Cloud provider to deploy to (default: auto-detect best fit) |
| `domain` | `string` | No | Custom domain to configure (optional). If not registered, will attempt to register via `domainRegistrar`. |
| `domainRegistrar` | `string`, enum: `porkbun`, `namecheap`, `godaddy`, `cloudflare` | No | Domain registrar to use for domain purchase (required if domain is not already registered) |
| `framework` | `string`, enum: `nextjs`, `react`, `vue`, `svelte`, `astro`, `static`, `node`, `python`, `auto` | No | Framework/runtime (default: auto-detect) |
| `envVars` | `object<string, string>` | No | Environment variables to set on the deployment |
| `buildCommand` | `string` | No | Build command override |
| `outputDirectory` | `string` | No | Output directory override |
| `dryRun` | `boolean` | No | Preview the deployment plan without executing (default: false) |

## Notes

The factory does not attach a tool executor. The host attaches one through `SiteDeployTool.setToolExecutor` on the tool payload and supplies the provider and registrar tools. Deployment fails with a missing executor error if no callback is attached. `dryRun` returns a plan without calling delegated tools.

Framework detection examines the source URL or path string. It falls back to `static` when no pattern matches. Automatic provider selection uses Vercel for Next.js, React, Vue and Svelte, Cloudflare for Astro and static sites, and Railway for Node and Python.

Delegated calls can deploy a site, purchase an available domain through Porkbun, Namecheap or GoDaddy, and add an apex CNAME record through the selected registrar. The Cloudflare registrar path skips domain registration and transfer. Without a registrar, domain setup returns manual DNS instructions.

A deployment failure stops domain setup. A returned domain registration or DNS failure appears in `domainStatus` and the step results while a successful deployment keeps the overall result successful.

## License

Apache-2.0
