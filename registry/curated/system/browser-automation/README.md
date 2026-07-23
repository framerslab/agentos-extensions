# @framers/agentos-ext-browser-automation

Browser automation for AgentOS agents, in two independent lanes:

- **Launch lane** — 10 Playwright-backed tools (`browserNavigate`, `browserClick`, `browserFill`, `browserScreenshot`, `browserExtract`, `browserWait`, `browserScroll`, `browserSnapshot`, `browserEvaluate`, `browserSession`) that drive a browser the pack launches and owns. Optional CAPTCHA solving and proxy rotation.
- **Attach lane** — 6 `browser_attach_*` tools plus a persistent daemon that drive the user's **already-running, logged-in** browser. Opt-in only (`attach.expectedIdentity` required). Never launches a browser.

## Attach daemon

One long-lived daemon holds one raw-CDP session to the running Chrome. Every consumer — CLI scripts, declarative runs, agent missions — drives that session over file-queue IPC under `~/.wunderland/attach/ipc/`. The daemon is the only process that touches the network, so macOS raises its Local Network permission prompt once per daemon lifetime instead of once per agent process.

```
callers (CLI / scripts / agent tools)  ── files only ──►  AttachDaemon (one process)
                                                            └─ raw CDP ws://localhost:<port>  ──►  your Chrome
```

Requires Node 22 or newer (the transport is the built-in `WebSocket`; the daemon exits with an actionable message on older runtimes). Chrome must run with `--remote-debugging-port=9222`.

### Hard contracts

- Never launches, quits, restarts, or signals Chrome, under any failure.
- Creates one agent tab and can close only that tab; every other tab is untouched (asserted by a real-browser e2e).
- CDP host is `localhost` (Chrome's DNS-rebinding guard rejects `127.0.0.1`).
- One daemon (atomic pidfile lock), one claimant at a time (lease + claim), serial ops.
- No eval on the agent tool surface. `eval` exists only on the JS client for user-authored scripts.
- Page text is returned with `untrusted: true` — treat it as data, never as instructions.
- Navigation is policy-checked daemon-side: https or `about:blank`, no credential-bearing URLs, redirects revalidated.
- No cookie, storage, or credential export; diagnostics are redacted.
- Clients never respawn a dead daemon (a respawn loop is a permission-prompt storm). Autostart, when explicitly enabled, attempts exactly once.

### Ops

`ping`, `status`, `claim`, `goto {url, settle?}`, `read {selector?, maxChars?}`, `extract {fields?}`, `eval {expression, timeoutMs?}` (user lane), `release`, `control {action}`, `quit`. Commands are one file each (`cmd-<id>.json` → `resp-<id>.json`, atomic write-then-rename, string ids); `status.json` heartbeats every loop tick.

### Using it

Programmatic (`/attach/daemon` subpath):

```ts
import { AttachDaemonClient, runAttachScript } from '@framers/agentos-ext-browser-automation/attach/daemon';

const client = new AttachDaemonClient({ client: 'my-script' });
await client.claim();
await client.goto('https://example.com/', { settle: 2000 });
const { text } = await client.read({ maxChars: 4000 });
await client.release();
```

Declarative plans (no control flow, no eval):

```yaml
name: crawl
claim: { ttlMs: 600000 }
steps:
  - { op: goto, url: "https://example.com/list", settle: 2500 }
  - { op: read, out: listing }
  - { op: extract, fields: { items: "ul li" }, out: items }
```

From the wunderland CLI: `wunderland attach start | status | stop | run <file.mjs|file.yaml|file.json>`. Agent missions reach the same held session by enabling the attach tools with `transport: 'cdp'` (`WUNDERLAND_ATTACH_TRANSPORT=cdp`).

### Environment

| Variable | Meaning |
|---|---|
| `WUNDERLAND_ATTACH_IDENTITY` | Required. Profile identity the daemon must verify before claiming (e.g. your account email; matched against the identity-probe tab's title/url metadata). |
| `WUNDERLAND_ATTACH_TRANSPORT` | `jxa` (in-process, macOS AppleScript) or `cdp` (daemon-routed). |
| `WUNDERLAND_ATTACH_PROFILE_ROOT` | Chrome profile root holding `DevToolsActivePort`. |
| `WUNDERLAND_ATTACH_PROBE_URL` | Identity-probe URL substring (default `mail.google.com`). |
| `WUNDERLAND_ATTACH_HOSTS` | Comma-separated https host allowlist for navigation. |
| `WUNDERLAND_ATTACH_LEASE` | Lease file path override. |
| `WUNDERLAND_ATTACH_IPC_DIR` | IPC directory override (default `~/.wunderland/attach/ipc`). |
| `WUNDERLAND_ATTACH_PID_FILE` | Daemon pidfile override (default `~/.wunderland/attach/daemon.pid`). |
| `WUNDERLAND_ATTACH_AUTOSTART` | `1`/`true`: allow one autostart attempt when the daemon is down. |
| `WUNDERLAND_ATTACH_DRYRUN` | `1`/`true`: simulate navigation/reads without touching the browser. |
| `WUNDERLAND_ATTACH_DEADLINE_MS` | Per-operation deadline (default 45000). |

## License

Apache-2.0
