---
'@framers/agentos-ext-channel-email': minor
---

The configuration takes `authServId`, the authserv-id of the host that takes mail into the mailbox the service reads, such as `mx.google.com` (the pack's option `authServId`, the secret `email.authServId` or `EMAIL_AUTH_SERV_ID`). A read that names no `authServId` reads under it, and so do the `emailRead` and `emailSearch` tools, which leave `authentication` out of their answers when the configuration names none: a model cannot name the receiving host, and a read that names none counts the topmost Authentication-Results field whatever host it names, which on a host that writes no field of its own is one the sender wrote. A configured `authServId` that is not text, holds a control character or is white space alone throws an `Error` when the service is made.
