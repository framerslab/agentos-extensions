# Media upload

This pack gives an agent a media-file tool that reads local files with Node.js filesystem APIs and returns an asset identifier, MIME type, size and tags for use in social-post workflows.

## Installation

```bash
npm install @framers/agentos-ext-tool-media-upload
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-tool-media-upload' }],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `logger` | None | None | No | None |

## Tools

| Tool | What it does |
| --- | --- |
| `mediaUpload` | Describes uploading an image, video or audio file to a media library and returning an asset ID for post tools. |

### `mediaUpload`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `filePath` | `string` | Yes | Absolute or relative path to the media file to upload. |
| `tags` | `array` of `string` | No | Tags for organizing the asset in the media library. |
| `seedId` | `string` | No | Agent seed ID (owner). Defaults to current agent if omitted. |

## Notes

The implementation reads the file into memory and returns a generated UUID as `assetId`, plus `filename`, `mimeType`, `size`, `tags` and a message saying the file is uploaded. It performs no network upload or library persistence. The `setToolExecutor` method stores a callback that execution does not call. Although the schema describes ownership through `seedId`, execution does not read that parameter.

Supported extensions are `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`, `.svg`, `.mp4`, `.mov`, `.webm`, `.mp3`, `.wav`, `.ogg` and `.pdf`. MIME detection uses the lowercased filename extension. Tags default to an empty array.

Relative paths resolve from the process working directory. The file-size limit is `100 * 1024 * 1024` bytes, inclusive. Missing files, non-file paths, oversized files, unsupported extensions and filesystem errors produce failed tool results.

## License

Apache-2.0
