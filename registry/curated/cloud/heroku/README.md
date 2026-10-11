# Heroku cloud

This pack gives agents tools to create Heroku apps, deploy source tarballs, provision addons, retrieve recent logs, and scale dynos. It uses the Heroku Platform API with bearer-token authentication.

## Installation

```bash
npm install @framers/agentos-ext-cloud-heroku
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-cloud-heroku',
        options: {
          apiKey: process.env.HEROKU_API_KEY,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `apiKey` | `heroku.apiKey` | `HEROKU_API_KEY` | Yes | Empty string |
| `secrets` | | | No | `context.secrets`, then `{}` |

Explicit options take precedence over secrets, then environment variables. `options.secrets` takes precedence over `context.secrets`.

## Tools

| Tool | What it does |
| --- | --- |
| `herokuCreateApp` | Creates an app with an optional name, region, stack, and initial config variables. |
| `herokuDeployApp` | Deploys a source tarball URL and optionally updates config variables first. |
| `herokuAddAddon` | Provisions an addon from a plan identifier. |
| `herokuGetLogs` | Retrieves recent log output with optional dyno and source filters. |
| `herokuScaleDynos` | Adjusts dyno quantity and size for a process type. |

### `herokuCreateApp`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | No | App name, auto-generated if omitted; lowercase alphanumeric characters and hyphens only. |
| `region` | string: `us`, `eu` | No | Deployment region, schema description default `us`. |
| `stack` | string | No | Stack name, described as defaulting to latest. |
| `configVars` | object | No | Initial environment or config variables as key-value pairs. |

### `herokuDeployApp`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | App name to deploy to. |
| `sourceUrl` | string | Yes | URL of the source tarball, `.tar.gz`, to deploy. |
| `version` | string | No | Build version label, such as a Git SHA or semver tag. |
| `configVars` | object | No | Config variables to set before deployment as key-value pairs. |

### `herokuAddAddon`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | App to add the addon to. |
| `plan` | string | Yes | Addon plan identifier. |
| `addonName` | string | No | Custom name for the addon instance. |
| `config` | object | No | Addon-specific configuration as key-value pairs. |

### `herokuGetLogs`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | App to fetch logs from. |
| `lines` | number | No | Recent log lines to retrieve, default 100, schema description maximum 1500. |
| `dyno` | string | No | Filter to a specific dyno. |
| `source` | string | No | Log source, `app` for application or `heroku` for platform logs. |

### `herokuScaleDynos`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `appName` | string | Yes | App to scale. |
| `type` | string | Yes | Process type, such as `web`, `worker`, or `clock`. |
| `quantity` | number | Yes | Dynos to run for this process type, zero to stop. |
| `size` | string | No | Dyno size, such as `eco`, `basic`, `standard-1x`, `standard-2x`, `performance-m`, or `performance-l`. |

## Notes

Activation fails when the API key is missing and validates supplied keys by fetching account information.

Creating an app provisions a remote resource and sets nonempty `configVars` after creation. An omitted name, region, or stack is left out of the request; the region and stack defaults appear in schema descriptions rather than being assigned by the service.

Deployment requires an existing app and a URL for its source tarball. It updates nonempty `configVars` before submitting the remote build and returns the build status without waiting for completion.

Addon provisioning requests the selected plan and returns plan price metadata. Dyno scaling changes the remote formation. The scaling tool does not validate `quantity` as a nonnegative integer or restrict `size` to an enum.

Log retrieval creates a log session with `tail` set to `false`, fetches its URL, and returns the log text and `logplexUrl`. The tool does not enforce the schema description's `lines` maximum. A failed log fetch returns an error.

App deletion is available on the exported `HerokuService`, but the pack does not register an app-deletion tool.

## License

Apache-2.0
