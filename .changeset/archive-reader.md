---
'@framers/agentos-ext-document-export': minor
---

Adds the ./archive entry: openArchive lists a ZIP's entries from its central directory, ZIP64 included, under bounds on their count and the directory's size, and each entry's bytes() reads that entry alone from its own slice, inflated in fflate's worker by default, under a cap, checked against its recorded length and CRC-32; one read at a time, stopped by a signal or close().
