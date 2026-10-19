---
'@framers/agentos-ext-gmail-source': minor
---

`excludedCategories`, on `GmailApi` and on the thread mapper's read options, leaves Gmail's inbox tabs out of a
mailbox's copy by their `category:` names (`promotions`, `social`, `updates`, `forums`; none by default): the scan
query carries `-category:<name>` for each, a history record that adds a message carrying the category's label names no
thread to read for that addition (a deletion or a label change still does), and the mapper leaves such messages out of
the copy under `excluded_category`. A label change that keeps a message inside the excluded tabs (a move between two of
them in one record, a star) names no thread either, and a generic `messages` entry beside a typed event is decided by
it, so a mailbox whose tabs churn stops being re-read and re-charged for mail the host never shows; the addition half
of a move Gmail splits into two records still reads once, charged nothing. `GMAIL_CATEGORIES` and the
`GmailCategory` type are exported.
