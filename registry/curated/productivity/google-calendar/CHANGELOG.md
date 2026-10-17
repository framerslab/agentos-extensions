# @framers/agentos-ext-calendar-google

## 1.0.1

### Patch Changes

- [#294](https://github.com/framerslab/agentos-extensions/pull/294) [`f7b9b4b`](https://github.com/framerslab/agentos-extensions/commit/f7b9b4b9d0b919460c453d691a531ebea461eb79) Thanks [@jddunn](https://github.com/jddunn)! - `GoogleCalendarOAuthFlow` refuses options that are not an object with `GoogleOAuthFault` `configuration` before it reads the scope, as the Drive pack's flow refuses its own: a null options object threw a `TypeError`, and a fetch or a scope given in place of the options was dropped, the flow asking the default scope through the global fetch. The README names the pack's second peer, `@framers/agentos-ext-account-sources` 0.7.0 or later, which `./reader` loads through the Drive pack's flow.

- [#291](https://github.com/framerslab/agentos-extensions/pull/291) [`e3b88de`](https://github.com/framerslab/agentos-extensions/commit/e3b88de300e27a6950ac5b85421892c6ceaf6025) Thanks [@jddunn](https://github.com/jddunn)! - `idTokenAccount` refuses an ID token that names a second audience beside the client, or an authorized party (`azp`) other than the client (OpenID Connect Core 1.0, section 3.1.3.7, items 3 and 5), and one whose expiry is not a finite number: an overflowing JSON number parsed to `Infinity` and passed the expiry check. A token Google's token endpoint issues to the client names it alone, so the exchange of a grant is unchanged.

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
