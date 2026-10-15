# @framers/agentos-ext-account-sources

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
