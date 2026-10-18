---
'@framers/agentos-ext-account-sources': patch
---

A tune (`policy_tuned`) ends a lease that is past its time by the store's clock, as a claim replaces one, so a worker whose clock runs behind the tuner's holds a handle no later call accepts, and a request it makes under the old policy can no longer reach a provider's check of the new one and be handed on as a lost grant. A tune that lowers `scanPageSize` ends an open scan that still holds a page token, which was issued for the larger pages and which a provider may answer at that size, as a bounded scan ends. The docs say that a tune stores the whole policy it is given, so of two tunes made from one snapshot the later one's policy stands, and that a tune to the stored policy answers the snapshot under a live lease too.
