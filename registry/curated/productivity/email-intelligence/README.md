# Email Intelligence

This pack gives an agent email thread search, project organization, attachment metadata, reports, digest previews and sync status through a backend REST API.

## Installation

This pack is private and is not published to npm.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-email-intelligence';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  seedId: process.env.WUNDERLAND_SEED_ID,
  backendUrl: process.env.WUNDERLAND_BACKEND_URL,
  secrets: {
    'internal.apiSecret': process.env.INTERNAL_API_SECRET ?? '',
  },
}));
```

The factory reads these settings directly from its argument.

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `seedId` | | `WUNDERLAND_SEED_ID` | No | Empty string |
| `backendUrl` | | `WUNDERLAND_BACKEND_URL` | No | `http://localhost:3000` |
| `secrets['internal.apiSecret']` | `internal.apiSecret` | `INTERNAL_API_SECRET` | Yes, in the manifest | Empty string |
| `secrets` | | | No | No map |

Explicit settings precede environment fallbacks. Requests target `/wunderland/email-intelligence/` under `backendUrl` and include `X-Internal-Secret`, `X-Seed-Id` and the `seedId` query parameter.

## Tools

| Tool | What it does |
| --- | --- |
| `searchAcrossThreads` | Searches email threads using natural language with account, project and date filters. |
| `getThreadHierarchy` | Retrieves a thread's message hierarchy, replies and forwarded messages. |
| `listProjects` | Lists email projects with an optional status filter. |
| `getProjectSummary` | Gets an AI-generated project summary with participants, topics and action items. |
| `getProjectTimeline` | Retrieves a chronological timeline of project events and milestones. |
| `listAccounts` | Lists connected email accounts with sync status and message counts. |
| `getAttachment` | Retrieves attachment metadata and download information. |
| `createProject` | Creates a project and optionally assigns initial threads. |
| `addThreadToProject` | Adds a thread to an existing project. |
| `generateReport` | Generates a project report with thread summaries, participants, action items and timeline. |
| `getDigestPreview` | Previews a digest's rendered content and recipients. |
| `syncStatus` | Checks sync status for a selected account or all accounts. |

### `searchAcrossThreads`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Natural language search query |
| `maxResults` | number | No | Maximum results to return (default: 20) |
| `accountId` | string | No | Filter by email account ID |
| `projectId` | string | No | Filter by project ID |
| `dateFrom` | string | No | Start date filter (ISO 8601) |
| `dateTo` | string | No | End date filter (ISO 8601) |

### `getThreadHierarchy`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `threadId` | string | Yes | The thread ID to retrieve |

### `listProjects`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `status` | string | No | Filter by project status (active, archived, all) |
| `limit` | number | No | Maximum number of projects to return |

### `getProjectSummary`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | The project ID to summarize |

### `getProjectTimeline`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | The project ID |
| `granularity` | string | No | Timeline granularity: day, week, or month |

### `listAccounts`

The input schema has no parameters.

### `getAttachment`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `attachmentId` | string | Yes | The attachment ID to retrieve |

### `createProject`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Project name |
| `description` | string | No | Optional project description |
| `threadIds` | array of strings | No | Optional list of thread IDs to assign to the project |

### `addThreadToProject`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | The project ID to add the thread to |
| `threadId` | string | Yes | The thread ID to add |

### `generateReport`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `projectId` | string | Yes | The project ID to generate a report for |
| `format` | string | No | Report format: markdown, json, or html |

### `getDigestPreview`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `digestId` | string | Yes | The digest ID to preview |
| `format` | string | No | Preview format: html or text |

### `syncStatus`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `accountId` | string | No | Optional account ID to check. If omitted, returns all accounts. |

## Notes

The pack requires a backend serving the email intelligence routes. The factory does not reject missing credentials: absent `seedId` and secret values are sent as empty strings. HTTP failures return `success: false` and an `error` message through the tools.

`createProject` and `addThreadToProject` send changes to the backend. Report generation and digest previews also use POST requests. The preview tool requests preview content without calling a send endpoint.

The schemas declare defaults of `active` for project status, `50` for project limit, `day` for timeline granularity, `markdown` for report format and `html` for preview format. The tool implementations omit those fields from requests when callers omit them. Search applies its `maxResults` default in the request body.

## License

Apache-2.0
