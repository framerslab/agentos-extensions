---
'@framers/agentos-ext-channel-email': minor
---

Send through Resend's HTTPS API as well as SMTP: a `resend` transport with an idempotency key, the text and HTML parts in one call, Resend's error shape (`EmailApiError` with the status and the error's name) and its retry terms inside one deadline. A `from` with a display name for both transports. nodemailer 10 for SMTP. The `@framers/agentos` peer is now optional, since the pack imports nothing from it.
