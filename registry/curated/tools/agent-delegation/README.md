# Agent delegation

This pack gives an agent tools to check remote Wunderland agents, delegate tasks and collect replies over HTTP.

## Installation

```bash
npm install @framers/agentos-ext-agent-delegation
```

Peer dependency: `@framers/agentos` with range `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [{ package: '@framers/agentos-ext-agent-delegation' }],
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
| `agent_ping` | Checks whether a remote Wunderland agent is reachable and retrieves its metadata. |
| `agent_delegate` | Sends a task or question to a remote Wunderland agent and receives its text reply. |
| `agent_broadcast` | Sends the same task to remote Wunderland agents in parallel and collects their responses. |

### `agent_ping`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | URL of the remote Wunderland agent. |
| `includePersonas` | `boolean` | No | Also fetch the list of available personas from the remote agent. |

### `agent_delegate`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | URL of the remote Wunderland agent. |
| `message` | `string` | Yes | The task, question, or instruction to send to the remote agent. |
| `secret` | `string` | No | Chat secret for the remote agent (if required). |
| `sessionId` | `string` | No | Session identifier for conversation continuity. Use the same `sessionId` across multiple calls to maintain context. |
| `personaId` | `string` | No | Target a specific persona on the remote agent. |
| `reset` | `boolean` | No | Clear the remote session history before sending this message. |
| `timeoutMs` | `integer` | No | Timeout in milliseconds. Agent tasks with tool-calling may take a while. |

### `agent_broadcast`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `message` | `string` | Yes | The task or question to broadcast to all agents. |
| `agents` | `array` of `object` | Yes | List of agent endpoints to broadcast to. |
| `sessionId` | `string` | No | Shared session ID for all agents. |
| `timeoutMs` | `integer` | No | Per-agent timeout in milliseconds. |

Each object in `agents` has this schema:

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `url` | `string` | Yes | Agent URL. |
| `secret` | `string` | No | Chat secret (if required). |
| `label` | `string` | No | Human-readable label for this agent. |
| `personaId` | `string` | No | Target persona on this agent. |

## Notes

`agent_ping` reads `/health` and optionally `/api/agentos/personas`. These requests use timeouts of `8000` ms and `5000` ms respectively. `includePersonas` defaults to `false`.

Delegation and broadcast send messages to `/chat`. A supplied `secret` becomes the `X-Wunderland-Chat-Secret` header. These calls can trigger the remote agent's tools and LLM. `reset` defaults to `false`.

Delegation and broadcast default to a `120000` ms timeout. Their schemas allow timeouts from `5000` ms to `600000` ms. Broadcast requires a nonempty target array and sets a maximum array length in its schema.

A failed ping returns `reachable: false`. A failed delegation returns `ok: false` inside a successful tool result. Broadcast reports failures per agent and still returns a successful tool result.

## License

Apache-2.0
