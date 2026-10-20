# @framers/agentos-ext-account-sources

## 0.9.3

### Patch Changes

- [#346](https://github.com/framerslab/agentos-extensions/pull/346) [`686c889`](https://github.com/framerslab/agentos-extensions/commit/686c889b24b2f91b99379e5ffcbdd9993444b288) Thanks [@jddunn](https://github.com/jddunn)! - A quota attempt's one-second send window opens at a second reading of the clock, taken once its three budgets hold the
  weight, not at the reading that begins the reservation, so budget statements that take longer than a second on a slow
  database no longer leave every call late before it can start. The slot's record, the commit and the start's wait for
  the project's lock still come out of that second, since only the start's reading catches a process that stalled after
  the commit. A call that is late all the same gives its weight back to the three budgets through the core meters'
  refund, since nothing was sent, so a run of late starts spends none of the day's budget. A request a minute budget
  refuses is told to come back once enough of the units in that window have left it, a minute and a millisecond after
  their reservations, not a minute after the refusal. `AccountSourceSync.maintain` clears old records in the first batch
  of each walk: given the new `quota` option, it compacts the quota's day-old attempt records and settled reservations,
  again while `compact` answers `more`, ten calls at most; and it calls the lifecycle's `compact` and
  `removeDeletedOwners(limit)` when the lifecycle has them, as `SourceRevocations` does, through two new optional members
  of `SourceSyncLifecycle`. The maintenance result gains `compacted` and `removedOwners`, and a cleanup that fails counts
  in `failed`.

- [#344](https://github.com/framerslab/agentos-extensions/pull/344) [`9c21a3a`](https://github.com/framerslab/agentos-extensions/commit/9c21a3a8adbdd588d270d50edd9de60675e10770) Thanks [@jddunn](https://github.com/jddunn)! - A read that answers `gone`, or a skip the provider answers, withdraws the source's retained copy in a transaction of
  its own before the one that removes it: the copy's expiry moves to the store's clock, so `readCurrent` answers it
  expired and the fence neither commits nor delivers anything derived from it, even when the removal then fails, as when
  the host's purge throws. The next `expire` or `sweepExpired` removes a withdrawn copy, as does the read's retry. A
  page token may be up to 4,096 characters, the most Gmail's transport admits, so a token longer than the 1,024
  characters ids and cursors keep is checkpointed instead of failing its page as a storage error on every run. A
  `SourceSyncExpiryError` names the sources its `expire` removed before failing in `partial.sourceIds`, beside their
  count in `partial.removed`.

## 0.9.2

### Patch Changes

- [#339](https://github.com/framerslab/agentos-extensions/pull/339) [`1b53a15`](https://github.com/framerslab/agentos-extensions/commit/1b53a15e8966c22c4858eabe1feba66ca0cd1883) Thanks [@jddunn](https://github.com/jddunn)! - A read that drops a message of a held thread is charged nothing when the messages it keeps are unchanged: a kept
  message's neighbour is now the held message before it among those the read still holds, so the message after a dropped
  one keeps its lead free. A message that becomes the first keeps its header lines but loses its separator, so those
  lines are charged once. The docs say that the message a cap cuts is charged with the lead of the message after it (its
  separator and any header lines), and that `leadHash`, like `textHash`, confirms a guessed lead.

## 0.9.1

### Patch Changes

- [#334](https://github.com/framerslab/agentos-extensions/pull/334) [`5dbb815`](https://github.com/framerslab/agentos-extensions/commit/5dbb8153f7f596475da5dc0e2c71cb81a7c89403) Thanks [@jddunn](https://github.com/jddunn)! - A read of a copy the store holds is weighed against the indexing allowance and charged by its new and changed
  messages. The store keeps the SHA-256 of each message's text on the copy's spans (`textHash`, optional on the new
  `SourceSyncStoredMessageSpan` type of `SourceSyncStoredDocument.messages`). A read message the copy holds with the same
  id, text hash, cut and length is free, and so is the text before it (its separator and any header lines, such as a
  Gmail thread's) when that text is the copy's and the message before it is the one the copy has there, itself
  unchanged (`leadHash` on each span). A reply is charged its separator and text, a message edited in place is charged
  with the separators on both sides of it, a changed header line or separator is charged, a message that follows another neighbour than it did is charged
  its separator, and a read that only drops messages is charged nothing, so it is admitted with the allowance spent. At a connector's thread cap, where each reply cuts the oldest
  message shorter, that message is charged again at its new length with the separator after it, and the rest of the
  thread is not; with the allowance spent, such a reply removes the thread's copy until a read of it fits the allowance.
  A copy whose messages keep no text hash is weighed by the hash of its whole text: a read that repeats it (its text
  hash, or for a copy with neither hash its version and content hash, with the same length, activity time and spans)
  is free; a read that begins with that text and holds every message of the copy at the same span is charged what
  follows it; any other read is charged in full. A charge that would come out below zero throws
  `invalid_source_sync_charge` and changes nothing.

## 0.9.0

### Minor Changes

- [#321](https://github.com/framerslab/agentos-extensions/pull/321) [`d8268dd`](https://github.com/framerslab/agentos-extensions/commit/d8268dd25f7d70ac638818e3a59ba4a896060dad) Thanks [@jddunn](https://github.com/jddunn)! - Tune a connection's operating bounds without a reset. `control(scope, { type: 'policy_tuned' }, policy)` stores a policy that differs from the stored one only in the nine operating bounds `SOURCE_SYNC_OPERATING_BOUNDS` names (`scanPageSize`, `maxScanPages`, `maxCandidates`, `maxChangedPerLease`, `maxHistoryPagesPerLease`, `leaseMs`, `pollMs`, `manualMinIntervalMs` and `reconcileMs`), under the owner fence's row lock and the connection's, with no barrier and neither a new generation nor a new owner epoch: the cursor, `revalidationRequired`, progress, schedule, open cycle, retained sources, leases, fence tickets and derived results stay, so search and delivery go on. The new bounds apply from the next lease. While a lease is live the tune changes nothing and answers null, so a sync never sees its policy change under it, and a scan left open between leases that has already reached a lower `maxScanPages` or `maxCandidates` ends there, as a bounded scan ends. A tune whose policy differs in any other key, the window and the retained, held and indexed ceilings among them and any key a host adds, throws the new `SourceSyncPolicyTuneError`, whose `bounds` names those keys as the new `sourceSyncContentChanges(stored, next)` answers them; such a change still takes `policy_changed` and its reset. The state machine's `policy_tuned` event moves only `revision` and `updatedAt`, in any state.

### Patch Changes

- [#324](https://github.com/framerslab/agentos-extensions/pull/324) [`706b089`](https://github.com/framerslab/agentos-extensions/commit/706b0898b94794943cdabb4e939bb40885ab4b53) Thanks [@jddunn](https://github.com/jddunn)! - A read that begins with the text of a copy the store still holds, every message of the copy at the same span (a
  thread's read after a reply), is charged only the characters that follow the copy's text and is weighed against the
  indexing allowance by them. A long conversation is charged each reply once: a thread of 167,000 characters that takes
  replies through an afternoon is charged its replies, not its whole text at every one. A read that changes or drops any
  of the copy's text, and a copy an earlier release wrote without a text hash, are charged in full.

- [#323](https://github.com/framerslab/agentos-extensions/pull/323) [`bf2a63e`](https://github.com/framerslab/agentos-extensions/commit/bf2a63eb42bc0311232566f5b501646cbaeaa422) Thanks [@jddunn](https://github.com/jddunn)! - A tune (`policy_tuned`) ends a lease that is past its time by the store's clock, as a claim replaces one, so a worker whose clock runs behind the tuner's holds a handle no later call accepts: its next call, and the end of a request it already has in flight, are refused, and neither can be handed on as a lost grant once a provider sees the new policy. A scan that goes on keeps the `scanPageSize` its next page token was read under as the checkpoint's new optional `pageTokenSize`, and a tune that lowers `scanPageSize` below that size ends the open scan as a bounded scan ends, since a provider may answer the token at the size it was issued for; a size raised and lowered again ends it only below the token's own size. A checkpoint written before the field takes the stored policy's size, which the first tune that leaves its scan open keeps as its `pageTokenSize`. The docs say that a tune stores the whole policy it is given, so of two tunes made from one snapshot the later one's policy stands, and that a tune to the stored policy answers the snapshot under a live lease too.

## 0.8.0

### Minor Changes

- [#304](https://github.com/framerslab/agentos-extensions/pull/304) [`d29a2fa`](https://github.com/framerslab/agentos-extensions/commit/d29a2fae20150d2f6a78dcb51bc3fd2a3650c390) Thanks [@jddunn](https://github.com/jddunn)! - Sweep expired copies from every connection and remove a deleted owner's rows. `SqlAccountSourceSyncStore.sweepExpired(limit?, owner?)` removes retained sources whose expiry has passed from every connection, or one owner's, the earliest first, and answers `{ removed, failed }`; `AccountSourceSync.maintain` runs it at the start of each pass, so an expired copy no longer waits for the maintenance walk to reach its connection, and an owner whose removal or whose derived results' expiry fails is counted in `failed` and holds back no other. `expire` and the sweep now remove an expired copy also while the owner's fence is inactive, as for a suspended account, which stays inactive. `expire` still throws when a removal or the results' expiry fails; once it had removed a source, it throws the new `SourceSyncExpiryError`, with the failure's message and `cause` and, in `partial`, the sources it removed, which `maintain` counts in `expired`. `SourceRevocations.removeOwner(owner)` removes a deleted owner's rows in one transaction once its purge and its revocations are over and a day has passed since its last exchange ended: its connections with their work, provenance and exclusions (through the new `SqlAccountSourceSyncStore.removeOwner`), its stop intents, the queue rows they and its exchanges refer to, its grant leases and its exchanges. Its block marker stays, recorded as deleted and no longer pending, so `permits` stays false and the owner is refused for good, and the core fence's owner row and deletion records stay too. `removeDeletedOwners(limit?)` removes at most `limit` such owners a call, and a removal that removes rows emits the lifecycle event `removed`.

## 0.7.3

### Patch Changes

- [#303](https://github.com/framerslab/agentos-extensions/pull/303) [`7c744e8`](https://github.com/framerslab/agentos-extensions/commit/7c744e82f15eee06bc2d6eabe72861ec2da60e76) Thanks [@jddunn](https://github.com/jddunn)! - Charge only new text against the indexing allowance. `applyResult` applies a read that repeats the text and message spans of a copy the store still holds, within its expiry and window, with no indexing charge and no indexing-limit check, so a reconcile that reads every retained source again, or a change to a source's labels or history, no longer spends the month's allowance and then deletes copies as `indexing_limit`. When the read is that very copy, at the same version and content hash, the new optional `refresh` binding keeps it in place, with the results derived from it, and gives it the read's expiry and message windows; otherwise, or without the binding, the copy is written again from a fresh preparation. An `indexing_limit` skip keeps a retained copy that is still within its expiry and window and still admitted by the retained limits, when the changed read begins with that copy's text and holds every message of it at the same span, with the shorter of the two expiries, instead of deleting it. The store keeps a SHA-256 of each copy's text (`textHash`) for these checks. `AccountSourceSync` applies each read before preparing it and prepares only a document the store has to write (`applyResult` given no prepared value answers `pending` for one), so a skipped read, or with the `refresh` binding a read of the copy the store already holds, is never embedded.

## 0.7.2

### Patch Changes

- Updated dependencies [[`56bd9a6`](https://github.com/framerslab/agentos-extensions/commit/56bd9a66b6ee7ce2cb8f9a3685d523deafa1bb4d)]:
  - @framers/agentos-ext-public-sources@0.2.0

## 0.7.1

### Patch Changes

- [#242](https://github.com/framerslab/agentos-extensions/pull/242) [`3787e0e`](https://github.com/framerslab/agentos-extensions/commit/3787e0e1fb4d86bc2180990e44b38a80c8af655a) Thanks [@jddunn](https://github.com/jddunn)! - Remove a deleted owner's authorization exchanges recorded unconfirmed, and those whose returned grant's revocation expired or could not be opened, in `SourceRevocations.compact()` a day after their end, with their queue rows a day after the rows' own deadline, instead of keeping them for an acknowledgement a deleted owner can never give.

## 0.7.0

### Minor Changes

- [#231](https://github.com/framerslab/agentos-extensions/pull/231) [`4555f30`](https://github.com/framerslab/agentos-extensions/commit/4555f30cac895f1941abb66dc51e5b35a2abec7e) Thanks [@jddunn](https://github.com/jddunn)! - Fence source purge and credential transfer, serialize grant refresh across workers, and recover bounded revoke-only attempts independently of account lifetime. Record authorization exchanges before their requests are sent, so a returned grant that is not installed is revoked through the same queue, and an outcome that cannot be confirmed keeps new grants blocked until the account owner acknowledges removing the permission.

## 0.6.1

### Patch Changes

- [#229](https://github.com/framerslab/agentos-extensions/pull/229) [`ac76ddf`](https://github.com/framerslab/agentos-extensions/commit/ac76ddf384656e75b89fb6a076389827faf2215c) Thanks [@jddunn](https://github.com/jddunn)! - Keep counting a recovery whose anchor read keeps failing: after expired history, the anchor read continues the attempt count of the history page that found the expiry, so the count reaches five attempts and the `pollMs` wait instead of the anchor read retrying every second or two. `exclude` and `resetExclusions` keep the committed cursor and make a reconcile the next cycle, which replays history from that cursor after a fresh bounded scan. A reconcile asks for the committed cursor's history before its scan and, when that history has expired, replays from its anchor with one scan and one read pass.

## 0.6.0

### Minor Changes

- [#227](https://github.com/framerslab/agentos-extensions/pull/227) [`eceb1cf`](https://github.com/framerslab/agentos-extensions/commit/eceb1cffb1b80a6f586e7572a7a103fee06330b3) Thanks [@jddunn](https://github.com/jddunn)! - Coordinate resumable source synchronization with durable page and document retry episodes, bounded work, renewable leases and independent retention maintenance.

- [#225](https://github.com/framerslab/agentos-extensions/pull/225) [`e773230`](https://github.com/framerslab/agentos-extensions/commit/e773230b496a6567672286ac42d89e2578b266bb) Thanks [@jddunn](https://github.com/jddunn)! - Answer a request that cannot start within a second of its reservation as `{ kind: 'late', retryAt }`, retryable with a new attempt id, instead of `duplicate`, which stays the answer for a reused attempt id. `SourceQuota.compact()` now answers how many attempt records, mailbox waits, meter reservations and minute-budget rows it deleted, and whether a table has more to delete.

## 0.5.0

### Minor Changes

- [#223](https://github.com/framerslab/agentos-extensions/pull/223) [`6e19f78`](https://github.com/framerslab/agentos-extensions/commit/6e19f78f1f731b6f7a6c48d9bd260e7105ca83e5) Thanks [@jddunn](https://github.com/jddunn)! - Coordinate weighted project, account and daily request budgets with shared SQL spend meters, bounded concurrent dispatch and persistent provider retry times.

### Patch Changes

- [#221](https://github.com/framerslab/agentos-extensions/pull/221) [`0895297`](https://github.com/framerslab/agentos-extensions/commit/0895297f7ab7e91fd013621c5ceca95df520a793) Thanks [@jddunn](https://github.com/jddunn)! - Document that `release(handle)` answers false, not null, once the handle's owner fence, lease, generation or `active` check has moved on.

## 0.4.0

### Minor Changes

- [#218](https://github.com/framerslab/agentos-extensions/pull/218) [`e3d9f07`](https://github.com/framerslab/agentos-extensions/commit/e3d9f07307538a5ec6aa39a05d5f8f20cecf36a3) Thanks [@jddunn](https://github.com/jddunn)! - Add adapter-backed durable source synchronization with fenced document application, resumable work, complete cursor commits and recoverable lifecycle controls.

## 0.3.0

### Minor Changes

- [#214](https://github.com/framerslab/agentos-extensions/pull/214) [`28cbd5a`](https://github.com/framerslab/agentos-extensions/commit/28cbd5aceedb0ef2ef36ffdad2349666befb3e4b) Thanks [@jddunn](https://github.com/jddunn)! - Add optional paged synchronization, durable connection and work contracts, opaque checkpoint transitions and complete-application cursor checks while preserving selected-id connector APIs.

### Patch Changes

- [#210](https://github.com/framerslab/agentos-extensions/pull/210) [`8edd460`](https://github.com/framerslab/agentos-extensions/commit/8edd460f36b6aeddf60bedaa6b72c4dd2c131055) Thanks [@jddunn](https://github.com/jddunn)! - Accept a comma inside a quoted `Cache-Control` directive value instead of refusing the header as `invalid_cache_header`; a quoted value left open is still refused.

## 0.2.0

### Minor Changes

- [#205](https://github.com/framerslab/agentos-extensions/pull/205) [`03d31a2`](https://github.com/framerslab/agentos-extensions/commit/03d31a251d0d0ca3c90489a12a6901c1c38b07fc) Thanks [@jddunn](https://github.com/jddunn)! - Add an explicit source-cache permission and expiry policy that refuses restricted, ambiguous or expired response metadata before persistence.

## 0.1.0

### Minor Changes

- [#134](https://github.com/framerslab/agentos-extensions/pull/134) [`f25aa06`](https://github.com/framerslab/agentos-extensions/commit/f25aa068309d61207d78403daebc7ecae3ead4be) Thanks [@jddunn](https://github.com/jddunn)! - Add a library for a person's own accounts as sources: the account connector interface, passage attribution, line ranges and links, capped response reads, and the shared public-sources limiter with Retry-After handling.
