# @framers/agentos-ext-meeting-zoom-rtms

## 0.1.1

### Patch Changes

- [#183](https://github.com/framerslab/agentos-extensions/pull/183) [`28bc01f`](https://github.com/framerslab/agentos-extensions/commit/28bc01fd369505620fc08e71971dcd91a73473f9) Thanks [@jddunn](https://github.com/jddunn)! - `ZoomTokenKeeper.disconnect` refreshes an access token at the end of its hour before revoking it, since Zoom's revocation takes a live token, writes the rotated pair under the store's lease, and sends no revocation for a grant Zoom calls dead. The connection is removed in every case, as before.

## 0.1.0

### Minor Changes

- [#180](https://github.com/framerslab/agentos-extensions/pull/180) [`49b18db`](https://github.com/framerslab/agentos-extensions/commit/49b18db7e7fd516a1496fa13a1ddd95005933128) Thanks [@jddunn](https://github.com/jddunn)! - A meeting-participant provider for Zoom through Realtime Media Streams: the provider, the media worker that publishes a meeting's mixed audio into a LiveKit room, the active speaker on a text topic, OAuth with a token keeper and a Postgres token store, and the webhook's verification.
