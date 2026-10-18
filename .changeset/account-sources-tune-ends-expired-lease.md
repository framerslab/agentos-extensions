---
'@framers/agentos-ext-account-sources': patch
---

A tune (`policy_tuned`) ends a lease that is past its time by the store's clock, as a claim replaces one, so a worker whose clock runs behind the tuner's holds a handle no later call accepts: its next call, and the end of a request it already has in flight, are refused, and neither can be handed on as a lost grant once a provider sees the new policy. A scan that goes on keeps the `scanPageSize` its next page token was read under as the checkpoint's new optional `pageTokenSize`, and a tune that lowers `scanPageSize` below that size ends the open scan as a bounded scan ends, since a provider may answer the token at the size it was issued for; a size raised and lowered again ends it only below the token's own size. The docs say that a tune stores the whole policy it is given, so of two tunes made from one snapshot the later one's policy stands, and that a tune to the stored policy answers the snapshot under a live lease too.
