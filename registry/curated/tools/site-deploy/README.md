# Site deploy

This pack gives an agent one tool, `siteDeploy`, that plans a deployment to Vercel, Cloudflare Pages, DigitalOcean, Netlify, Heroku, AWS, Linode, Railway or Fly.io, with optional domain registration and DNS setup, and carries it out by calling other tools through a tool executor the host attaches.

## Installation

```bash
npm install @framers/agentos-ext-tool-site-deploy
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-tool-site-deploy' }],
  },
});
```

## Tools

| Tool | What it does |
| --- | --- |
| `siteDeploy` | Deploys a site from a Git repository or local directory with optional custom domain registration and DNS configuration. |

### `siteDeploy` parameters

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `source` | `string` | Yes | Git repository URL, source tarball URL or local directory path (see the table below for what each provider takes) |
| `cloudProvider` | `string`, enum: `vercel`, `cloudflare`, `digitalocean`, `netlify`, `heroku`, `aws`, `linode`, `railway`, `flyio` | No | Cloud provider to deploy to (default: auto-detect best fit) |
| `projectName` | `string` | No | Project, site or app name on the provider, derived from the source when omitted. Required for Heroku (the existing app) and for a local directory on AWS (the S3 bucket). |
| `domain` | `string` | No | Custom domain to configure (optional). If not registered, will attempt to register via `domainRegistrar`. |
| `domainRegistrar` | `string`, enum: `porkbun`, `namecheap`, `godaddy`, `cloudflare` | No | Domain registrar to use for domain purchase (required if domain is not already registered) |
| `registrant` | `object` | No | Registrant contact for a new registration: `firstName`, `lastName`, `email`, `phone`, `address1`, `city`, `state`, `postalCode`, `country`, and optionally `address2` and `organization`. Required to register at Namecheap or GoDaddy. |
| `framework` | `string`, enum: `nextjs`, `react`, `vue`, `svelte`, `astro`, `static`, `node`, `python`, `auto` | No | Framework/runtime (default: auto-detect) |
| `envVars` | `object<string, string>` | No | Environment variables to set on the deployment |
| `buildCommand` | `string` | No | Build command override |
| `outputDirectory` | `string` | No | Output directory override |
| `dryRun` | `boolean` | No | Preview the deployment plan without executing (default: false) |

## Notes

The factory does not attach a tool executor. The host attaches one through `SiteDeployTool.setToolExecutor` on the tool payload and supplies the provider and registrar tools. Deployment fails with a missing executor error if no callback is attached. `dryRun` returns a plan without calling delegated tools.

Framework detection examines the source URL or path string. It falls back to `static` when no pattern matches. A Nuxt source is detected as `node`, since Nuxt builds a server by default. Automatic provider selection uses Vercel for Next.js, React, Vue and Svelte, Cloudflare for Astro and static sites, and Railway for Node and Python.

For the deployment, `siteDeploy` calls the deploy tool the curated cloud pack registers, with that tool's own arguments:

| Provider | Tool | Source it takes | Arguments sent |
| --- | --- | --- | --- |
| `vercel` | `vercelDeploy` | Git URL | `gitUrl`, `projectName`, `framework` (`nextjs` and `astro` only; Vercel detects the rest), `buildCommand`, `outputDirectory`, `envVars` |
| `cloudflare` | `cfDeployPages` | Git URL | `gitUrl`, `projectName`, `buildCommand`, `buildOutputDirectory`, `envVars` |
| `digitalocean` | `doCreateApp` | Git URL | `name` (`projectName` or derived from the source), `gitUrl`, `isStatic`, `buildCommand`, `outputDir`, `envVars` |
| `netlify` | `netlifyDeploySite` | Git URL | `gitUrl`, `siteName`, `buildCommand`, `publishDirectory`, `envVars` |
| `heroku` | `herokuDeployApp` | Source archive URL: a `.tar.gz` file, GitHub's `/tarball/<ref>` URL or a signed URL from Heroku's sources endpoint; a Git repository URL is refused | `appName` (`projectName`, required), `sourceUrl`, `configVars` |
| `aws` | none for a Git URL | | Refused: Amplify's CreateApp needs a repository access token, which `siteDeploy` does not take; call `awsDeployAmplify` with `oauthToken` |
| `aws` | `awsDeployS3Site` | Local directory of built static files | `bucketName` (`projectName`, required), `sourceDir` (the source joined with `outputDirectory`; `outputDirectory` is required unless `framework` is `static`). A directory holding `.git`, `.env` or `.env.*` is refused, since the bucket is public |
| `railway` | `railwayDeployService` | GitHub URL | `repo` (`owner/repo`), `projectName`, `variables` |
| `linode` | none | | Refused: `linodeDeployStackScript` needs a StackScript id, region, plan, image and root password |
| `flyio` | none | | Refused: `flyDeployApp` runs a Docker image |

A source the provider's tool cannot take, a missing required `projectName`, or an option that tool does not accept (`buildCommand` on Heroku or Railway, for example) is refused before any tool is called, with the reason in `error`. A dry run reports the same refusal and otherwise shows the tool and its arguments, with environment values replaced by their names.

For the domain, `siteDeploy` calls the registrar pack's tools:

| Registrar | Search | Register (when the domain is available) | DNS |
| --- | --- | --- | --- |
| `porkbun` | `porkbunSearchDomain` with `domain` | `porkbunRegisterDomain` with `domain`, `years: 1` and the `registrant` fields when given (Porkbun uses the account's contact otherwise) | `porkbunConfigureDns` adds the apex record with an empty `name` |
| `namecheap` | `namecheapSearchDomain` with `domains` | `namecheapRegisterDomain` with `domainName`, `years: 1` and `registrant` | `namecheapGetDnsRecords`, then `namecheapConfigureDns` with the current records plus the apex record |
| `godaddy` | `godaddySearchDomain` with `domain` | `godaddyRegisterDomain` with `domain`, `period: 1` and `contactRegistrant` | `godaddyConfigureDns` adds `records: [{ type, name: '@', data }]` |
| `cloudflare` | `cfRegGetDomainInfo` with `domain` | none: Cloudflare's registrar takes transfers only | `cfRegConfigureDns` adds the record named by the full domain |

The DNS record is a CNAME to the deployment's hostname. When the provider returns none (Railway and Heroku do not on creation), no record is written and `domainStatus` is `pending_dns`, except on Vercel and Netlify, where the record points at their shared targets `cname.vercel-dns.com` and `apex-loadbalancer.netlify.com`.

`namecheapConfigureDns` replaces every host record of the domain, so when the current records cannot be read the DNS step is not attempted and `domainStatus` is `pending_dns`. The same happens when the domain already has an apex MX, TXT or A record, which an apex CNAME would break (a CNAME shares its name with no other record, [RFC 1034 section 3.6.2](https://www.rfc-editor.org/rfc/rfc1034#section-3.6.2)). An available domain at Namecheap or GoDaddy without a complete `registrant` is not registered, and `domainStatus` is `registration_failed`. Without a registrar, domain setup returns manual DNS instructions.

A deployment failure stops domain setup. A returned domain registration or DNS failure appears in `domainStatus` and the step results while a successful deployment keeps the overall result successful.

## License

Apache-2.0
