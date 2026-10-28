# @framers/agentos-ext-calendar-google

Releases after 1.0.3 are recorded at https://github.com/framerslab/agentos-extensions/releases, one per tag `@framers/agentos-ext-calendar-google@<version>`.

## 1.0.3

### Patch Changes

- [#309](https://github.com/framerslab/agentos-extensions/pull/309) [`66daaf3`](https://github.com/framerslab/agentos-extensions/commit/66daaf3c92295df4550f28b308186dda8b0e365c) Thanks [@jddunn](https://github.com/jddunn)! - `meetingLinkCandidates` drops a sentence's closing stops from an address in one pass from its end, so an address that holds a long run of stops is read in time linear in its length. An address written out ends at a control character, as it ends at a reference to one. It also ends at any character past ASCII, such as a curly quote, an ideographic comma or an emoji, which neither Meet nor Teams writes in its addresses. The README states that `readEvent` sends no query, and its installation section points to `peerDependencies` for the peers' floors rather than naming numbers that fell behind the package's.
- Updated dependencies [[`706b089`](https://github.com/framerslab/agentos-extensions/commit/706b0898b94794943cdabb4e939bb40885ab4b53), [`d8268dd`](https://github.com/framerslab/agentos-extensions/commit/d8268dd25f7d70ac638818e3a59ba4a896060dad), [`bf2a63e`](https://github.com/framerslab/agentos-extensions/commit/bf2a63eb42bc0311232566f5b501646cbaeaa422)]:
  - @framers/agentos-ext-account-sources@0.9.0

## 1.0.2

### Patch Changes

- [#300](https://github.com/framerslab/agentos-extensions/pull/300) [`0ab4156`](https://github.com/framerslab/agentos-extensions/commit/0ab4156026683444d56458dc62c60b4d891f2407) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleCalendarReader` holds each call to its deadline and the caller's signal from the wait for the host's token to the last byte of the answer. A token supplier that stalls answers `timeout` past `deadlineMs` and `cancelled` once the signal aborts, and a token that comes after either is never sent; a `fetchImpl` deaf to its signal, a body that comes late and a body that never ends stop the read the same way, the body's stream cancelled. An error the token supplier throws still passes through as thrown, now documented. `mapCalendarEvent` reads a video entry point whose address does not parse as HTTPS with a host as none, so `meetingLinkCandidates` reads the location and the description in its place, and `meetingLinkCandidates` reads the location and the description as HTML writes them: a character reference an address holds stays in it, so `&#63;` and `&quest;` read as `?` and `&#38;` and `&#x26;` as `&`, as `&amp;` did; one that would end an address written out, such as `&nbsp;` or `&quot;`, ends it; and an address written right after such a reference is read as the next.

## 1.0.1

### Patch Changes

- [#294](https://github.com/framerslab/agentos-extensions/pull/294) [`f7b9b4b`](https://github.com/framerslab/agentos-extensions/commit/f7b9b4b9d0b919460c453d691a531ebea461eb79) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleCalendarOAuthFlow` refuses options that are not an object with `GoogleOAuthFault` `configuration` before it reads the scope, as the Drive pack's flow refuses its own: a null options object threw a `TypeError`, and a fetch or a scope given in place of the options was dropped, the flow asking the default scope through the global fetch. The README names the pack's second peer, `@framers/agentos-ext-account-sources` 0.7.0 or later, which `./reader` loads through the Drive pack's flow.

- [#291](https://github.com/framerslab/agentos-extensions/pull/291) [`e3b88de`](https://github.com/framerslab/agentos-extensions/commit/e3b88de300e27a6950ac5b85421892c6ceaf6025) Thanks [@jddunn](https://github.com/jddunn)! - `idTokenAccount` refuses an ID token that names a second audience beside the client, or an authorized party (`azp`) other than the client (OpenID Connect Core 1.0, section 3.1.3.7, items 3 and 5), and one whose expiry is not a finite number: an overflowing JSON number parsed to `Infinity` and passed the expiry check. A token Google's token endpoint issues to the client names it alone, so the exchange of a grant is unchanged.
- Updated dependencies [[`7c744e8`](https://github.com/framerslab/agentos-extensions/commit/7c744e82f15eee06bc2d6eabe72861ec2da60e76)]:
  - @framers/agentos-ext-account-sources@0.7.3

## 1.0.0

### Major Changes

- [#285](https://github.com/framerslab/agentos-extensions/pull/285) [`5fb982c`](https://github.com/framerslab/agentos-extensions/commit/5fb982c98b2af3875e484e0239fcabbdc60e1b7d) Thanks [@jddunn](https://github.com/jddunn)! - The pack is an ES module, and a typed read surface ships on `@framers/agentos-ext-calendar-google/reader` for a host that keeps its own grant: `GoogleCalendarReader` (the windowed read with every page and its sync token, the incremental read with a 410 answered as gone, the read by id, one deadline and a size cap on every answer, the caller's cancellation, fixed failure words), `mapCalendarEvent` and `meetingLinkCandidates`. The tools and their behaviour are unchanged; a CommonJS `require()` of the pack is no longer supported. The `@framers/agentos` peer floor is 0.13.144.

### Minor Changes

- [#287](https://github.com/framerslab/agentos-extensions/pull/287) [`46a52a9`](https://github.com/framerslab/agentos-extensions/commit/46a52a9b7e45b15af539750ba8e50a3fe0adc38e) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleOAuthFlow` takes its grant's rule as an option (`grant`: the provider id, the scopes asked, `holds` or `exact` matching, the address's extra parameters), Drive's rule (`DRIVE_GRANT`) the default and its behaviour unchanged; `grantMatches` reads OpenID's short scope names as Google's long ones. The calendar pack's `./reader` exports `GoogleCalendarOAuthFlow`: one read-only calendar scope with `openid` and `email`, held exactly at the exchange and at every refresh, and the address the ID token of the token endpoint's answer names.

### Patch Changes

- Updated dependencies [[`46a52a9`](https://github.com/framerslab/agentos-extensions/commit/46a52a9b7e45b15af539750ba8e50a3fe0adc38e)]:
  - @framers/agentos-ext-google-drive@1.1.0

## 0.1.6

### Patch Changes

- [#153](https://github.com/framerslab/agentos-extensions/pull/153) [`ca5be51`](https://github.com/framerslab/agentos-extensions/commit/ca5be5157e296d730363027d40605f428fd04935) Thanks [@jddunn](https://github.com/jddunn)! - Adds a README: installation, configuration, the tools the pack registers and what they do.

## 0.1.5

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.4

### Patch Changes

- [#32](https://github.com/framerslab/agentos-extensions/pull/32) [`4af6448`](https://github.com/framerslab/agentos-extensions/commit/4af644826592e07639743328f0f68cde03b8a577) Thanks [@dependabot](https://github.com/apps/dependabot)! - Depend on googleapis ^183.0.0 (from ^130.0.0). It runs on googleapis-common 9 and google-auth-library 11, which need Node 22, the floor these packs already declare. The YouTube, Gmail and Calendar methods the packs call are unchanged.

## 0.1.3

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

## 0.1.2

### Patch Changes

- [#59](https://github.com/framerslab/agentos-extensions/pull/59) [`eeb7c62`](https://github.com/framerslab/agentos-extensions/commit/eeb7c62cac5672ab2230bc461f3d74af57e2194f) Thanks [@jddunn](https://github.com/jddunn)! - Gmail builds its OAuth client with googleapis' `google.auth.OAuth2` instead of importing `OAuth2Client` from google-auth-library, which the package does not depend on; where another pack's google-auth-library was installed, that import could resolve to a different major than the one googleapis uses. Gmail, YouTube and Google Calendar pass the client options as an object, the form google-auth-library 10 keeps (it deprecates the positional arguments).

## 0.1.1

### Patch Changes

- [#48](https://github.com/framerslab/agentos-extensions/pull/48) [`fca96a4`](https://github.com/framerslab/agentos-extensions/commit/fca96a478eed589035e6a76fa8995c7223e026d8) Thanks [@jddunn](https://github.com/jddunn)! - Ship the compiled output. The previous version was published without its `dist` directory, so the package could not be loaded.
