# Google Chat channel

This pack gives an agent a text messaging tool and an inbound webhook adapter for Google Workspace Chat. It uses the Google Chat API with `google-auth-library` for service account authentication and webhook token verification.

## Installation

```bash
npm install @framers/agentos-ext-channel-google-chat
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-google-chat',
        options: {
          serviceAccountJson: process.env.GOOGLECHAT_SERVICE_ACCOUNT
            ?? process.env.GOOGLE_CHAT_SERVICE_ACCOUNT,
          audienceType: process.env.GOOGLE_CHAT_AUDIENCE_TYPE,
          audience: process.env.GOOGLE_CHAT_AUDIENCE,
          webhookPath: process.env.GOOGLE_CHAT_WEBHOOK_PATH,
        },
      },
    ],
  },
});
```

## Configuration

The service account resolves from options, then `options.secrets`, then environment variables. Provide its JSON content as a string.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `serviceAccountJson` | `googlechat.serviceAccount` | `GOOGLECHAT_SERVICE_ACCOUNT`, `GOOGLE_CHAT_SERVICE_ACCOUNT` | Yes | None; throws when missing |
| `webhookPath` | None | `GOOGLE_CHAT_WEBHOOK_PATH` | No | `/google-chat-webhook` |
| `audienceType` | None | `GOOGLE_CHAT_AUDIENCE_TYPE` | Yes, for inbound POST requests | `null` |
| `audience` | None | `GOOGLE_CHAT_AUDIENCE` | Yes, for inbound POST requests | `''` |
| `addOnProjectNumber` | None | `GOOGLE_CHAT_ADDON_PROJECT_NUMBER` | No | Unset: no add-on is accepted |
| `maxBodyBytes` | None | None | No | `1048576` |
| `priority` | None | None | No | `50` |
| `secrets` | None | None | No | Unset |

For `app-url`, the audience is the full webhook URL. For `project-number`, it is the numeric Google Cloud project number. Audience type resolution also accepts `app_url`, `app`, `project_number` and `project`. Invalid or nonpositive `maxBodyBytes` values use the default.

## Tools

| Tool | What it does |
| --- | --- |
| `googleChatChannelSendMessage` | Sends a text message through the Google Chat adapter. |

### `googleChatChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | Yes | Target space name (e.g., `spaces/AAA...`) |
| `text` | string | Yes | Message text |

## Channel adapter

The adapter registers platform `google-chat`. Activation marks the service connected. Sending obtains a service account access token with the `https://www.googleapis.com/auth/chat.bot` scope and posts the first text block to the conversation's space.

The `googleChatWebhook` HTTP handler verifies bearer tokens, acknowledges accepted JSON payloads and dispatches `MESSAGE` events with nonempty space names and text. A `DM` space maps to a direct conversation; other space types map to group conversations. It remembers inbound message thread names, and `replyToMessageId` uses the remembered thread for adapter replies. Typing indicators do nothing.

## Notes

Sending creates remote messages. Missing service account JSON or invalid JSON fails during pack creation. Sending before activation, with an empty space name or text, or without an access token fails.

Webhook GET requests return a health response. POST requests are unavailable without a valid audience type and audience. Failed token verification is rejected as unauthorized. Other HTTP methods are rejected. Oversized bodies and invalid JSON are rejected. The webhook path gains a leading slash and loses a trailing slash.

The `app-url` verification path requires a verified email from Google Chat's own service account, or from the Workspace add-on service account of the project `addOnProjectNumber` names (`service-<number>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`). Without `addOnProjectNumber`, add-on requests are refused. The `project-number` path verifies the signed JWT with the Chat issuer's certificates. Thread mappings have a bounded cache and are cleared at shutdown.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
