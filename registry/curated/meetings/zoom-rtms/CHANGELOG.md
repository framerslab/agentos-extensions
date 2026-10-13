# @framers/agentos-ext-meeting-zoom-rtms

## 0.1.3

### Patch Changes

- [#188](https://github.com/framerslab/agentos-extensions/pull/188) [`6bfad1d`](https://github.com/framerslab/agentos-extensions/commit/6bfad1da91c32baad913df6e07718e9cda2a1e20) Thanks [@jddunn](https://github.com/jddunn)! - When Zoom refuses or fails the start of a run the media worker has already accepted, the provider takes the run back with the worker's new `withdraw` command instead of `kill`. The worker closes what the run opened, drops the reports still waiting and posts nothing more of the run, its end included, and it keeps the withdrawal in the run's state file. The manager then tries the dispatch again or ends the run with the refusal's reason and word. Before, the worker's `left` report of the taken-back attempt reached the manager while it still held the attempt's dispatch record, and a fault of the moment at Zoom ended the run as `stopped_by_owner` instead of being tried again.

- [#187](https://github.com/framerslab/agentos-extensions/pull/187) [`b1b2129`](https://github.com/framerslab/agentos-extensions/commit/b1b212908a10398da7914cec2d063a1ea453cc19) Thanks [@jddunn](https://github.com/jddunn)! - The media worker no longer posts again a report the host's events route refuses. The route answers 401 once a run's end is settled there (the manager completes a run on its `left` report, so the `done` that follows is refused), and the worker kept that report at the head of the run's queue for ever: the run never left the worker, its state file stayed, `GET /capacity` never freed its slot and `POST /drain` never reached zero. A refusal, a 4xx answer other than 408 and 429, is now logged with the run's id and the status and taken off the queue. A 408, a 429, a 5xx or a network fault still keeps the report, and every report after it, for the next try.

## 0.1.2

### Patch Changes

- [#185](https://github.com/framerslab/agentos-extensions/pull/185) [`4215804`](https://github.com/framerslab/agentos-extensions/commit/421580495e20657ad98714f5dc83bf087ddbbc90) Thanks [@jddunn](https://github.com/jddunn)! - `ZoomRtmsProvider.usage` answers every run the media worker lists when the closure of one `ending` run cannot be proved yet: that run stays alive in the answer, its closure is tried again on the next pass, and the provider writes one warning with the run's id through its logger, which `createExtensionPack` takes from `context.logger`. A closure that cannot finish holds back no other run, so the manager's reconciliation and dispatch recovery read every run of the provider.

## 0.1.1

### Patch Changes

- [#183](https://github.com/framerslab/agentos-extensions/pull/183) [`28bc01f`](https://github.com/framerslab/agentos-extensions/commit/28bc01fd369505620fc08e71971dcd91a73473f9) Thanks [@jddunn](https://github.com/jddunn)! - `ZoomTokenKeeper.disconnect` refreshes an access token at the end of its hour before revoking it, since Zoom's revocation takes a live token, writes the rotated pair under the store's lease, and sends no revocation for a grant Zoom calls dead. The connection is removed in every case, as before.

## 0.1.0

### Minor Changes

- [#180](https://github.com/framerslab/agentos-extensions/pull/180) [`49b18db`](https://github.com/framerslab/agentos-extensions/commit/49b18db7e7fd516a1496fa13a1ddd95005933128) Thanks [@jddunn](https://github.com/jddunn)! - A meeting-participant provider for Zoom through Realtime Media Streams: the provider, the media worker that publishes a meeting's mixed audio into a LiveKit room, the active speaker on a text topic, OAuth with a token keeper and a Postgres token store, and the webhook's verification.
