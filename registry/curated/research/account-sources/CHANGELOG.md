# @framers/agentos-ext-account-sources

## 0.11.0

### Minor Changes

- [#451](https://github.com/framerslab/agentos-extensions/pull/451) [`c0aeb03`](https://github.com/framerslab/agentos-extensions/commit/c0aeb03b7f456db489ac92d2196963d8ff79735b) Thanks [@jddunn](https://github.com/jddunn)! - A host that charges indexing by the period names the period's end in its allowance: `indexingPeriodEndsAt`, the first millisecond after the period, as integer UTC epoch milliseconds. With it named, the store keeps one charge record for each source it indexed in the period, in a table `sourceSyncSchema` creates as its ninth and tenth statements (the table and its index by period end), so a host runs its migration again to add it; a database without the table, or a host that names no period, is charged as the release before charged it. The record holds the provenance of the newest text the store wrote or refreshed for the source in the period, message ids, spans, counts and hashes and never text, and it outlives the source's copy until the period ends. A read is weighed against it as well as against the copy the store holds, and charged the smaller amount: a thread whose copy's cache lifetime ended, read again unchanged in the same period, is stored again at no charge, and a reply to it is charged its separator and text. Each such read was charged its whole text again, so a mailbox read again each day after its copies expired spent a month's allowance in days, and from then on every read was refused `indexing_limit` and purged with a deletion record, cycle after cycle, with nothing left stored.
  
  An `indexing_limit` skip that leaves no copy records a deferral, its generation, room and time, and the record then keeps no provenance. While the period lasts, the connection keeps its generation, the allowance leaves no more room and less than the policy's `reconcileMs` has passed since the skip, `page` queues the source settled as the same skip, with no read, no purge and no deletion record, counted among the cycle's settled and skipped items. The source is read again once the period turns, the room grows, the generation moves or the reconcile interval has passed, so a change at the source reaches the store within about one reconcile interval. A record goes with its connection and its owner, with a `gone` read or a provider's skip, with an exclusion, and once its period has ended: `expire` and `sweepExpired` remove up to `limit` ended records after the copies. A `gone` read and a provider's skip remove it in the transaction that withdraws the copy, before the host's `purge`, so a purge that throws keeps none of it. Treat the new table as content for access, retention and backups, as the documents table is.

## 0.10.0

### Minor Changes

- [#449](https://github.com/framerslab/agentos-extensions/pull/449) [`7f73b87`](https://github.com/framerslab/agentos-extensions/commit/7f73b87f9ca8047fced9b95a556d10482124907e) Thanks [@jddunn](https://github.com/jddunn)! - A file past the byte caps is answered `too_large`, a new `SourceGone` reason (a minor release of the account sources package, since a switch over every reason meets a value it has not seen), where it was answered `removed`: its content past `maxFileBytes` (its stated size, a download that declares more, or the bytes read), and an export Google refuses with `exportSizeLimitExceeded`. The file is still in the account and readable by the grant, so a caller may keep the copy it read before; a caller that deleted a copy on any gone reason deleted a file that had only grown past the cap.
  
  A Google Doc is read through the new `exportDoc`: its Markdown without the pictures Google's export embeds as data addresses (each `[imageN]: <data:image/...>` definition goes, and each image that names one stands as its alternative text), and its text (`text/plain`) when Google refuses the Markdown past its 10 MB or the Markdown is past `maxFileBytes`, as read or once read as text. The Markdown is read as CommonMark reads it, through `micromark`, which keeps its open brackets on a stack rather than scanning the rest of a line from each one: code blocks, code spans and escaped images stay as written, a definition inside code defines nothing, a reference uses its label's first definition, and a definition with a title goes like one without. Google's Markdown export carries every picture of a Doc as base64, so a Doc of short text and large pictures was read with the base64 as its text, or answered past the caps on its pictures alone. `exportPastCap(error)` answers whether an export failed on a byte cap, and `withoutEmbeddedPictures(markdown)` takes the same pictures out of Markdown a caller already holds.

## 0.9.7

### Patch Changes

- [#415](https://github.com/framerslab/agentos-extensions/pull/415) [`58e3a2a`](https://github.com/framerslab/agentos-extensions/commit/58e3a2a653cec95113f6c47f5b3bd22c64f095c3) Thanks [@jddunn](https://github.com/jddunn)! - citation-check takes `@framers/agentos-ext-grounding-guard` from `^0.9.0` and account-sources takes `@framers/sql-storage-adapter` from `^0.8.3`, the releases the weekly bump pins. grounding-guard 0.9.0 declares the same `@framers/agentos` peer floor as 0.8.1 (`>=0.12.0`), so citation-check's peer range is unchanged.

## 0.9.6

### Patch Changes

- [#370](https://github.com/framerslab/agentos-extensions/pull/370) [`a4c73bf`](https://github.com/framerslab/agentos-extensions/commit/a4c73bfce6d2b223f49343408cf17de955c48da3) Thanks [@jddunn](https://github.com/jddunn)! - `takeWork` reads one work row a take whatever PostgreSQL's statistics say. Its two looks, the first pending item and the retry whose wait passed first, are bounded by the work indexes' columns alone and ordered by their keys, and the row found is checked for the cycle and the generation after the read (a due row of another is a stale state). With the cycle's condition in the look, the statistics autoanalyze takes after a page writes its rows (every row pending) made a read of the whole connection and a sort look as cheap as the index, so each take read every row and a cycle of n queued reads read about n squared rows.

## 0.9.5

### Patch Changes

- [#367](https://github.com/framerslab/agentos-extensions/pull/367) [`1cc45b6`](https://github.com/framerslab/agentos-extensions/commit/1cc45b672cb41ca475a2c88fd1a15b55837eb817) Thanks [@jddunn](https://github.com/jddunn)! - A provider's read result can no longer carry `attempt_limit`, the store's own skip reason, which `applyResult` has always refused at run time as `invalid_response`: the skipped reason of `SourceSyncReadResult` is the new `SourceSyncReadSkipReason`, every `SourceSyncSkipReason` but `attempt_limit`, so a provider that returned it fails to compile instead of failing its sync. The Gmail source's mapping fault and its skipped threads take the same narrowed reason (`GmailMappingFault.reason`, written against any account-sources release from 0.9.4, the peer floor). Nothing changes at run time.

- [#347](https://github.com/framerslab/agentos-extensions/pull/347) [`d6bb62e`](https://github.com/framerslab/agentos-extensions/commit/d6bb62ec48bfff87408ef6e63adaa0acf954e6bd) Thanks [@jddunn](https://github.com/jddunn)! - A read that keeps failing no longer holds its connection, and an outage gives up no read. The coordinator records a
  read's retriable failure with its wait. After a `network` or `provider_unavailable` failure with no retry time from the
  provider it goes on to the next due read, one that has not failed before one whose wait has passed, so a source that
  cannot be read holds back none queued with it; a second failure in a row ends the run. A `rate_limited` failure or a
  provider's retry time ends the run until that time, and a failed preparation or store write until the read's wait.
  
  The store counts a read's failures across its counts of attempts (`failures` on `SourceSyncWork`, absent from a row an
  earlier release wrote) and from the tenth on records the read as skipped with the new reason `attempt_limit` once the
  failures are evidently its own: the provider answered another read of the cycle in the run of the read's first failure
  or since, or, for a failed preparation, another document was prepared and written. In an outage nothing is answered, so
  no read is given up until its cycle has been open for `reconcileMs`. A given-up read keeps the copy the store holds
  within its own expiry and window, the cycle commits its cursor past it, and the source is read again when a change lists
  it or a reconcile's scan does. `attempt_limit` is the store's own: a read result that carries it is refused as
  `invalid_response`.
  
  `takeWork` takes the first pending item by source id, then the one whose wait passed first, each through one of two new
  work indexes that `sourceSyncSchema` creates (run the migration again to add them), and `progress` reads the cycle's
  counts from its checkpoint (`tally`, a `SourceSyncTally`), so a cycle of many queued reads costs rows that grow with the
  reads rather than with their square. A host sees the same `examined`, `committed` and `skipped` counts.

## 0.9.4

### Patch Changes

- [#356](https://github.com/framerslab/agentos-extensions/pull/356) [`7e5cdd4`](https://github.com/framerslab/agentos-extensions/commit/7e5cdd48f1542569451e9d48e780d5631650e942) Thanks [@jddunn](https://github.com/jddunn)! - `AccountSourceSync` accepts an `operationTimeoutMs` up to 90,000 and a `runBudgetMs` up to 180,000, where it refused
  values over 60,000 and 90,000 with `invalid_source_coordinator_policy`; the defaults stay 30,000 and 90,000. A provider
  whose one call makes several requests in sequence, each under its own deadline, needs their sum, as a Gmail read on a
  fresh connector does: it refreshes the grant, then reads the profile, the labels and the thread, and the Gmail connector
  bounds one operation at 90 seconds itself. The run budget counts from the start of the run and cuts each call at its
  end, so a read and its preparation have to fit it together, and the new ceiling holds one of each at the operation
  ceiling.

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The pack asked for Node.js 20.19, so npm installed it on Node 20 beside a core that does not support Node 20.

- [#349](https://github.com/framerslab/agentos-extensions/pull/349) [`2aba829`](https://github.com/framerslab/agentos-extensions/commit/2aba8297988378e2283cc853dde4bd7cc6ff70a7) Thanks [@jddunn](https://github.com/jddunn)! - A document whose cache lifetime ends between its admission and its second application, as one admitted with a few
  seconds of it left and prepared for longer, is recorded as an `expired` skip: the cycle commits its cursor and the
  connection keeps its next scheduled sync. The store refused such a read as `invalid_response`, the run ended with
  `sync_failed`, and that cleared `nextSyncAt`, so the mailbox left the schedule until a manual request or a control put
  it back. A host sees the read counted among the cycle's skips, its previous copy removed as after any skip, and the
  source read again the next time a cycle lists it: a later history change that names it, or a scan that finds it, such as
  a reconcile's. Like a `gone` result or a skip the provider answers, the expired read withdraws a copy the store still
  holds in a commit of its own before it purges it, so a host `purge` binding that throws leaves nothing derived from that
  copy deliverable, and the next maintenance removes it. In `SourceRevocations.withGrant` and `SourceQuota.run`, a failure
  to delete the grant lease or release the attempt's slot behind what `work` or `send` threw no longer replaces what was
  thrown: a refused grant reaches the coordinator as `grant_rejected`, which fences the grant through
  `lifecycle.loseGrant` and answers `reconnect`, where the host saw `storage_unavailable` and a retry that left the
  authorization state unchanged. Behind a result or a completed call a failed cleanup still answers `storage_unavailable`;
  the lease and the slot free at their own expiry either way.
- Updated dependencies [[`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93)]:
  - @framers/agentos-ext-public-sources@0.2.1

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
