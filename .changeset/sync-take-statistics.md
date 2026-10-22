---
'@framers/agentos-ext-account-sources': patch
---

`takeWork` reads one work row a take whatever PostgreSQL's statistics say. Its two looks, the first pending item and the retry whose wait passed first, are bounded by the work indexes' columns alone and ordered by their keys, and the row found is checked for the cycle and the generation after the read (a due row of another is a stale state). With the cycle's condition in the look, the statistics autoanalyze takes after a page writes its rows (every row pending) made a read of the whole connection and a sort look as cheap as the index, so each take read every row and a cycle of n queued reads read about n squared rows.
