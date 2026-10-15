---
"@framers/agentos-ext-account-sources": patch
---

Keep counting a recovery whose anchor read keeps failing: after expired history, the anchor read continues the attempt count of the history page that found the expiry, so the count reaches five attempts and the `pollMs` wait instead of the anchor read retrying every second or two. `exclude` and `resetExclusions` keep the committed cursor and make a reconcile the next cycle, which replays history from that cursor after a fresh bounded scan. A reconcile asks for the committed cursor's history before its scan and, when that history has expired, replays from its anchor with one scan and one read pass.
