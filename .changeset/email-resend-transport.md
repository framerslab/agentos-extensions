---
'@framers/agentos-ext-channel-email': minor
---

Send through Resend's HTTPS API as well as SMTP: a `resend` transport with an idempotency key, the text and HTML parts in one call, Resend's error shape (`EmailApiError` with the status and the error's name) and its retry terms inside one deadline. A `from` with a display name for both transports. nodemailer 10 for SMTP. nodemailer 9.0.0 and later check TLS certificates when they fetch remote content, so an attachment given as an https `path` to a host with a self-signed, expired or mismatched certificate now fails. nodemailer 8.0.0 renamed the error code `NoAuth` to `ENOAUTH`. The `@framers/agentos` peer is now optional, since the pack imports nothing from it. The `emailSend` tool and the channel adapter no longer read files on this machine, and through SMTP no longer fetch addresses, for attachments a model names: they refuse such an attachment before sending.
