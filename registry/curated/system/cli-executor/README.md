# CLI Executor Extension for AgentOS

Execute shell commands, run scripts, and manage files for AgentOS agents. This is one of the two fundamental primitives (along with Web Browser) that enables recursive self-building agent capabilities.

## Features

- **Shell Execution**: Run any shell command with output capture
- **File Management**: Read, write, and list files/directories
- **Document I/O**: Read and write xlsx, csv, docx, and pdf files
- **Security Controls**: Dangerous command detection and blocking
- **Cross-Platform**: Works on Windows, macOS, and Linux

## Installation

```bash
npm install @framers/agentos-ext-cli-executor
```

## Quick Start

```typescript
import { ExtensionManager } from '@framers/agentos';
import { createExtensionPack } from '@framers/agentos-ext-cli-executor';

const extensionManager = new ExtensionManager();

// Load the pack into the runtime
await extensionManager.loadPackFromFactory(
  createExtensionPack({
    options: {
      defaultShell: 'bash',
      timeout: 60000,
      blockedCommands: ['rm -rf /', 'format'],
      // Restrict file_* tools to a per-agent workspace
      filesystem: { allowRead: true, allowWrite: true },
      agentWorkspace: { agentId: 'my-agent' },
    },
    logger: console,
  }),
  '@framers/agentos-ext-cli-executor',
);
```

## Tools

### shell_execute

Execute a shell command.

```typescript
const result = await gmi.executeTool('shell_execute', {
  command: 'npm install lodash',
  cwd: '/path/to/project',
  timeout: 30000
});
// Returns: { command, exitCode, stdout, stderr, duration, success }
```

### file_read

Read file contents.

```typescript
const result = await gmi.executeTool('file_read', {
  path: './package.json',
  encoding: 'utf-8'
});
// Returns: { path, content, size, truncated, encoding }

// Read last 50 lines
const logs = await gmi.executeTool('file_read', {
  path: './app.log',
  lines: 50,
  fromEnd: true
});
```

### file_write

Write content to a file.

```typescript
const result = await gmi.executeTool('file_write', {
  path: './config.json',
  content: JSON.stringify({ key: 'value' }),
  createDirs: true
});
// Returns: { path, bytesWritten, created, appended }
```

### list_directory

List directory contents.

```typescript
const result = await gmi.executeTool('list_directory', {
  path: './src',
  recursive: true,
  pattern: '*.ts',
  includeStats: true
});
// Returns: { path, entries: [{ name, path, type, size, ... }], count }
```

### read_document

Read and extract text from binary document formats (xlsx, xls, csv, tsv, docx, pdf).

```typescript
// Read an Excel spreadsheet
const result = await gmi.executeTool('read_document', {
  path: './data/report.xlsx',
  sheet: 'Q1 Revenue',  // optional: specific sheet
  maxRows: 200          // optional: limit rows (default: 500)
});
// Returns: { path, format, size, content (markdown tables), structured: { sheets }, metadata }

// Read a Word document
const doc = await gmi.executeTool('read_document', {
  path: './docs/proposal.docx'
});
// Returns: { path, format, size, content (extracted text), metadata }

// Read a PDF
const pdf = await gmi.executeTool('read_document', {
  path: './reports/annual.pdf'
});
// Returns: { path, format, size, content (extracted text), metadata: { pages, info } }
```

**Note:** `file_read` automatically redirects binary formats (.xlsx, .docx, .pdf) to `read_document` with a helpful error message.

### create_pdf

Create a real PDF document from text content.

```typescript
const result = await gmi.executeTool('create_pdf', {
  path: './output/report.pdf',
  content: 'Annual Report\n\nRevenue increased 25% year over year...',
  title: 'Annual Report 2026',
  author: 'Research Agent',
  fontSize: 11
});
// Returns: { path, pages, bytes }
```

### create_spreadsheet

Create an Excel (.xlsx) or CSV file from structured data.

```typescript
// From headers + rows (2D array)
const result = await gmi.executeTool('create_spreadsheet', {
  path: './output/data.xlsx',
  headers: ['Name', 'Age', 'City'],
  rows: [['Alice', 30, 'NYC'], ['Bob', 25, 'SF']],
  sheetName: 'Contacts'
});
// Returns: { path, format, rows, bytes }

// From array of objects
const result = await gmi.executeTool('create_spreadsheet', {
  path: './output/users.xlsx',
  data: [
    { name: 'Alice', age: 30, city: 'NYC' },
    { name: 'Bob', age: 25, city: 'SF' }
  ]
});

// From a markdown table
const result = await gmi.executeTool('create_spreadsheet', {
  path: './output/report.csv',
  markdown: '| Product | Sales |\n| --- | --- |\n| Widget | 1500 |\n| Gadget | 2300 |'
});

// CSV output (auto-detected from extension)
const csv = await gmi.executeTool('create_spreadsheet', {
  path: './output/export.csv',
  headers: ['id', 'value'],
  rows: [['1', '100'], ['2', '200']]
});
```

### create_document

Create a Word document (.docx) from text or markdown content.

```typescript
const result = await gmi.executeTool('create_document', {
  path: './output/report.docx',
  content: '# Quarterly Report\n\n## Summary\n\nRevenue was **$1.5M**, up *25%* from last quarter.\n\n- Widget sales: $800K\n- Gadget sales: $700K',
  title: 'Q1 Report',
  author: 'Research Agent'
});
// Returns: { path, paragraphs, bytes }
```

Supported markdown: `# headings` (H1-H6), `**bold**`, `*italic*`, `- bullet lists`.

**Note:** `file_write` automatically redirects .pdf, .xlsx, and .docx to the dedicated creation tools with a helpful error message.

## Security

The extension includes built-in security controls:

### Dangerous Pattern Detection

Commands matching these patterns are blocked by default:
- `rm -rf /` (recursive delete root)
- `format C:` (format drives)
- Fork bombs
- Direct disk writes
- System shutdown/reboot commands

### Custom Blocklists

```typescript
createExtensionPack({
  options: {
    blockedCommands: ['sudo', 'su', 'chmod 777'],
    allowedCommands: ['npm', 'node', 'python', 'git'] // Whitelist mode
  }
});
```

### Disabling Safety Checks (Dangerous)

If you need full control (for example, in a locked-down container or local dev), you can disable all command safety checks:

```typescript
createExtensionPack({
  options: {
    dangerouslySkipSecurityChecks: true
  }
});
```

### Risk Assessment

Each command is assessed for risk level:

| Risk Level | Examples |
|------------|----------|
| `safe` | `ls`, `cat`, `npm list` |
| `low` | `echo "text" > file.txt` |
| `medium` | `rm file.txt`, `eval` |
| `high` | `sudo`, `curl | sh` |
| `critical` | `rm -rf /`, blocked patterns |

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultShell` | string | `auto` | Shell to use (bash, powershell, cmd, zsh) |
| `timeout` | number | `60000` | Default timeout (ms) |
| `workingDirectory` | string | `process.cwd()` | Default working directory |
| `filesystem` | object | `undefined` | Optional policy for file_* tools (allowRead/allowWrite + roots) |
| `agentWorkspace` | object | `undefined` | Optional per-agent workspace directory helper |
| `allowedCommands` | string[] | `[]` | Command whitelist (empty = all) |
| `blockedCommands` | string[] | `[]` | Command blacklist (additional to built-in dangerous patterns) |
| `dangerouslySkipSecurityChecks` | boolean | `false` | Disable all command safety checks (use only in trusted environments) |
| `env` | object | `{}` | Environment variables |

### Filesystem Policy (Recommended)

By default, the `file_*` tools can access any path (legacy behavior). To enforce a safe filesystem sandbox, configure `filesystem` + roots:

```ts
createExtensionPack({
  options: {
    filesystem: {
      allowRead: true,
      allowWrite: true,
      readRoots: ['/Users/me/Documents/AgentOS/agents/my-agent'],
      writeRoots: ['/Users/me/Documents/AgentOS/agents/my-agent'],
    },
  },
});
```

### Per-Agent Workspace Helper

To simplify safe defaults, you can configure `agentWorkspace`. When paired with `filesystem.allowRead/allowWrite`, the extension defaults roots to the workspace directory.

```ts
createExtensionPack({
  options: {
    filesystem: { allowRead: true, allowWrite: true },
    agentWorkspace: {
      agentId: 'my-agent',
      // baseDir defaults to ~/Documents/AgentOS
      subdirs: ['assets', 'exports', 'tmp'],
    },
  },
});
```

## Use Cases

### Code Generation and Execution

```typescript
// Write generated code
await gmi.executeTool('file_write', {
  path: './generated/app.py',
  content: generatedPythonCode,
  createDirs: true
});

// Execute it
await gmi.executeTool('shell_execute', {
  command: 'python ./generated/app.py',
  timeout: 30000
});
```

### Project Setup

```typescript
// Create project structure
await gmi.executeTool('shell_execute', {
  command: 'npx create-react-app my-app --template typescript'
});

// Install dependencies
await gmi.executeTool('shell_execute', {
  command: 'npm install axios lodash',
  cwd: './my-app'
});
```

### Log Analysis

```typescript
// Read recent logs
const logs = await gmi.executeTool('file_read', {
  path: '/var/log/app.log',
  lines: 100,
  fromEnd: true
});

// Parse and analyze
const errorCount = logs.output.content.match(/ERROR/g)?.length || 0;
```

### Document Processing Pipeline

```typescript
// Read a spreadsheet, analyze it, write a report
const data = await gmi.executeTool('read_document', {
  path: './data/sales.xlsx',
  sheet: 'Q1'
});

// Create a summary report as Word doc
await gmi.executeTool('create_document', {
  path: './output/summary.docx',
  content: `# Sales Summary\n\n${data.output.content}`,
  title: 'Q1 Sales Summary'
});

// Export processed data as CSV
await gmi.executeTool('create_spreadsheet', {
  path: './output/processed.csv',
  headers: ['Region', 'Total'],
  rows: processedData
});

// Generate PDF invoice
await gmi.executeTool('create_pdf', {
  path: './output/invoice.pdf',
  content: invoiceText,
  title: 'Invoice #1234'
});
```

## The Two Primitives Theory

This extension, combined with the Web Browser extension, provides the two fundamental capabilities needed for a recursive self-building agent:

1. **CLI Executor** (this extension)
   - Execute arbitrary code
   - Manage files
   - Install dependencies
   - Run tests and builds

2. **Web Browser** (see web-browser extension)
   - Search for information
   - Read documentation
   - Learn new techniques
   - Verify implementations

Together, an intelligent agent can:
1. Identify what it needs to learn → Web search
2. Find documentation/tutorials → Web scraping
3. Write code → File write
4. Execute and test → Shell execute
5. Debug and iterate → Repeat

## License

Apache-2.0 © Frame.dev
