---
'@framers/agentos-ext-gmail-source': patch
---

A `multipart/alternative` whose plain part is blank, empty or nothing but whitespace and padding as some mailers send
it beside their HTML, gives the HTML's text: a blank branch yields to the next one, and a plain part that holds text
wins over HTML as before. Label names from the labels response are sanitized as written and never decoded as RFC 2047
words, so a label such as `Research =? backlog` no longer drops every message that carries it as `invalid_encoding`,
or skips a thread of such messages. At the thread cap each retained message keeps its own cut: the first message that
does not fit whole in what `maxThreadCharacters` has left, and every older one, is counted under `thread_limit`, where
the oldest kept message used to be cut to fit. A reply near the cap leaves the text of every message a stored copy
holds unchanged, so the account-source store charges the reply, not that message's overlapping text again. A thread
whose normalized text changes this way (one that held a cut message, a blank plain alternative or such a label) gets a
new `contentHash` and version, and the store writes its copy again at the next read.
