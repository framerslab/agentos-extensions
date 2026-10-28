---
'@framers/agentos-ext-account-sources': patch
'@framers/agentos-ext-google-drive': minor
---

A file past the byte caps is answered `too_large`, a new `SourceGone` reason, where it was answered `removed`: its content past `maxFileBytes` (its stated size, a download that declares more, or the bytes read), and an export Google refuses with `exportSizeLimitExceeded`. The file is still in the account and readable by the grant, so a caller may keep the copy it read before; a caller that deleted a copy on any gone reason deleted a file that had only grown past the cap.

A Google Doc is read through the new `exportDoc`: its Markdown without the pictures Google's export embeds as data addresses (each `[imageN]: <data:image/...>` definition goes, and each image that names one stands as its alternative text), and its text (`text/plain`) when Google refuses the Markdown past its 10 MB or the Markdown is past `maxFileBytes`. Google's Markdown export carries every picture of a Doc as base64, so a Doc of short text and large pictures was read with the base64 as its text, or answered past the caps on its pictures alone. `exportPastCap(error)` answers whether an export failed on a byte cap, and `withoutEmbeddedPictures(markdown)` takes the same pictures out of Markdown a caller already holds.
