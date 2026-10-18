---
'@framers/agentos-ext-document-export': patch
---

The archive reader's open computes an entry name's CRC-32 once, however many Info-ZIP Unicode Path fields its directory record carries, instead of once a field, so a crafted directory no longer costs the open time in the product of each record's name and extra field lengths.
