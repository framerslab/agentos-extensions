---
'@framers/agentos-ext-account-sources': patch
---

A read of a copy the store holds is weighed against the indexing allowance and charged by its new and changed
messages. The store keeps the SHA-256 of each message's text on the copy's spans (`textHash`, optional on the new
`SourceSyncStoredMessageSpan` type of `SourceSyncStoredDocument.messages`). A read message the copy holds with the same
id, text hash, cut and length is free, and so is the text before it (its separator and any header lines, such as a
Gmail thread's) when that text is the copy's and the message before it is the one the copy has there (`leadHash` on
each span). A reply is charged its separator and text, a message edited in place is charged with the separator after
it, a changed header line or separator is charged, a message that follows another neighbour than it did is charged
its separator, and a read that only drops messages is charged nothing, so it is admitted with the allowance spent. At a connector's thread cap, where each reply cuts the oldest
message shorter, that message is charged again at its new length with the separator after it, and the rest of the
thread is not; with the allowance spent, such a reply removes the thread's copy until a read of it fits the allowance.
A copy whose messages keep no text hash is weighed by the hash of its whole text: a read that begins with that text is
charged what follows it, and any other read in full, as is every read of a copy with neither hash. A charge that would
come out below zero throws `invalid_source_sync_charge` and changes nothing.
