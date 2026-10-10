# @framers/agentos-ext-channel-email

## 0.2.0

### Minor Changes

- [#111](https://github.com/framerslab/agentos-extensions/pull/111) [`d4c78ff`](https://github.com/framerslab/agentos-extensions/commit/d4c78ffbcab1b73542983b826e038ca9607c2ef8) Thanks [@jddunn](https://github.com/jddunn)! - Send through Resend's HTTPS API as well as SMTP: a `resend` transport with an idempotency key, the text and HTML parts in one call, Resend's error shape (`EmailApiError` with the status and the error's name) and its retry terms inside one deadline. A `from` with a display name for both transports. nodemailer 10 for SMTP. nodemailer 9.0.0 and later check TLS certificates when they fetch remote content, so an attachment given as an https `path` to a host with a self-signed, expired or mismatched certificate now fails. nodemailer 8.0.0 renamed the error code `NoAuth` to `ENOAUTH`. The `@framers/agentos` peer is now optional, since the pack imports nothing from it. The `emailSend` tool and the channel adapter no longer read files on this machine, and through SMTP no longer fetch addresses, for attachments a model names: they refuse such an attachment before sending.

## 0.1.2

### Patch Changes

- [#75](https://github.com/framerslab/agentos-extensions/pull/75) [`0767c67`](https://github.com/framerslab/agentos-extensions/commit/0767c676ef76c716d794b5fc40ec061b60fd9566) Thanks [@jddunn](https://github.com/jddunn)! - Declare `@framers/agentos` as a peer with a floor and no upper bound (`>=0.10.40`), so npm installs the pack next to agentos 0.11 and later releases. The published range (`^0.10.x` or older) excluded them.

## 0.1.1

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Ship the compiled output. The previous version was published without its `dist` directory, so the package could not be loaded.
