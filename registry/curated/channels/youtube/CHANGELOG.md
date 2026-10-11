# @framers/agentos-ext-channel-youtube

## 0.1.4

### Patch Changes

- [#119](https://github.com/framerslab/agentos-extensions/pull/119) [`cf94e65`](https://github.com/framerslab/agentos-extensions/commit/cf94e65b609616589f979a60be6c54d7d27916f6) Thanks [@jddunn](https://github.com/jddunn)! - License metadata is Apache-2.0, matching the repository's LICENSE. Versions published before this one carry the license they were published with.

## 0.1.3

### Patch Changes

- [#32](https://github.com/framerslab/agentos-extensions/pull/32) [`4af6448`](https://github.com/framerslab/agentos-extensions/commit/4af644826592e07639743328f0f68cde03b8a577) Thanks [@dependabot](https://github.com/apps/dependabot)! - Depend on googleapis ^183.0.0 (from ^130.0.0). It runs on googleapis-common 9 and google-auth-library 11, which need Node 22, the floor these packs already declare. The YouTube, Gmail and Calendar methods the packs call are unchanged.

## 0.1.2

### Patch Changes

- [#65](https://github.com/framerslab/agentos-extensions/pull/65) [`e9e1394`](https://github.com/framerslab/agentos-extensions/commit/e9e1394b68bd95e15d536b672fb959eec7ac7bb9) Thanks [@jddunn](https://github.com/jddunn)! - Declare Node.js 22 or later in `engines`. These packs peer on `@framers/agentos`, which has required Node.js 22 or later since 0.10.35, so their `>=18.0.0` declaration promised support that an install with a current core does not have.

## 0.1.1

### Patch Changes

- [#59](https://github.com/framerslab/agentos-extensions/pull/59) [`eeb7c62`](https://github.com/framerslab/agentos-extensions/commit/eeb7c62cac5672ab2230bc461f3d74af57e2194f) Thanks [@jddunn](https://github.com/jddunn)! - Gmail builds its OAuth client with googleapis' `google.auth.OAuth2` instead of importing `OAuth2Client` from google-auth-library, which the package does not depend on; where another pack's google-auth-library was installed, that import could resolve to a different major than the one googleapis uses. Gmail, YouTube and Google Calendar pass the client options as an object, the form google-auth-library 10 keeps (it deprecates the positional arguments).
