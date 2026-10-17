---
"@framers/agentos-ext-document-export": patch
---

`captureDrop` opens a dropped file through the item's other providers when one cannot open it: a file handle whose file cannot be read falls back to the item's legacy file entry, then to its plain file, instead of leaving the whole drop unreadable. The first provider that answers still decides whether an item is a directory, a directory is never replaced by another provider's answer, and a plain file still never stands in for an item whose directory provider failed.
