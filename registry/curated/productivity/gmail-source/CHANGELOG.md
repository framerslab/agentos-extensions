# @framers/agentos-ext-gmail-source

## 0.6.2

### Patch Changes

- [#367](https://github.com/framerslab/agentos-extensions/pull/367) [`1cc45b6`](https://github.com/framerslab/agentos-extensions/commit/1cc45b672cb41ca475a2c88fd1a15b55837eb817) Thanks [@jddunn](https://github.com/jddunn)! - A provider's read result can no longer carry `attempt_limit`, the store's own skip reason, which `applyResult` has always refused at run time as `invalid_response`: the skipped reason of `SourceSyncReadResult` is the new `SourceSyncReadSkipReason`, every `SourceSyncSkipReason` but `attempt_limit`, so a provider that returned it fails to compile instead of failing its sync. The Gmail source's mapping fault and its skipped threads take the same narrowed reason (`GmailMappingFault.reason`, written against any account-sources release from 0.9.4, the peer floor). Nothing changes at run time.
- Updated dependencies [[`1cc45b6`](https://github.com/framerslab/agentos-extensions/commit/1cc45b672cb41ca475a2c88fd1a15b55837eb817), [`d6bb62e`](https://github.com/framerslab/agentos-extensions/commit/d6bb62ec48bfff87408ef6e63adaa0acf954e6bd)]:
  - @framers/agentos-ext-account-sources@0.9.5

## 0.6.1

### Patch Changes

- [#354](https://github.com/framerslab/agentos-extensions/pull/354) [`75d4049`](https://github.com/framerslab/agentos-extensions/commit/75d404901322f3eddeb9945f39ff2ace85387b47) Thanks [@jddunn](https://github.com/jddunn)! - A line the sanitizer's final gate removes that introduces a value, ending with `:` or `=`, or with `is`, `are`, `was`,
  `were`, `be`, `below`, `follows` or `set`, `reset`, `changed` or `updated` followed by `to` (`below` and `follows` also
  with a full stop), now removes the value too: the next line that holds text at the introduction's quote depth, past
  any blank lines, and the lines after it in its paragraph, which a blank line or a change of quote depth ends. `Your
  password is:`, `Your new password is` or `Your temporary password is below.` before `hunter2` no longer leaves
  `hunter2` for storage and embedding, nor does an HTML mail's `<p>Your temporary password is:</p>` leave the paragraph
  holding the value. A gated line that ends with its cue, or with its cue and a full stop, as a label above its value
  does (`Temporary password` or `Here is your new password.` above `Xy7kP2`), removes the next line that holds text when
  that line is one word at the label's quote depth. A line that holds text at another quote depth ends either rule and
  stays. A gated line that ends any other way, such as `Reset your password from Settings.` or `Your password was
  changed.`, keeps the line after it. Every mark now keeps its line's quote markers: a credential tail, a private-key
  block, a line with unresolved encoding and an overlong line lost the `>`, so quoted history ending in one read as an
  inline answer and `messageText` kept the old discussion. A mark's prefix keeps the markers with each run of spaces and
  tabs among them shortened to one character, so an overlong quoted line padded after its marker no longer fills the
  output cap with that padding. A thread whose normalized text changes this way gets a new `contentHash` and version,
  and the store writes its copy again at the next read.

- [#356](https://github.com/framerslab/agentos-extensions/pull/356) [`7e5cdd4`](https://github.com/framerslab/agentos-extensions/commit/7e5cdd48f1542569451e9d48e780d5631650e942) Thanks [@jddunn](https://github.com/jddunn)! - `runGmailSourceSync` gives the coordinator `operationTimeoutMs` 90,000 and `runBudgetMs` 180,000 when the host's
  coordinator options name none. A run that resumes queued reads starts on a fresh connector, so its first read refreshes
  the grant, then reads the profile, the labels and the thread, each under a deadline of its own: four eight-second
  requests took 32 seconds, past the coordinator's 30-second default for one call, which cut the read as a `network`
  failure, and every retry built another connector and repeated the sequence, so under that latency the thread was never
  read and the cycle never committed. 90,000 is the connector's own bound on one operation. The run budget counts from the
  start of the run and cuts each call at its end, so a 90-second budget left a read of four 14-second requests after a
  second of setup 33 seconds for its preparation; 180,000 holds the setup, a read at the connector's bound and its
  preparation. A host's own values still apply. It needs the account-sources release that accepts those values.

- [#359](https://github.com/framerslab/agentos-extensions/pull/359) [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93) Thanks [@jddunn](https://github.com/jddunn)! - The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The pack asked for Node.js 20.19, so npm installed it on Node 20 beside a core that does not support Node 20.
- Updated dependencies [[`7e5cdd4`](https://github.com/framerslab/agentos-extensions/commit/7e5cdd48f1542569451e9d48e780d5631650e942), [`8e9f6a5`](https://github.com/framerslab/agentos-extensions/commit/8e9f6a536172ed249fc51b711dfce6b4f6007d93), [`2aba829`](https://github.com/framerslab/agentos-extensions/commit/2aba8297988378e2283cc853dde4bd7cc6ff70a7)]:
  - @framers/agentos-ext-account-sources@0.9.4

## 0.6.0

### Minor Changes

- [#343](https://github.com/framerslab/agentos-extensions/pull/343) [`8612a2d`](https://github.com/framerslab/agentos-extensions/commit/8612a2d4434744e649aee61167c60d8a2f60a4f4) Thanks [@jddunn](https://github.com/jddunn)! - `excludedCategories`, on `GmailApi` and on the thread mapper's read options, leaves Gmail's inbox tabs out of a
  mailbox's copy by their `category:` names (`promotions`, `social`, `updates`, `forums`; none by default): the scan
  query carries `-category:<name>` for each, a history record that adds a message carrying the category's label names no
  thread to read for that addition (a deletion or a label change still does), and the mapper leaves such messages out of
  the copy under `excluded_category`. A label change that keeps a message inside the excluded tabs (a move between two of
  them in one record, a star) names no thread either, and a generic `messages` entry beside a typed event is decided by
  it, so a mailbox whose tabs churn stops being re-read and re-charged for mail the host never shows; the addition half
  of a move Gmail splits into two records still reads once, charged nothing. `GMAIL_CATEGORIES` and the
  `GmailCategory` type are exported.

### Patch Changes

- [#345](https://github.com/framerslab/agentos-extensions/pull/345) [`78515cc`](https://github.com/framerslab/agentos-extensions/commit/78515ccd0794878a08680823128b2194f3415458) Thanks [@jddunn](https://github.com/jddunn)! - A `multipart/alternative` whose plain part is blank, empty or nothing but whitespace, padding and the percent and
  character references that decode to them, as some mailers send it beside their HTML, gives the HTML's text: a blank
  branch yields to the next one, a later branch whose bytes or charset cannot be read is passed over, and a plain part
  that holds text wins over HTML as before. Label names from the labels response are sanitized as written and never
  decoded as RFC 2047 words, so a label such as `Research =? backlog` no longer drops every message that carries it as
  `invalid_encoding`, or skips a thread of such messages; a run of encoded words in a name is decoded only to look
  inside, and one whose text holds an address or a credential is replaced by what the sanitizer leaves of it. At the
  thread cap each retained message keeps its own cut: the first message that does not fit whole in what
  `maxThreadCharacters` has left, and every older one, is counted under `thread_limit`, where the oldest kept message
  used to be cut to fit. A reply near the cap leaves the text of every message a stored copy holds unchanged, so the
  account-source store charges the reply, not that message's overlapping text again. A thread whose normalized text
  changes this way (one that held a cut message, a blank plain alternative or such a label) gets a new `contentHash` and
  version, and the store writes its copy again at the next read.
- Updated dependencies [[`686c889`](https://github.com/framerslab/agentos-extensions/commit/686c889b24b2f91b99379e5ffcbdd9993444b288), [`9c21a3a`](https://github.com/framerslab/agentos-extensions/commit/9c21a3a8adbdd588d270d50edd9de60675e10770)]:
  - @framers/agentos-ext-account-sources@0.9.3

## 0.5.2

### Patch Changes

- [#319](https://github.com/framerslab/agentos-extensions/pull/319) [`0d1ca9e`](https://github.com/framerslab/agentos-extensions/commit/0d1ca9e2be9c985f801ff21dbf1207ecaac58ce9) Thanks [@jddunn](https://github.com/jddunn)! - Decode every named character reference the HTML standard defines, not a list of twenty-one, in mail text and in the text an HTML body becomes, so a stored thread no longer holds runs of a literal `&zwnj;` or other references the loader leaves. A run of spaces and invisible characters that holds anything but ASCII spaces and tabs, such as the no-break spaces, zero-width non-joiners, combining grapheme joiners and braille blanks a preheader is padded with, collapses to one space, or to nothing between letters; runs of ASCII spaces and tabs stay as written, and an HTML body keeps at most one blank line between paragraphs. A reference such as `&constructor;` stays as written instead of reading an object's prototype. A thread whose normalized text, metadata or message spans change gets a new `contentHash` and version, so the account-source store writes its copy again at the next read; a thread whose history id, text, metadata and spans are unchanged keeps its version.

## 0.5.1

### Patch Changes

- [#265](https://github.com/framerslab/agentos-extensions/pull/265) [`dc63545`](https://github.com/framerslab/agentos-extensions/commit/dc635459eba382781989bf0814c4e20d95ce9416) Thanks [@jddunn](https://github.com/jddunn)! - An answer past its cap, from Google's token address or from the Gmail API, is refused at once, even when the provider's stream never finishes cancelling, so the cap and the 15-second deadline hold. `GmailOAuthFlow.accessToken` checks the read-only scope on the grant its own call read in the key's turn, the one a refresh renews, and refuses a grant with another scope before Google is asked: a grant another writer puts in place between two reads is never renewed, and calls for other keys cannot change a call's outcome. `revoke` resolves when Google answers that the token is already expired or revoked (400 with `invalid_token`), as RFC 7009 answers an invalid token, so an account-source lifecycle's revoke-only queue confirms the revocation instead of reporting that the person must remove the permission at Google, and the cleanup of a refused grant reads `confirmed`; any other refusal throws `OAuthGrantRefused` with the status and Google's error when it is an allowlisted code.

## 0.5.0

### Minor Changes

- [#251](https://github.com/framerslab/agentos-extensions/pull/251) [`3cedbe3`](https://github.com/framerslab/agentos-extensions/commit/3cedbe3c79b47e97f60b7ab6a0b70143bd13dc5c) Thanks [@jddunn](https://github.com/jddunn)! - Add a bounded selected-id Gmail connector and durable-sync binding with private mailbox verification, expiring label snapshots and explicit connector disposal. The API clients of one sync lease can share one access token through `tokenHolder`, so a cycle refreshes the grant once, and the `@framers/agentos` peer floor rises to 0.13.146, whose HTML loader strips tags in linear time.

## 0.4.0

### Minor Changes

- [#243](https://github.com/framerslab/agentos-extensions/pull/243) [`11b0ce4`](https://github.com/framerslab/agentos-extensions/commit/11b0ce49bf30ca9550bedea855f89eb9b7937454) Thanks [@jddunn](https://github.com/jddunn)! - Add a capped read-only Gmail API client with shared grant and quota dispatch, fixed error classification, independent label-cache evidence and canonical thread mapping.

## 0.3.0

### Minor Changes

- [#240](https://github.com/framerslab/agentos-extensions/pull/240) [`16e1fb8`](https://github.com/framerslab/agentos-extensions/commit/16e1fb8c0a9e5f4053990c121d4cb4dabd493eeb) Thanks [@jddunn](https://github.com/jddunn)! - Add bounded Gmail MIME mapping with sanitized thread documents, message provenance, attachment metadata and explicit cache refusal.

## 0.2.0

### Minor Changes

- [#232](https://github.com/framerslab/agentos-extensions/pull/232) [`ddfb91f`](https://github.com/framerslab/agentos-extensions/commit/ddfb91f90ee35071c941862275a20afa1b0efb65) Thanks [@jddunn](https://github.com/jddunn)! - Add bounded pre-storage mail sanitization, allow-listed headers and conservative reply and signature trimming through public text helpers.

## 0.1.0

### Minor Changes

- [#224](https://github.com/framerslab/agentos-extensions/pull/224) [`b6aed0d`](https://github.com/framerslab/agentos-extensions/commit/b6aed0d16c244429373846d29882f810d2a3e633) Thanks [@jddunn](https://github.com/jddunn)! - Add a read-only Gmail source library with scope-checked redirect grants, fixed endpoints and bounded, cancellable OAuth responses.
