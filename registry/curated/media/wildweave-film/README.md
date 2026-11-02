# @framers/agentos-ext-wildweave-film

WildWeave's film studio as 22 AgentOS tools and an MCP server. The tools read and edit a film's timeline and sidecar in a wilds.ai account through the studio's API with a per-account key, export the film's sources into its repository, run the local film engine (cut, validate, strip, coverage, render, preview push) and keep the proposals yes-list.

The engine and the studio's routes stay in wilds.ai. This package holds the client over the routes, the tool schemas, the AgentOS pack, the MCP entries and the runner that calls the engine's command by path.

```bash
npm install @framers/agentos-ext-wildweave-film
```

Node 22 or later. `@framers/agentos` is an optional peer: the AgentOS pack needs it, the MCP server does not.

## Two modes

- **Remote** tools call the studio's routes under `/api/v1/wildweave/studio/` on wilds.ai with `Authorization: Bearer <key>`. Every route is behind the studio's Forge gate, and the key is a studio-scoped developer key (`wildweave:film:read`, `:write`, `:render`, `:import`). Without a key a remote tool answers `key_missing`.
- **Local** tools run the engine's command, `pnpm wildweave-film <subcommand> ... --json`, in the wilds-ai checkout `WILDWEAVE_FILM_ENGINE_DIR` names, through `execFile` with an argument array, never a shell string. A value that begins with `-` is refused (`arg_invalid`). The key reaches a child that posts to the studio (an import, a preview push) only as `WILDS_IMPORT_TOKEN` in its environment, never in its arguments. Without an engine directory a local tool answers `engine_missing`.

Every tool answers one JSON object:

```json
{ "ok": true, "result": { "films": [] }, "requestId": "..." }
{ "ok": false, "error": { "code": "stale_write", "message": "...", "status": 409, "requestId": "...", "details": { "updatedAtMs": {} } } }
```

## Claude Code

Add the server to the film repository's `.mcp.json`, with every value read from the environment:

```json
{ "mcpServers": { "wildweave-film": { "type": "stdio", "command": "node", "args": ["node_modules/@framers/agentos-ext-wildweave-film/bin/wildweave-film-mcp.mjs"], "env": { "WILDWEAVE_STUDIO_KEY": "${WILDWEAVE_STUDIO_KEY}", "WILDWEAVE_FILM_ENGINE_DIR": "${WILDWEAVE_FILM_ENGINE_DIR}", "WILDWEAVE_FILM_REPO": "${WILDWEAVE_FILM_REPO:-.}" } } } }
```

Export the key in the shell that starts Claude Code, from your secret store:

```bash
export WILDWEAVE_STUDIO_KEY="$(your-secret-store read wilds-ai-studio-key)"
```

Never paste a key into `.mcp.json` as a value: the file is committed with the repository. A project server waits for approval until the workspace is trusted. `claude mcp add --transport stdio wildweave-film -- node <path to the bin>` registers it for one machine; give it the key through the environment, not `--env` on the command line, which keeps the value in your shell history.

## Streamable HTTP

For a host on the same machine that speaks streamable HTTP rather than stdio:

```bash
node node_modules/@framers/agentos-ext-wildweave-film/bin/wildweave-film-mcp.mjs --http 127.0.0.1:8765
```

It serves the tools at `http://127.0.0.1:8765/mcp`, bound to the loopback address alone, and refuses a request whose `Host` or `Origin` is not the loopback (403), against DNS rebinding. A host that serves MCP on its own route mounts the web-standard handler instead, after verifying its own callers:

```ts
import { resolveConfig, createLogger } from '@framers/agentos-ext-wildweave-film';
import { createWildweaveMcpHandler } from '@framers/agentos-ext-wildweave-film/mcp';

const config = await resolveConfig({ baseUrl: 'https://wilds.ai' });
const handler = createWildweaveMcpHandler(config, createLogger({ level: config.logLevel }));
// handler.fetch(request) answers one MCP request; handler.close() ends them.
```

## AgentOS

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: { packs: [{ package: '@framers/agentos-ext-wildweave-film', options: { baseUrl: 'https://wilds.ai' } }] },
});
```

The pack reads the key from `options.key`, then the secret `wildweave.studio.key`, then `WILDWEAVE_STUDIO_KEY`. It loads without a key and lists its tools. Each tool is a `tool` descriptor whose id is the tool's name, with JSON Schema draft-07 input and output schemas, `category: 'media'` and `hasSideEffects` set for every write.

## Configuration

| Variable | Option | Means | Default |
|---|---|---|---|
| `WILDWEAVE_STUDIO_BASE_URL` | `baseUrl` | the studio's origin | `https://wilds.ai` |
| `WILDWEAVE_STUDIO_KEY` | `key` | the per-account studio key | none: remote tools answer `key_missing` |
| `WILDWEAVE_FILM_ENGINE_DIR` | `engineDir` | a wilds-ai checkout with the engine installed | none: local tools answer `engine_missing` |
| `WILDWEAVE_FILM_REPO` | `filmRepo` | the film repository: the default `film`, the folder a local tool's relative path lies under (the working directory without one), and the root every export write lies inside | none |
| `WILDWEAVE_FILM_LOG_LEVEL` | `logLevel` | pino's level | `info` |
| `WILDWEAVE_FILM_TIMEOUT_MS` | `timeoutMs` | one remote call's deadline | 30,000 ms; the export 120,000 ms |

Logs are pino JSON lines on stderr (stdout is the MCP protocol's channel), with `authorization` and every key field redacted and any key-shaped string masked in messages, child output and returned errors.

Retries: a network error, a 502, a 503 other than `not_open` and a 504 are tried again twice, after 1 s and 4 s, for an idempotent call: every read, an edit (its `editId` makes it idempotent on the route), the export without an acknowledgement, a decision, and a submit (the tool names a `proposalId` when the caller gives none, so a retry after a lost answer finds the proposal that stands, `replayed: true`, and stores no second one). An answer whose body is cut off after its headers keeps its status's rule when the status decides alone (a 429, a 401, a 403, any 4xx); else it is a failed call (`network`, or `timeout` past the deadline), retried by the same rule, since the route may have acted on it. A 429 is tried again after its `Retry-After`, up to three times. A 401 or a 403 is never retried.

## The tools

| Tool | Mode | Scope | What it does | Refusals |
|---|---|---|---|---|
| `wildweave_film_list` | remote | read | the account's films | `key_missing`, `key_rejected`, `forge_required`, `scope_required` |
| `wildweave_film_documents` | remote | read | the documents the import binds | `not_found` |
| `wildweave_film_document_read` | remote | read | one bound document with its content | `not_found` |
| `wildweave_film_timeline` | remote | read | the timeline, the sidecar, their sha256, every edit time and the readiness | `not_found`, `film_unreadable` |
| `wildweave_film_scene` | remote | read | one scene, its sidecar entry, readiness and findings | `scene_unknown`, `not_found` |
| `wildweave_film_validate` | both | read | the in-app validate (`filmId`), or the engine's (`cut`) | `arg_invalid`, `engine_missing` |
| `wildweave_film_edit` | remote | write | edit ops guarded by the edit times, then validated | `stale_write`, `edit_refused`, `edit_id_reused`, `record_reimport_required` |
| `wildweave_film_edits` | remote | read | the edit log: `edit`, `revert`, `import` and `ack` rows | `not_found` |
| `wildweave_film_revert` | remote | write | the timeline unit as it was before a row of the log | `seq_unknown`, `import_between`, `stale_write` |
| `wildweave_film_import` | local | import | the film repository into the account (`dry-run`, `local`, `production`) | `engine_missing`, `key_missing` |
| `wildweave_film_export` | remote | read | the sources; with `writeTo` (a folder of the repository, made when it lacks one), written into the repository all or nothing and acknowledged | `source_changed`, `export_invalid`, `export_write_failed`, `path_outside_repo`, `film_repo_missing`, `stale_write` |
| `wildweave_film_inspect` | both | read | the cut's report (`filmId`), or the engine's (`cut`) | `cut_refused`, `engine_missing` |
| `wildweave_film_cut` | local | read | the cut from the timeline and the sidecar, written to `out` (so the tool has side effects) | `engine_missing` |
| `wildweave_film_strip` | local | render | contact sheets of a scene or of every scene | `engine_missing` |
| `wildweave_film_coverage` | local | render | whether every scene's picture can be drawn | `engine_missing` |
| `wildweave_film_render` | both | render | a draft or the master on this machine; a job on the box | `not_open`, `kind_not_local`, `engine_missing` |
| `wildweave_film_records` | both | read | a render folder's records; a job on the box | `not_found`, `not_open` |
| `wildweave_film_preview` | remote | read | the preview page, readiness and staged files | `not_found` |
| `wildweave_film_preview_push` | local | write | a draft render's parts and the beds into the preview | `engine_missing`, `key_missing` |
| `wildweave_film_proposals` | remote | read | the yes-list, oldest first | `not_found` |
| `wildweave_film_proposal_submit` | remote | write | a proposal for a scene with its rights line, under the `proposalId` given or one the tool names | `proposal_id_reused`, `scene_unknown`, `invalid_body` |
| `wildweave_film_proposal_decide` | remote | write | his verdict in his words | `already_decided`, `source_app_needs_session` |

Every remote tool also answers `key_missing`, `key_rejected`, `forge_required`, `scope_required`, `rate_limited`, `network` and `timeout`; every tool answers `arg_invalid` for arguments its schema refuses. Each tool's input and output schemas ship as `dist/schemas/<tool>.json`.

The export writes into the repository only what has not moved there since the last crossing: a file whose hash is neither the export's nor the base the studio recorded is reported `source_changed` with both hashes, and nothing is written unless `force`. Every path is resolved with its symlinks and must lie inside `WILDWEAVE_FILM_REPO`; `force` never lifts that. Two sources may not resolve to one file (`arg_invalid`). The set is written into a folder inside the repository, cut and validated by the engine when one is configured, then renamed into place, each file read again right before its rename, with only its hash between the read and the rename: one that changed while the set was checked refuses the export with `source_changed`, puts back the files already moved and acknowledges nothing, unless `force`, which writes over it and reports it forced. A save landing between that read and the rename is still written over: no file-system call renames only over an unchanged file. A refused export removes only the folders it made that are left empty. The written hashes are then acknowledged to the studio.

## What the package never contains

No engine code, no route code, no checker, mapper or parser of the studio, no fonts, no database driver or adapter, no key, no account and no material of any film: its test fixtures are a synthetic three-scene film with invented words. A test reads its dependency list for database drivers, and another reads `npm pack --dry-run` for any file outside `dist/`, `bin/`, `manifest.json`, `README.md`, `CHANGELOG.md` and `LICENSE`, and for source maps. Nothing in the package makes the studio reachable without a Forge account and a scoped key.

## Licence

Apache-2.0
