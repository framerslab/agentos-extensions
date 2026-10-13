# @framers/agentos-ext-meeting-zoom-rtms

## 0.1.2

### Patch Changes

- [#185](https://github.com/framerslab/agentos-extensions/pull/185) [`4215804`](https://github.com/framerslab/agentos-extensions/commit/421580495e20657ad98714f5dc83bf087ddbbc90) Thanks [@jddunn](https://github.com/jddunn)! - `ZoomRtmsProvider.usage` answers every run the media worker lists when the closure of one `ending` run cannot be proved yet: that run stays alive in the answer, its closure is tried again on the next pass, and the provider writes one warning with the run's id through its logger, which `createExtensionPack` takes from `context.logger`. A closure that cannot finish holds back no other run, so the manager's reconciliation and dispatch recovery read every run of the provider.

## 0.1.1

### Patch Changes

- [#183](https://github.com/framerslab/agentos-extensions/pull/183) [`28bc01f`](https://github.com/framerslab/agentos-extensions/commit/28bc01fd369505620fc08e71971dcd91a73473f9) Thanks [@jddunn](https://github.com/jddunn)! - `ZoomTokenKeeper.disconnect` refreshes an access token at the end of its hour before revoking it, since Zoom's revocation takes a live token, writes the rotated pair under the store's lease, and sends no revocation for a grant Zoom calls dead. The connection is removed in every case, as before.

## 0.1.0

### Minor Changes

- [#180](https://github.com/framerslab/agentos-extensions/pull/180) [`49b18db`](https://github.com/framerslab/agentos-extensions/commit/49b18db7e7fd516a1496fa13a1ddd95005933128) Thanks [@jddunn](https://github.com/jddunn)! - A meeting-participant provider for Zoom through Realtime Media Streams: the provider, the media worker that publishes a meeting's mixed audio into a LiveKit room, the active speaker on a text topic, OAuth with a token keeper and a Postgres token store, and the webhook's verification.
