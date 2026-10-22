# @framers/agentos-ext-meeting-browser

## 0.1.2

### Patch Changes

- [#368](https://github.com/framerslab/agentos-extensions/pull/368) [`503cf40`](https://github.com/framerslab/agentos-extensions/commit/503cf406a613bef99291873c9261b70d2bed8692) Thanks [@jddunn](https://github.com/jddunn)! - The bot image leaves the call only on a chat message that is the run's stop phrase: the message and the phrase are compared with case ignored, each run of whitespace read as one space and the whitespace around them dropped, and the message may close with `.`, `!` or `?`. A message that holds the phrase among other words is reported as `chat_message` alone. A bot's notice tells people to type the phrase, so two bots in one meeting no longer stop each other on their notices. AgentOS's meeting manager applies the same rule to `chat_message` reports from framerslab/agentos#588.
  
  A message the adapters read from its whole element, because the client drew no body element, is marked (`bodyRead: false` on `ChatMessage`), and a line of it that is the phrase, other than the line of the sender's name, is a stop too, so a stop sent there is still heard. The bot decides the stop on the text it reports, a message's first 4,000 characters, which is the text the manager reads. The scheduler and the bot refuse a job whose stop phrase is blank once its whitespace is folded.

## 0.1.1

### Patch Changes

- [#216](https://github.com/framerslab/agentos-extensions/pull/216) [`ca476a8`](https://github.com/framerslab/agentos-extensions/commit/ca476a8f29557180830e67e98545336f90277f7a) Thanks [@jddunn](https://github.com/jddunn)! - The bot image runs its capture's starts and suspends one at a time, so two `startCapture` commands close together publish one track and a suspend stops a start that was in flight, types into the Microsoft Teams composer whether CKEditor's editable is inside `[data-tid="ckeditor"]` or that element itself, reports a Teams message as its body, reports the same text sent twice as two messages, and hears a participant whose name is You.

## 0.1.0

### Minor Changes

- [#178](https://github.com/framerslab/agentos-extensions/pull/178) [`760070b`](https://github.com/framerslab/agentos-extensions/commit/760070bdca759e0bff816417d11f296ad98826ce) Thanks [@jddunn](https://github.com/jddunn)! - A meeting-participant provider that joins Google Meet and Microsoft Teams through a browser in a container: the scheduler, the bot image, the Meet and Teams adapters, the fixture page and the lifecycle test.
