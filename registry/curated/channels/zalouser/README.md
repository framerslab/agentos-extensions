# Zalo personal channel

This pack gives an agent direct and group text messaging through a Zalo personal account using the unofficial `zca-cli` bridge. It sends messages through CLI commands and receives JSON lines from the CLI listener.

## Installation

```bash
npm install @framers/agentos-ext-channel-zalouser
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-zalouser',
        options: {
          profile: process.env.ZCA_PROFILE,
          cliPath: process.env.ZCA_CLI_PATH,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `profile` | None | `ZCA_PROFILE` | No | `default` |
| `cliPath` | None | `ZCA_CLI_PATH` | No | `zca` |
| `enableReceive` | None | None | No | `true` |
| `priority` | None | None | No | `20` |

Profile and CLI path resolve from trimmed nonempty options, then trimmed environment variables, then defaults. The pack reads no secrets.

## Tools

| Tool | What it does |
| --- | --- |
| `zalouserSendMessage` | Send a text message through a Zalo personal account using `zca-cli`. |

### `zalouserSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target thread id. Use `group:<threadId>` for group threads. |
| `text` | string | Yes | Message text. |

The input schema disallows additional properties.

## Channel adapter

The adapter registers platform `zalouser`. Activation starts `zca --profile <profile> listen -r -k` unless `enableReceive` is `false`. The listener parses newline-delimited JSON and emits direct or group text events. Group conversation IDs use `group:<threadId>`. Non-JSON lines and messages without a thread ID or nonempty content are ignored.

Sending requires a text block and runs `zca --profile <profile> msg send <threadId> <text>`, adding `-g` for group targets. Outbound message IDs are generated locally. Typing indicators do nothing. Shutdown terminates the listener with `SIGTERM`.

## Notes

The host needs the `zca` executable and an authenticated account, established through `zca auth login`. The pack does not install the CLI or perform login. Missing CLI or listener failures are recorded in connection status and logged when a logger is provided.

Sending posts through the personal account, trims text and truncates it to `2000` characters. Empty text, empty conversation IDs and empty `group:` targets are rejected. Send processes have a `60000` ms timeout and are killed with `SIGKILL` if it expires. Failed sends return an error derived from CLI output.

When the listener exits while the service is running, the code attempts a restart after `2000` ms. Setting `enableReceive` to `false` keeps outbound messaging available and disables the listener.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
