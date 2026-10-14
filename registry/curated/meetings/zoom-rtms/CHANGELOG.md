# @framers/agentos-ext-meeting-zoom-rtms

## 0.1.6

### Patch Changes

- [#192](https://github.com/framerslab/agentos-extensions/pull/192) [`56e0a10`](https://github.com/framerslab/agentos-extensions/commit/56e0a1067d579f3005ec5917c3e2cca4f173d4d8) Thanks [@jddunn](https://github.com/jddunn)! - The provider's webhook inbox drops a stream event the media worker refuses for good, a 4xx answer other than 408 and 429 such as a fenced stream or a generation mismatch, with a warning line that names the answer, and takes the next webhook; it held back every webhook after it, removals of the app included. Any other failure of the inbox writes one warning line and pauses the inbox's timer and new deliveries for one second, then twice as long after each further failure up to thirty seconds, where it tried again every second without a line.
  
  `revokeZoomToken` resolves only on the answer Zoom documents for a revocation it carried out, `{"status":"success"}`; any other answer, a 2xx among them, throws `ZoomOAuthError`.
  
  A forced call of `ZoomTokenKeeper.accessToken`, made after Zoom refused a token, no longer takes the answer of an unforced refresh already running for the same owner, which can be the token Zoom refused: it waits for that refresh, then refreshes again unless that refresh replaced the token.
  
  A report's `reason` is one of the meeting channel's leave reasons (`ZOOM_LEAVE_REASONS`) and its `message` one of the worker's five words (`ZOOM_END_WORDS`): the worker refuses a leave with another reason and the provider refuses a report with anything else, where both were free strings.
  
  The media worker's process writes its lines as JSON through AgentOS's pino logger, at the level `ZOOM_MEDIA_LOG_LEVEL` names (`info` when it names none), where it used `console.log`, and a start that fails writes an error line, `failed_to_start`. The worker's `logger` option takes AgentOS's `ILogger` shape: each line's state as the message and its fields (`ZoomMediaLogFields`) beside it, where the option was given one JSON string.
  
  The media worker drops a delivery's receipt or a stream's binding a day after writing it, as it starts and hourly after, but never the binding of a stream a run it holds still uses; its receipts grew for as long as it ran.
  
  A receipt file the media worker cannot read is set aside with `.corrupt` added to its name and a warning line, and the worker starts; it did not start.
  
  The media worker tries again a run's closure that only the provider can confirm one tick of its retry timer after the first failure, then after twice as many ticks each time up to sixty, where it tried at every tick. It writes `closure_pending` and `closure_confirmed`, and `report_pending` and `reports_delivered`, once each when a run's closure or its reports begin and stop waiting, where it wrote `report_pending` at every failed try.
  
  A `confirmClosed` that reaches the media worker while its own closure attempt is still out is kept: the worker answers `closed: true` and ends the run, where it answered `closed: false` and the run stayed ending until the provider's next pass.
  
  The media worker reads every answer of the host to its end, so the connection behind it is let go.
  
  The manifest's description names your own Zoom app, where it read as the meeting host's, and the README names `onDeauthorized` as the option a host supplies for a removal of the app.
  
  A failure that stops the media worker from starting is written as an error line whatever level `ZOOM_MEDIA_LOG_LEVEL` names, `fatal` and `silent` included.

## 0.1.5

### Patch Changes

- [#194](https://github.com/framerslab/agentos-extensions/pull/194) [`a4b3592`](https://github.com/framerslab/agentos-extensions/commit/a4b3592d1f8bf464f2cd6659050c92533a6459ff) Thanks [@jddunn](https://github.com/jddunn)! - The README names the identity the speaker texts arrive under: the one the publisher's LiveKit token names, `bot` when AgentOS's `MeetingRoom` mints it with its defaults, which the provider's `botIdentity` option does not change. It said that option set the identity `attachSpeakerTimeline` reads.

## 0.1.4

### Patch Changes

- [#191](https://github.com/framerslab/agentos-extensions/pull/191) [`57f8d5b`](https://github.com/framerslab/agentos-extensions/commit/57f8d5b91be966421d7b10db85bd7b8ca3238e3c) Thanks [@jddunn](https://github.com/jddunn)! - The capture tool, `agentos-zoom-rtms-capture`, refuses to start when the file that `ZOOM_CLIENT_SECRET_FILE`, `ZOOM_WEBHOOK_SECRET_FILE` or `CAPTURE_OPERATOR_TOKEN_FILE` names is empty or holds only whitespace, as the media worker does. It read such a file as an empty secret and started: with an empty operator token it answered an operator call that carried no token, and with an empty webhook secret it accepted a webhook signed with an empty key.

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
