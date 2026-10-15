---
'@framers/agentos-ext-channel-email': minor
---

`sendEmail` takes `headers`, header fields to add to the message by name, such as `List-Unsubscribe` and `List-Unsubscribe-Post` for a one-click unsubscribe (RFC 8058). Through Resend they go in the request's `headers`; through SMTP nodemailer writes each into the message. `headers` is a plain object: a name must be printable US-ASCII with no space or colon, the field name of RFC 5322, and a value a string with no line break or other control character than the tab, so no field given can end and start another. An object value, such as one marked `prepared`, which nodemailer writes into the message as it is, is refused.

The fields never replace the service's own. `From`, `To`, `Cc`, `Bcc`, `Reply-To`, `Subject`, `Date`, `Message-ID`, `MIME-Version` and any `Content-` field are refused in any case, where nodemailer would have kept one of the two values without a word, and a name given twice in different cases is refused too. Each refusal throws an `Error` before either transport is used, naming the field, or its place when its name is at fault, and none of its value. Each value is read once and the fields are sent as read; nodemailer gets them as a list, so an object with `key` and `value` properties adds two fields of those names. A send without `headers` is unchanged.

`ResendTransport.send` checks a message's `headers` by the same rules for names and values before any request. A reply through Resend whose message id holds a line break now throws that `Error` instead of sending the id in `In-Reply-To` and `References`.
