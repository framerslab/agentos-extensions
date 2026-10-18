# @framers/agentos-ext-gmail-source

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
