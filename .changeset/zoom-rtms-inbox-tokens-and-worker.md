---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

The provider's webhook inbox drops a stream event the media worker refuses for good, a 4xx answer other than 408 and 429 such as a fenced stream or a generation mismatch, with a warning line that names the answer, and takes the next webhook; it held back every webhook after it, removals of the app included. Any other failure of the inbox writes one warning line and pauses the inbox's timer and new deliveries for one second, then twice as long after each further failure up to thirty seconds, where it tried again every second without a line.

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
