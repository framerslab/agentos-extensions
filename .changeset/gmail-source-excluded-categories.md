---
'@framers/agentos-ext-gmail-source': minor
---

`excludedCategories`, on `GmailApi` and on the thread mapper's read options, leaves Gmail's inbox tabs out of a
mailbox's copy by their `category:` names (`promotions`, `social`, `updates`, `forums`; none by default): the scan
query carries `-category:<name>` for each, a history record that adds a message carrying the category's label names no
thread to read for that addition (a deletion or a label change still does), and the mapper leaves such messages out of
the copy under `excluded_category`. A message that moves between two excluded tabs no longer changes the copy, so a
mailbox whose tabs churn stops being re-read and re-charged for mail the host never shows. `GMAIL_CATEGORIES` and the
`GmailCategory` type are exported.
