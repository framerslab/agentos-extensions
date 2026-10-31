# SMS channel

This pack gives an agent an SMS sending tool and a channel adapter using the `twilio` SDK. It receives inbound Twilio Messaging webhooks through an HTTP handler with signature verification.

## Installation

```bash
npm install @framers/agentos-ext-channel-sms
```

Peer dependency: `@framers/agentos` at `>=0.10.40`.

## Usage

```ts
import { AgentOS } from '@framers/agentos';

const agentos = await AgentOS.create({
  extensionManifest: {
    packs: [
      {
        package: '@framers/agentos-ext-channel-sms',
        options: {
          accountSid: process.env.TWILIO_ACCOUNT_SID,
          authToken: process.env.TWILIO_AUTH_TOKEN,
          phoneNumber: process.env.TWILIO_PHONE_NUMBER,
          webhookPath: process.env.TWILIO_SMS_WEBHOOK_PATH,
          webhookUrl: process.env.TWILIO_SMS_WEBHOOK_URL,
          publicBaseUrl: process.env.TWILIO_SMS_PUBLIC_BASE_URL,
        },
      },
    ],
  },
});
```

## Configuration

Credentials resolve from options, then `options.secrets`, then the environment.

| Option | Secret id | Environment variable | Required | Default |
| --- | --- | --- | --- | --- |
| `accountSid` | `twilio.accountSid` | `TWILIO_ACCOUNT_SID` | yes | None |
| `authToken` | `twilio.authToken` | `TWILIO_AUTH_TOKEN` | yes | None |
| `phoneNumber` | `twilio.phoneNumber` | `TWILIO_PHONE_NUMBER` | yes | None |
| `webhookPath` | None | `TWILIO_SMS_WEBHOOK_PATH` | no | `/webhooks/twilio/sms` |
| `webhookUrl` | None | `TWILIO_SMS_WEBHOOK_URL` | no | Reconstructed from base URL and request |
| `publicBaseUrl` | None | `TWILIO_SMS_PUBLIC_BASE_URL` | no | Request forwarded protocol and host headers, then HTTP and host header, then localhost |
| `skipSignatureValidation` | None | `TWILIO_SMS_SKIP_SIGNATURE_VALIDATION` | no | `false` |
| `maxBodyBytes` | None | None | no | `1024 * 1024` bytes |
| `priority` | None | None | no | `50` |
| `secrets` | Credential ids above | None | no | None |

## Tools

| Tool | What it does |
| --- | --- |
| `smsChannelSendMessage` | Sends an SMS through Twilio to a phone number. |

### `smsChannelSendMessage`

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `conversationId` | string | yes | Recipient phone number (E.164) |
| `text` | string | yes | Message text |

## Channel adapter

The adapter registers platform `sms`. Activation creates a Twilio client with the account credentials. Sending takes the first text block and sends it from `phoneNumber` to the recipient in `conversationId`. Inbound delivery uses the host HTTP server: the handler accepts POST requests with form or JSON payloads, verifies signatures and acknowledges with an empty XML response. It emits nonempty message bodies with the sender's phone number as the direct conversation id. Typing indicators do nothing.

## Notes

Sending calls Twilio's message creation API. Missing `accountSid`, `authToken` or `phoneNumber` makes pack creation throw. Sends require a nonempty recipient and message text.

`webhookUrl` overrides URL reconstruction for signature verification. Otherwise, the handler uses `publicBaseUrl` or request headers. Signature verification is skipped when the option is `true` or the environment setting is a case-insensitive true, yes or numeric one, even if the option is `false`. Oversized webhook bodies are rejected. Media-only inbound messages without text are ignored.

## Releases

Each version is published from [framerslab/agentos-extensions](https://github.com/framerslab/agentos-extensions) by GitHub Actions through npm trusted publishing, with a provenance statement.

## License

Apache-2.0
