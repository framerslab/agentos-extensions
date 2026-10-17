---
'@framers/agentos-ext-document-export': patch
---

The archive reader refuses an entry at the first step that inflates past its recorded size, stops reading an entry once its DEFLATE stream has ended, opens an archive of exactly 65,535 entries written without ZIP64, and refuses a Blob that cannot be read with a fixed `format` message.
