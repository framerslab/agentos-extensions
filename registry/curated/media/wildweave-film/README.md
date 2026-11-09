# @framers/agentos-ext-wildweave-film

WildWeave's film studio as 23 AgentOS tools and an MCP server. The tools read and edit a film's timeline and sidecar in a wilds.ai account through the studio's API with a per-account key (titles, credits and lower thirds from the template registry, overlays, keyframes, bed runs, stings and studio assets among the edits), export the film's sources and the studio files it names into its repository, run the local film engine (cut, validate, strip, coverage, render, preview push) and keep the proposals yes-list.

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

With `options.http`, the pack also lists one `http-handler` descriptor, `wildweave_film_mcp_http`, for a host that serves pack HTTP handlers on its own `node:http` server (wunderland's `start` does):

```ts
{ package: '@framers/agentos-ext-wildweave-film', options: { baseUrl: 'https://wilds.ai', http: { path: '/mcp/wildweave-film', token: process.env.WILDWEAVE_STUDIO_HTTP_TOKEN } } }
```

Its payload has the shape of AgentOS's `HttpHandlerPayload`, `(req, res) => Promise<boolean>`. It answers `false` for every path but its own (a query string aside), so the host's next handler answers those, and serves the 23 tools over MCP's streamable HTTP at its path with the pack's key and engine, to a caller that sends the endpoint's bearer token:

```ts
new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3777/mcp/wildweave-film'), {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});
```

Each request passes three checks before its body is read:

1. A peer whose socket address is outside the loopback gets 403.
2. A Host or a browser `Origin` that is not the loopback gets 403, against DNS rebinding.
3. A request without `Authorization: Bearer <token>` gets 401 with a `WWW-Authenticate: Bearer` challenge. The scheme matches in any case and the token is compared in constant time.

The token is what refuses a remote caller behind a reverse proxy on the same host: nginx's `proxy_pass http://127.0.0.1:<port>`, with its default `proxy_set_header Host $proxy_host`, forwards any caller from the loopback with a loopback Host and no Origin, so the first two checks pass it.

The pack reads the token from `http.token`, then the secret `wildweave.studio.http_token`, then `WILDWEAVE_STUDIO_HTTP_TOKEN`. It takes 32 or more of RFC 6750's `b64token` characters (letters, digits and `-._~+/`, then any `=`), such as `openssl rand -hex 32` writes. With `http` and no token, or a token of another form, the pack refuses to load with an error naming `http.token`; it never serves the endpoint open. The token is masked in every log line, and each refusal logs one line with its code (`peer_not_loopback`, `host_or_origin_refused`, `token_missing` or `token_rejected`).

The path begins with `/` and has no empty or dot segment, query or trailing slash; any other value refuses the pack. `onDeactivate` closes the handler.

## Configuration

| Variable | Option | Means | Default |
|---|---|---|---|
| `WILDWEAVE_STUDIO_BASE_URL` | `baseUrl` | the studio's origin | `https://wilds.ai` |
| `WILDWEAVE_STUDIO_KEY` | `key` | the per-account studio key | none: remote tools answer `key_missing` |
| `WILDWEAVE_FILM_ENGINE_DIR` | `engineDir` | a wilds-ai checkout with the engine installed | none: local tools answer `engine_missing` |
| `WILDWEAVE_FILM_REPO` | `filmRepo` | the film repository: the default `film`, the folder a local tool's relative path lies under (the working directory without one), and the root every export write lies inside | none |
| `WILDWEAVE_FILM_LOG_LEVEL` | `logLevel` | pino's level | `info` |
| `WILDWEAVE_FILM_TIMEOUT_MS` | `timeoutMs` | one remote call's deadline | 30,000 ms; the export 120,000 ms |
| none | `http.path` | where a host's own HTTP server serves the tools over MCP, as the `http-handler` descriptor | none: no `http-handler` descriptor |
| `WILDWEAVE_STUDIO_HTTP_TOKEN` | `http.token` | the bearer token the `http-handler` descriptor asks every caller for; else the secret `wildweave.studio.http_token` | none: with `http`, the pack refuses to load |

Logs are pino JSON lines on stderr (stdout is the MCP protocol's channel), with `authorization` and every key field redacted and any key-shaped string masked in messages, child output and returned errors, a refusal's findings included, at every level (an object more than 64 levels down, or one that holds itself, is redacted whole).

Retries: a network error, a 502, a 503 and a 504 are tried again twice, after 1 s and 4 s, for an idempotent call: every read, an edit (its `editId` makes it idempotent on the route), the export without an acknowledgement, a decision, and a submit (the tool names a `proposalId` when the caller gives none, so a retry after a lost answer finds the proposal that stands, `replayed: true`, and stores no second one). An answer whose body is cut off after its headers keeps its status's rule when the status decides alone (a 429, a 401, a 403, any 4xx); else it is a failed call (`network`, or `timeout` past the deadline), retried by the same rule, since the route may have acted on it. A 429 is tried again after its `Retry-After`, up to three times. A 401 or a 403 is never retried, and neither is a refusal the account's plan or room decides, whatever its status: `plan_required`, `limit_reached`, `budget_exhausted`, `not_open` (a 503) and `file_too_large` (see the gate's refusals below).

## The tools

| Tool | Mode | Scope | What it does | Refusals |
|---|---|---|---|---|
| `wildweave_film_list` | remote | read | the account's films | `key_missing`, `key_rejected`, `forge_required`, `scope_required` |
| `wildweave_film_documents` | remote | read | the documents the import binds | `not_found` |
| `wildweave_film_document_read` | remote | read | one bound document with its content | `not_found` |
| `wildweave_film_timeline` | remote | read | the timeline, the sidecar, their sha256, every edit time and the readiness | `not_found`, `film_unreadable` |
| `wildweave_film_scene` | remote | read | one scene, its sidecar entry, readiness and findings | `scene_unknown`, `not_found` |
| `wildweave_film_validate` | both | read | the in-app validate (`filmId`), or the engine's (`cut`) | `arg_invalid`, `engine_missing` |
| `wildweave_film_edit` | remote | write | edit ops guarded by the edit times, then validated (the ops below) | `stale_write`, `edit_refused`, `edit_id_reused`, `record_reimport_required` |
| `wildweave_film_edits` | remote | read | the edit log: `edit`, `revert`, `import` and `ack` rows | `not_found` |
| `wildweave_film_revert` | remote | write | the timeline unit as it was before a row of the log | `seq_unknown`, `import_between`, `stale_write` |
| `wildweave_film_import` | local | import | the film repository into the account (`dry-run`, `local`, `production`) | `engine_missing`, `key_missing` |
| `wildweave_film_export` | remote | read | the sources and `fetch`, the studio files the timeline names that the repository lacks; with `writeTo` (a folder of the repository, made when it lacks one), the sources and the fetched files written into the repository all or nothing (a rollback the file system refuses is named in `details.unrestored` and `details.notRemoved`) and the sources acknowledged | `fetch_failed`, `engine_too_old`, `source_changed`, `export_invalid`, `export_write_failed`, `path_outside_repo`, `film_repo_missing`, `stale_write` |
| `wildweave_film_inspect` | both | read | the cut's report (`filmId`), or the engine's (`cut`) | `cut_refused`, `engine_missing` |
| `wildweave_film_cut` | local | read | the cut from the timeline and the sidecar, written to `out` (so the tool has side effects) | `engine_missing` |
| `wildweave_film_strip` | local | render | contact sheets of a scene or of every scene | `engine_missing` |
| `wildweave_film_coverage` | local | render | whether every scene's picture can be drawn | `engine_missing` |
| `wildweave_film_render` | both | render | a draft or the master on this machine; a job on the box | `not_open`, `kind_not_local`, `engine_missing` |
| `wildweave_film_records` | both | read | a render folder's records; a job on the box | `not_found`, `not_open` |
| `wildweave_film_preview` | remote | read | the preview page, readiness and staged files | `not_found` |
| `wildweave_film_preview_push` | local | write and import | a draft render's parts and the beds into the preview: it stages each file at the import scope and posts the preview at the write scope | `engine_missing`, `key_missing` |
| `wildweave_film_proposals` | remote | read | the yes-list, oldest first | `not_found` |
| `wildweave_film_proposal_submit` | remote | write | a proposal for a scene with its rights line, under the `proposalId` given or one the tool names | `proposal_id_reused`, `scene_unknown`, `invalid_body` |
| `wildweave_film_proposal_decide` | remote | write | his verdict in his words | `already_decided`, `source_app_needs_session` |
| `wildweave_film_templates` | remote | read | the template registry (each look's id, kind, name, editable groups, defaults and parameter schema), the transition kinds the render box draws and the account's saved templates; with `filmId`, the film's own templates table too | `not_found` |

### The edit ops

v1's ops: `reorder`, `move`, `trim`, `clip_window`, `clip_sound`, `transition` (`cut`, `crossfade`, `dip-to-black`, `wipe`, `dip-to-white`, `slide`, `circle-open`, `circle-close`, `wipe-diagonal`; a wipe's or a slide's side, a diagonal wipe's corner), `bed`, `beds`, `marks`, `marks_table` and `layers` (a strip, an intertitle or a text frame, each with an optional stable `id`). The studio's v2 ops name a layer by its stable id, unique in its scene, up to 64 characters without `@`:

| Op | Writes |
|---|---|
| `layer_ids` | an id for every layer that lacks one; nothing a person sees changes. Send it once before naming layers by id |
| `template_layer` | a `title` or `credits` layer on a card scene, a `lower-third` on any other, from a registry look (`template: 'title.morph'`, as `wildweave_film_templates` lists them) or the film's own entry (`template: '@my-title'`), with its `params`, window and opacity, at an index or last |
| `templates_table` | the film's own templates, whole: `{ <id>: { base, params, name } }`; removing an entry a layer draws is `template_in_use` |
| `overlay` | a picture of the scene's own assets over its visual, at a place (`{ xPct, yPct, wPct }` or its keyframes), with its window, opacity and move |
| `layer_update` | the fields the layer's kind allows: a text layer's words and timing, a template layer's params, place and timing, an overlay's place, timing, opacity and move, a capture's place and timing; any other is `layer_field_immutable`; `null` removes an optional field |
| `layer_remove` | a text, template or overlay layer off its scene; a capture or a label stays |
| `keyframes` | `{ atMs, value, ease }` points (`linear`, `smoother`, `hold`) on a still's visual (`move`), a clip's sound (`gain`) or a layer (`opacity`, `place`, `move`); `null` removes them |
| `bed_edit` | one run of a bed, named by its first scene: `inMs` and `outMs` inside the file, `gain`, `fadeInMs`, `fadeOutMs`, `duck` and `gainKeyframes` |
| `sting` | a scene's whole marks list with each mark's `kind`, `gain`, fades, part of the file and envelope |
| `asset_add`, `asset_remove` | a staged studio file on the scene's assets (`assetRow`: its kind, path, licence and rights come from the staged row, never the op), and off it |
| `visual` | the scene's picture (a still or a clip of its assets, or `null` for its default) and its move |
| `assets_rights` | an asset's `changes` line alone; no op sets a rights value |

The module on wilds.ai refuses an op with its code (`template_unknown`, `template_params_invalid`, `template_kind_misplaced`, `layer_unknown`, `keyframe_outside_layer`, `keyframes_unsorted`, `gain_out_of_range`, `fade_too_long`, `bed_run_unknown`, `asset_not_eligible`, `rights_field_protected` and the rest) inside `edit_refused`, with the op's index; the pack's schema refuses a field an op does not name (`arg_invalid`) before the call.

### The gate's refusals

The studio gate answers one envelope for every refusal: the code in `error`, then `capability`, `tier`, `requiredPlan`, `upgradeUrl`, `limit` (the meter, what is used of what, its window), `checkoutPaused`, `policyVersion` and `message`, the policy's words. The tools answer the envelope's `message` as the error's and its other fields as `error.refusal`; a v1 body that names the code alone (`{ "error": "forge_required" }`) reads as before. What each means for an agent:

| Code | Status | Means | What the agent does |
|---|---|---|---|
| `plan_required` | 403 | the account's plan lacks the capability (`refusal.capability`); `refusal.requiredPlan` names the plan that has it | tell the person, with `refusal.upgradeUrl`; never send the call again |
| `forge_required` | 403 | the capability is Forge's | as `plan_required` |
| `limit_reached` | 402 | the account's room is used (`refusal.limit`: films, scenes, length, renders, storage, studio credits) | tell the person; free room first or upgrade |
| `insufficient_credits` | 402 | the account holds too few credits | tell the person |
| `budget_exhausted` | 402 | the window's budget is used | wait for the window to reset (`refusal.limit.resetsAt`) |
| `not_open` | 503 | the piece is not open yet on any plan (the render worker, studio storage) | use the local engine; never send the call again |
| `file_too_large` | 413 | the file is over the size the studio takes | a smaller file |
| `rate_limited` | 429 | the key's rate | the client waits out `Retry-After` itself |

None of these changes when the call is sent again, so the client never retries them.

Every remote tool also answers `key_missing`, `key_rejected`, `forge_required`, `scope_required`, `rate_limited`, `network` and `timeout`. A refusal's code is the `error` its body names when that reads as a code; prose there (a proxy's `401 {"error":"Invalid or expired token"}`) is the message when the body has none, and the code is read by the status, 401 as `key_rejected`, 403 as `forge_required`, 429 as `rate_limited`, any other as `http_<status>`; every tool answers `arg_invalid` for arguments its schema refuses. Each tool's input and output schemas ship as `dist/schemas/<tool>.json`.

The export writes into the repository only what has not moved there since the last crossing: a file whose hash is neither the export's nor the base the studio recorded is reported `source_changed` with both hashes, and nothing is written unless `force`. Every path is resolved with its symlinks and must lie inside `WILDWEAVE_FILM_REPO`; `force` never lifts that. Two sources may not resolve to one file (`arg_invalid`). The set is written into a folder inside the repository, cut and validated by the engine when one is configured, then renamed into place, each file read again right before its rename, with only its hash between the read and the rename: one that changed while the set was checked refuses the export with `source_changed`, puts back the files already moved and acknowledges nothing, unless `force`, which writes over it and reports it forced. A save landing between that read and the rename is still written over: no file-system call renames only over an unchanged file. Each file's backup is written before that read, so putting the files back only renames (with `force`, a file that changed while its backup was written has the backup written again from its new bytes and is read once more, and one still changing after four tries is refused); a file that cannot be put back (a full disk, a file another program holds open) is named in `details.unrestored` with `keptAt`, where its old bytes stay, and the staging folder is kept; a file the export made where the repository held none and cannot remove is named in `details.notRemoved`. Either way the answer never says the files were put back. A refused export removes only the folders it made that are left empty. The written hashes are then acknowledged to the studio.

The studio files a film places (a stock clip, a catalog bed or sting, a generated still) live in the account's storage until the export brings them into the repository: the export route lists each one the timeline names and the repository lacks in `fetch`, with its path, sha256, size, files-route address, rights line and `stock.json`. With `writeTo`, the tool fetches each through `GET /files/:sha256?key=` with the studio key (an address that is not the studio's files route is refused, so the key goes nowhere else), checks its sha256 and size, and writes it at its path under `writeTo` with its `stock.json` (the librarian's record with its dated rights line) beside it; a file the repository holds with that sha256 is never fetched again (`fetchUnchanged`), and its `stock.json`, when the repository lacks it, is written beside it all the same (`stockWritten`). Every file is fetched into the staging folder before any file moves, so a fetch that fails answers `fetch_failed` naming the path and leaves the repository as it was. The fetched files go into place before the engine cuts and validates the whole set, which reads them under the assets root, and come out again if it refuses the set; a fetched file saved over while the engine checked the set is kept as it was saved and named in `details.kept`. A fetched file or a `stock.json` that the repository holds with other bytes is a `source_changed` conflict, as a source's is, and a file `force` wrote over is reported `forced` in `fetched`. The acknowledgement names the written sources; the answer's `fetched` names the files written, and the next import's record lists them. A refused acknowledgement names what stays written: `written`, `fetched` and `stockWritten`. An address the route lists that is not the files route is refused naming it without its query, and no log line repeats a file's `key`.

Before any of it, with an engine configured, the tool reads the engine clone: the shapes the export writes (template layers, overlays, layer ids, bed runs, marks with their fields, keyframes) need a wilds-ai checkout at `package.json` version 0.1.0 or later holding `src/lib/wildweave/film-keyframes.ts` (the engine of 7 November 2026 or later), and a clone that predates them answers `engine_too_old` with that floor, in place of the engine's own words about a layer it cannot read. wilds-ai's `package.json` version has stayed at 0.1.0 as the engine grew, which is why the floor names the module too.

## What the package never contains

No engine code, no route code, no checker, mapper or parser of the studio, no fonts, no database driver or adapter, no key, no account and no material of any film: its test fixtures are a synthetic three-scene film with invented words. A test reads its dependency list for database drivers, and another reads `npm pack --dry-run` for any file outside `dist/`, `bin/`, `manifest.json`, `README.md`, `CHANGELOG.md` and `LICENSE`, for source maps, and for an export or a bin import that points outside the tarball. Another calls every tool through both hosts while a studio and an engine echo the key back, and finds it in no log line and no answer. Nothing in the package makes the studio reachable without an account the studio's gate admits and a scoped key.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, from the workflow `.github/workflows/release.yml`, with a provenance statement.

## Licence

Apache-2.0
