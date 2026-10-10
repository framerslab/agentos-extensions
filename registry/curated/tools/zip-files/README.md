# Zip Files

Create zip archives from local files for sharing via chat channels.

## Installation

```bash
npm install @framers/agentos-ext-zip-files
```

## Usage

```typescript
import { createExtensionPack } from '@framers/agentos-ext-zip-files';

const pack = createExtensionPack();
```

## Tool: `zip_files`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | string[] | Yes | Array of absolute file paths to include |
| `outputName` | string | No | Name for the zip (without `.zip` extension) |

### Example

```
User: "Zip up my report files and send them to me"
Tool calls:
  1. local_file_search({ query: "report" })
  2. zip_files({ files: ["/path/report.pdf", "/path/report-data.csv"], outputName: "reports" })
  3. send_file_to_channel({ filePath: "/tmp/wunderland-zips/reports.zip" })
```

## Behavior

- Output directory: `/tmp/wunderland-zips/`
- Compression: zlib level 6 (balanced speed/size)
- Max total input size: 500 MB
- Auto-cleanup: zips older than 1 hour are deleted on each invocation
- Validates all input paths exist before creating the archive

## Dependencies

- `archiver` (npm) for cross-platform zip creation

## License

Apache-2.0
