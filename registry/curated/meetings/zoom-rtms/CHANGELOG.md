# @framers/agentos-ext-meeting-zoom-rtms

## 0.2.2

### Patch Changes

- [#430](https://github.com/framerslab/agentos-extensions/pull/430) [`d3df6fa`](https://github.com/framerslab/agentos-extensions/commit/d3df6fadae61b4199ac0aac16e18aefca3874836) Thanks [@jddunn](https://github.com/jddunn)! - The media worker's start wait ends only a run whose stream Zoom has not named. It had ended as not allowed (`left` with `permission_denied` and the word `host_did_not_allow`), with the stream closed at Zoom, a run whose started event had matched inside the wait when the handshakes that follow were still out as the wait ran out. The pack's own suite showed it on a loaded runner, where its 300 millisecond wait ran out inside the fake Zoom's handshake and the suite then waited for a stream the worker had closed (CI run 40244692083 of 25 October 2026 and the first attempt of release run 40271806128 of 26 October). A run whose stream Zoom has named now answers to the handshakes' own bounds alone: ten seconds for each handshake, then Zoom's windows for reconnecting, and `crashed` with `stream_lost` or `handshake_refused` when they run out.

- [#430](https://github.com/framerslab/agentos-extensions/pull/430) [`d3df6fa`](https://github.com/framerslab/agentos-extensions/commit/d3df6fadae61b4199ac0aac16e18aefca3874836) Thanks [@jddunn](https://github.com/jddunn)! - The media worker opens the stream when Zoom's started event is handed over again after a write of its first handing over failed. A write that fails there (the run's state or the delivery's receipt, on a full disk or a refused rename) answers the delivery 500, and the provider hands it over again. That second handing over found the run by its stream, asked a stream that was never opened to reconnect and answered 200: no stream opened, the start wait then ended the run as not allowed, and when the failed write was the first to name the stream, your events route never received the started event. The worker now queues your events route's copy of the event before the run's first write that names the stream, and the handing over that follows a failed write opens the stream without sending the copy again.

## 0.2.1

### Patch Changes

- [#200](https://github.com/framerslab/agentos-extensions/pull/200) [`d5de6d3`](https://github.com/framerslab/agentos-extensions/commit/d5de6d3ec8112c79abe9bc4ca9ea839a99fab951) Thanks [@jddunn](https://github.com/jddunn)! - The capture tool reads a request body that is past its limit to its end before it answers 413, so the answer reaches the sender in place of a reset, where it answered as soon as the limit was passed.
  
  A recording keeps a `meeting.rtms_stopped` or `meeting.rtms_interrupted` of another stream out of its record and notes it for the operator as `foreignWebhook` while it records and as `foreignWebhooks` in the written record's summary, where it kept any stop that came while it recorded.
  
  The capture tool arms no further wait once its record is written, where its own close of the connection armed a five-second wait again.
  
  An operator call whose body cannot be read as JSON is answered 400 `unreadable`, and an empty or blank body means no settings, where an unreadable body was answered 500.

## 0.2.0

### Minor Changes

- [#199](https://github.com/framerslab/agentos-extensions/pull/199) [`bdf58ad`](https://github.com/framerslab/agentos-extensions/commit/bdf58ad583dc64ad160fede18b72cea81d5aba0c) Thanks [@jddunn](https://github.com/jddunn)! - `ZoomRtmsProvider.handleWebhook` refuses a body of more than `ZOOM_WEBHOOK_MAX_BYTES` (1 MiB, exported) with 413 and a warning line before it verifies, reads or keeps it, where it took a body of any size.
  
  The capture tool's webhook refuses with 401 `expired delivery` a delivery whose signing time or event time is more than 90 minutes old or more than a minute ahead, as the provider and the media worker do, and answers 400 to a signed body it cannot read, where it acted on any delivery that carried a good signature and answered 500 to one it could not read.
  
  The capture tool reads no more than 1 MiB of a webhook and `CAPTURE_CONTROL_MAX_BYTES` (16 KiB) of an operator call and refuses a larger body with 413 and a `body_too_large` line, where it read every body whole; its process writes each line as one JSON object with its level.
  
  The capture tool writes a recording once Zoom's `meeting.rtms_stopped` for the stream has come, waiting up to `STOPPED_WEBHOOK_WAIT_MS` (5 s) after Zoom closes the stream's signaling connection, where it wrote the record a second after the close and kept a stop that came later out of the fixture.
  
  The capture tool keeps a stream's media frames while their bytes stay within `CAPTURE_MEDIA_MAX_BYTES` (8 MiB), drops the frames after them with one `media_capped` line and counts them in the summary as `mediaDropped`, where it kept every frame.

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
