# Gmail email

This pack gives an agent message listing, reading, sending, replies, search and label inspection through the Google Gmail API using `googleapis` and OAuth2.

## Installation

```bash
npm install @framers/agentos-ext-email-gmail
```

Peer dependency: `@framers/agentos` `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-email-gmail',
        options: {
          clientId: process.env.GOOGLE_CLIENT_ID || process.env.GMAIL_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET || process.env.GMAIL_CLIENT_SECRET,
          refreshToken: process.env.GOOGLE_REFRESH_TOKEN || process.env.GMAIL_REFRESH_TOKEN,
        },
      },
    ],
  },
});
```

## Configuration

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `clientId` | `google.clientId` | `GOOGLE_CLIENT_ID`, then `GMAIL_CLIENT_ID` | Yes | No default |
| `clientSecret` | `google.clientSecret` | `GOOGLE_CLIENT_SECRET`, then `GMAIL_CLIENT_SECRET` | Yes | No default |
| `refreshToken` | `google.refreshToken` | `GOOGLE_REFRESH_TOKEN`, then `GMAIL_REFRESH_TOKEN` | Yes | No default |
| `priority` | | | No | `50` |
| `secrets` | | | No | No map |
| Context `logger` | | | No | No logger |

Nonempty credential options precede `options.secrets`, followed by environment fallbacks in the order shown. The logger receives activation and deactivation messages.

## Tools

| Tool | What it does |
| --- | --- |
| `gmailListMessages` | Lists message summaries with query, label and result filters. |
| `gmailReadMessage` | Reads a message's subject, sender, recipients, date, body and labels. |
| `gmailSendMessage` | Sends a plain text email with To, CC and BCC recipients. |
| `gmailReplyMessage` | Replies within a thread with reply headers and a `Re:` subject prefix. |
| `gmailSearchMessages` | Searches messages using Gmail search syntax. |
| `gmailListLabels` | Lists labels with types and message counts. |

### `gmailListMessages`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | No | Gmail search query (e.g. "is:unread", "from:alice@example.com", "subject:invoice"). Uses standard Gmail search syntax. |
| `labelIds` | array of strings | No | Filter by label IDs (e.g. ["INBOX", "UNREAD"]) |
| `maxResults` | number | No | Maximum number of messages to return (default: 10, max: 100) |

### `gmailReadMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `messageId` | string | Yes | The Gmail message ID to read |

### `gmailSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `to` | string | Yes | Recipient email address (comma-separated for multiple) |
| `subject` | string | Yes | Email subject line |
| `body` | string | Yes | Email body text (plain text) |
| `cc` | string | No | CC recipients (comma-separated email addresses) |
| `bcc` | string | No | BCC recipients (comma-separated email addresses) |

### `gmailReplyMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `messageId` | string | Yes | The Gmail message ID to reply to |
| `body` | string | Yes | Reply body text (plain text) |

### `gmailSearchMessages`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | Yes | Gmail search query using Gmail search syntax (e.g. "from:alice@example.com", "subject:invoice has:attachment", "is:unread after:2024/06/01") |
| `maxResults` | number | No | Maximum number of results to return (default: 10, max: 100) |

### `gmailListLabels`

The input schema has no parameters.

## Notes

The package requires Node.js `>=22`. Missing OAuth credentials make the factory throw. Activation initializes the OAuth client with the refresh token; service operations require initialization. The pack also registers the service as `gmailService` with kind `productivity`.

Sending and replying transmit email from the authenticated account. Replies address the original `From` header, use the original thread, and set `In-Reply-To` and `References` from its message ID header. Bodies are sent as plain text.

Listing and search clamp `maxResults` to the range from `1` to `100`. They fetch full messages before returning summaries without the body. Reading extracts plain text or strips tags from HTML. Label detail failures return the basic label without message counts. Tool failures return `success: false` and an `error` message.

## Releases

New versions are published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
