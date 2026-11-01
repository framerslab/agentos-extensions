# Signal channel

This pack gives an agent a text messaging tool and a channel adapter for Signal direct and group messages. It invokes `signal-cli` to send messages and receive JSON envelopes.

## Installation

```bash
npm install @framers/agentos-ext-channel-signal
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-signal',
        options: {
          phoneNumber: process.env.SIGNAL_PHONE_NUMBER,
          cliPath: process.env.SIGNAL_CLI_PATH,
        },
      },
    ],
  },
});
```

## Configuration

The phone number resolves from `phoneNumber`, then `options.secrets`, then the environment. `cliPath` resolves from the option, then the environment.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `phoneNumber` | `signal.phoneNumber` | `SIGNAL_PHONE_NUMBER` | yes | None |
| `cliPath` | None | `SIGNAL_CLI_PATH` | no | `signal-cli` |
| `enableReceive` | None | None | no | `true` |
| `priority` | None | None | no | `50` |
| `secrets` | `signal.phoneNumber` | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `signalChannelSendMessage` | Sends a text message through the Signal adapter using `signal-cli`. |

### `signalChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Recipient (+E164) or `group:<groupId>` |
| `text` | string | yes | Message text |

## Channel adapter

The adapter registers platform `signal`. It sends the first text block to a recipient or a group identified by `group:<groupId>`. Activation starts `signal-cli receive --json` unless `enableReceive` is `false`. It parses newline-delimited JSON envelopes and emits nonempty text messages with a sender, using the group id or sender as the conversation id. Typing indicators do nothing.

## Notes

The host needs `signal-cli` installed and a linked account phone number. Sending invokes the external program and delivers a Signal message. Missing `phoneNumber` makes pack creation throw; sending requires a nonempty target and text.

Send processes are killed after `60000` ms. When the receive process closes while the service is running, the service schedules a restart after `5000` ms. Deactivation terminates the receiver.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
