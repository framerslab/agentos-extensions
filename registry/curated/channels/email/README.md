# @framers/agentos-ext-channel-email

Email for AgentOS. `EmailService` sends mail through SMTP or Resend's HTTPS API, and reads, searches, extracts codes from and replies to mail through IMAP. The pack's factory wraps the service in a messaging-channel adapter and five tools for an agent.

## Installation

```bash
npm install @framers/agentos-ext-channel-email
```

It needs Node.js 20 or later, the floor of nodemailer 10. Its runtime dependencies are [nodemailer](https://github.com/nodemailer/nodemailer) for SMTP and [imapflow](https://github.com/postalsys/imapflow) for IMAP. `@framers/agentos` is an optional peer, needed only when an agent loads the pack: nothing in the pack imports it, so `EmailService` works without it.

## Sending through SMTP

```ts
import { EmailService } from '@framers/agentos-ext-channel-email';

const email = new EmailService({
  smtp: { host: 'smtp.example.com', user: 'hello@example.com', password: process.env.SMTP_PASSWORD ?? '' },
  from: 'Example <hello@example.com>',
});
await email.initialize();
await email.sendEmail({ to: 'reader@example.com', subject: 'Hello', body: 'Plain words.', html: '<p>Plain words.</p>' });
```

`smtp` takes `host`, `user` and `password`, with `port` and `secure`: by default the connection uses TLS on port 465, and `secure: false` moves the default port to 587. `initialize()` checks the connection, and a failed check is not an error. The pack's factory reads the account from the secrets `email.smtpHost`, `email.smtpUser` and `email.smtpPassword`, or from `SMTP_HOST`, `SMTP_USER` and `SMTP_PASSWORD`.

## Sending through Resend

```ts
import { EmailService } from '@framers/agentos-ext-channel-email';

const email = new EmailService({
  resend: { apiKey: process.env.RESEND_API_KEY ?? '' },
  from: 'Example <hello@example.com>',
});
await email.initialize();
const { messageId } = await email.sendEmail({
  to: 'reader@example.com',
  subject: 'Hello',
  body: 'Plain words.',
  html: '<p>Plain words.</p>',
  replyTo: 'team@example.com',
  idempotencyKey: 'welcome-reader-1',
});
```

Each message goes out as `POST /emails` with the key as the bearer and the text and HTML parts in the same call, and `messageId` is the id Resend gives the email. A refusal that is tried again repeats the same request, with the same key and any `Idempotency-Key`, so one send makes at most `maxRetries + 1` requests. `idempotencyKey` is sent as Resend's `Idempotency-Key` header: another request under the same key within 24 hours delivers nothing more ([idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)). Keep it to 256 characters at most and free of personal data. SMTP ignores it.

| `resend` option | Default | What it sets |
|---|---|---|
| `apiKey` | required | The API key, or a function that returns it at each send, so a rotated key applies without a restart |
| `baseUrl` | `https://api.resend.com` | The API's origin, such as a proxy's or a test server's |
| `userAgent` | `agentos-ext-channel-email` | The `User-Agent` of every request; Resend refuses a request without one |
| `timeoutMs` | 15,000 | The longest one send may take, its retries and their waits included |
| `maxRetries` | 2 | The most retries one send makes |

The pack's factory sends through Resend when it has a Resend key and no SMTP host: the option `resendApiKey`, the secret `email.resendApiKey` or `RESEND_API_KEY`, with `resendBaseUrl` for the origin. Given an SMTP host, it keeps SMTP.

## The From

`from` sets the From header of both transports, and a display name is allowed (`Example <hello@example.com>`). With SMTP it falls back to the SMTP user; with Resend it is required, and `initialize()` throws without it. Replies are sent from it too. The pack's factory reads it from the option `from`, then from `EMAIL_FROM`.

## Errors and retries

A refusal from Resend throws `EmailApiError`, with `status` (the HTTP status), `type` (Resend's error name, such as `validation_error`, or `unknown` when the answer's body is not JSON, names no error, or names one that is not 1 to 64 letters, digits, `_`, `.`, `:` or `-`) and `retryAfterSeconds` (the answer's `retry-after`, or `null`). Its message names the status and the type and never carries Resend's message, which can quote an address.

`fetch`'s own errors pass through as it throws them: a `TypeError` when the connection fails, and a `TimeoutError` when `timeoutMs` passes before an answer comes. A deadline that passes while an answer's body is being read throws no `TimeoutError`: a refusal then throws `EmailApiError` with `type` `unknown`, and an accepted send resolves with an empty `messageId`. The key is trimmed at each send, and a key that still holds a control character, such as a line break inside it, throws an `Error` before any request; its message names no part of the key.

A send is tried again only on the terms of Resend's [errors](https://resend.com/docs/api-reference/errors) and [rate limit](https://resend.com/docs/api-reference/rate-limit) pages, as `retryWaitSeconds` decides:

- `rate_limit_exceeded` (429): always, since nothing was sent;
- `concurrent_idempotent_requests` (409) and any 5xx, such as `application_error` (500) and `service_unavailable` (503): only when the send has an `idempotencyKey`, so a retry cannot deliver twice;
- never `daily_quota_exceeded` or `monthly_quota_exceeded` (both 429), `validation_error`, `invalid_idempotent_request` or any other 4xx.

The wait is the answer's `retry-after` when it has one, else as many seconds as the retry's number: one, then two. A send makes at most `maxRetries` retries, and a wait that would pass the deadline is not taken: the refusal is thrown instead.

## Reading mail

`readInbox`, `searchEmails`, `extractCodes` and `replyToEmail` read through IMAP: the `imap` account (`host`, `user` and `password`, with `port` and `secure`, by default TLS on port 993), or the SMTP account when `imap` is not given. With Resend, reading needs `imap`. A reply goes out through the transport that sends, threaded with `In-Reply-To` and `References`. The pack's factory reads the account from the secrets `email.imap.host`, `email.imap.user` and `email.imap.password`, or from `IMAP_HOST`, `IMAP_USER` and `IMAP_PASSWORD`.

## In an agent

`createExtensionPack(context)` returns five tools, `emailSend`, `emailRead`, `emailSearch`, `emailExtractCodes` and `emailReply`, and the messaging channel `emailChannel`. Its options (`smtpHost`, `smtpUser`, `smtpPassword`, `smtpPort`, `smtpSecure`, `imapHost`, `imapUser`, `imapPassword`, `imapPort`, `imapSecure`, `resendApiKey`, `resendBaseUrl`, `from`) take precedence over the secrets and the environment variables named above. `manifest.json` lists the SMTP secrets as required, and the IMAP secrets and `email.resendApiKey` as optional.

## API

| Export | What it is |
|---|---|
| `createExtensionPack(context)` | The pack's factory: the five tools and the channel adapter |
| `EmailService` | Sends through SMTP or Resend's HTTPS API; reads, searches, extracts codes and replies through IMAP |
| `ResendTransport` | Resend's send call, which `EmailService` uses when its configuration names `resend` |
| `EmailApiError`, `retryWaitSeconds` | A refusal from Resend, and the wait before its retry (`null` for none) |
| `EmailChannelAdapter` | The messaging-channel adapter |
| `EmailSendTool`, `EmailReadTool`, `EmailSearchTool`, `EmailExtractCodesTool`, `EmailReplyTool` | The five tools |
| `EmailConfig`, `SendEmailOptions`, `EmailMessage`, `SearchEmailOptions`, `ResendOptions`, `OutgoingEmail`, `OutgoingAttachment`, `EmailChannelOptions`, `ExtensionContext`, `ExtensionPack` | The types of the configuration, the messages, the options and the pack |

## License

Apache-2.0
