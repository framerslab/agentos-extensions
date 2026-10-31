# Microsoft Teams channel

This pack gives an agent a text messaging tool and a Microsoft Teams channel adapter. It uses the Bot Framework through `botbuilder`, receiving HTTP webhook activities and sending proactive messages through stored conversation references.

## Installation

```bash
npm install @framers/agentos-ext-channel-teams
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-teams',
        options: {
          appId: process.env.TEAMS_APP_ID,
          appPassword: process.env.TEAMS_APP_PASSWORD,
          webhookPath: process.env.TEAMS_WEBHOOK_PATH,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then the environment names below in order.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `appId` | `teams.appId` | `TEAMS_APP_ID`, `MICROSOFT_APP_ID` | yes | None |
| `appPassword` | `teams.appPassword` | `TEAMS_APP_PASSWORD`, `MICROSOFT_APP_PASSWORD` | yes | None |
| `webhookPath` | None | `TEAMS_WEBHOOK_PATH` | no | `/teams-webhook` |
| `maxBodyBytes` | None | None | no | `1024 * 1024` bytes |
| `priority` | None | None | no | `50` |
| `secrets` | Credential ids above | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `teamsChannelSendMessage` | Sends a text message through the Microsoft Teams channel adapter. |

### `teamsChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Target Teams conversation id |
| `text` | string | yes | Message text |

## Channel adapter

The adapter registers platform `teams`. Activation marks the service connected; inbound delivery uses the host HTTP server and Bot Framework activity processing. The handler emits nonempty text from message activities with a conversation id, marking conversations as group or direct from the activity. It stores conversation references for proactive sends. Outbound sends use the first text block and continue the stored conversation. Typing indicators do nothing.

## Notes

Sending delivers a Teams message. Missing `appId` or `appPassword` makes pack creation throw. A target conversation needs a stored reference from an inbound text message during the process lifetime; otherwise sending fails. Deactivation clears those references.

The reference cache holds up to `5000` conversations and removes the earliest stored entry when it exceeds that limit. The webhook handler rejects bodies above `maxBodyBytes` and invalid JSON.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
