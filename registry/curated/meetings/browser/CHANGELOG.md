# @framers/agentos-ext-meeting-browser

## 0.1.1

### Patch Changes

- [#216](https://github.com/framerslab/agentos-extensions/pull/216) [`ca476a8`](https://github.com/framerslab/agentos-extensions/commit/ca476a8f29557180830e67e98545336f90277f7a) Thanks [@jddunn](https://github.com/jddunn)! - The bot image runs its capture's starts and suspends one at a time, so two `startCapture` commands close together publish one track and a suspend stops a start that was in flight, types into the Microsoft Teams composer whether CKEditor's editable is inside `[data-tid="ckeditor"]` or that element itself, reports a Teams message as its body, reports the same text sent twice as two messages, and hears a participant whose name is You.

## 0.1.0

### Minor Changes

- [#178](https://github.com/framerslab/agentos-extensions/pull/178) [`760070b`](https://github.com/framerslab/agentos-extensions/commit/760070bdca759e0bff816417d11f296ad98826ce) Thanks [@jddunn](https://github.com/jddunn)! - A meeting-participant provider that joins Google Meet and Microsoft Teams through a browser in a container: the scheduler, the bot image, the Meet and Teams adapters, the fixture page and the lifecycle test.
