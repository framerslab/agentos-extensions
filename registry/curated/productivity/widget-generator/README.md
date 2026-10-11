# Widget generator

This pack gives an agent a tool for saving interactive HTML/CSS/JS widgets. It uses Node.js filesystem APIs and adds HTML defaults and a browser error handler.

## Installation

```bash
npm install @framers/agentos-ext-widget-generator
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-widget-generator';

const extensionManager = new ExtensionManager();

extensionManager.register(createExtensionPack({
  options: { workspaceDir: process.cwd() },
  logger: console,
}));
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `workspaceDir` | None | None | No | `process.cwd()` |
| `serverPort` | None | None | No | `3777` |
| `publicBaseUrl` | None | None | No | `undefined` |
| `priority` | None | None | No | `50` |

## Tools

| Tool | What it does |
| --- | --- |
| `generate_widget` | Generates a self-contained interactive HTML/CSS/JS widget. |

### `generate_widget`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `html` | `string` | Yes | Complete HTML content for the widget. |
| `title` | `string` | Yes | Short title (used in filename and preview card). |
| `description` | `string` | No | Optional description shown in preview cards. |

## Notes

The tool writes timestamped HTML files under the workspace's `widgets/` directory and returns `filePath`, `widgetUrl`, `downloadUrl`, `inline`, `html`, and `sizeBytes`. View and download URLs use the same path. Without `publicBaseUrl`, URLs use localhost with `serverPort`. The pack constructs URLs but does not start a server to serve the files.

The wrapper adds missing doctype, charset, viewport, CSS reset, and `window.onerror` handling. The tool rejects input without a recognized HTML marker: `<html`, `<body`, `<script`, `<div`, `<canvas`, or `<svg`. It declares the required capability `capability:widget_generation`. The `description` input is accepted by the schema but is not used by the execution code.

The `inline` flag is true when the wrapped HTML's UTF-8 byte length is below `30 * 1024`. Larger widgets are still saved.

## License

Apache-2.0
