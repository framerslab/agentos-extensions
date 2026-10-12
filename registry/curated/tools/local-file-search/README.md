# Local File Search

Search for files on the local filesystem by fuzzy name matching.

## Installation

```bash
npm install @framers/agentos-ext-local-file-search
```

## Usage

```typescript
import { createExtensionPack } from '@framers/agentos-ext-local-file-search';

const pack = createExtensionPack({
  config: {
    denylist: ['/proc', '/sys', 'node_modules', '.git', '.ssh', '*.key'],
    maxResults: 10,
    maxDepth: 10,
    timeoutMs: 10000,
  },
});
```

## Tool: `local_file_search`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Filename or partial filename to search for |
| `directory` | string | No | Specific directory to search (defaults to full filesystem) |

### Example

```
User: "Find pic.png in my Downloads folder"
Tool call: local_file_search({ query: "pic.png", directory: "/Users/me/Downloads" })
Result: [{ path: "/Users/me/Downloads/pic.png", size: 2100000, mimeType: "image/png" }]
```

## Relevance Ranking

Results are ranked by match quality:

| Match Type | Score | Example |
|-----------|-------|---------|
| Exact match | 1.0 | `pic.png` matches `pic.png` |
| Without extension | 0.95 | `pic` matches `pic.png` |
| Starts with | 0.8 | `pic` matches `picture.jpg` |
| Contains | 0.6 | `report` matches `quarterly-report.pdf` |
| Fuzzy (Levenshtein ≤ 3) | 0.06-0.30 | `rprt` matches `report` |

## Denylist

The denylist filters both directories and files:

- **Directory patterns**: `/proc`, `/sys`, `node_modules`, `.git`, `.ssh`
- **Glob patterns**: `*.key`, `*.pem`, `*.secret`

Configurable via `agent.config.json`:

```json
{
  "fileSearch": {
    "denylist": ["/proc", "/sys", "node_modules", ".git", ".ssh", "*.key"],
    "maxResults": 10
  }
}
```

## License

Apache-2.0
