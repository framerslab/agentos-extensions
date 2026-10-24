# @framers/agentos-ext-meeting-browser

## 0.1.3

### Patch Changes

- [#396](https://github.com/framerslab/agentos-extensions/pull/396) [`32386fa`](https://github.com/framerslab/agentos-extensions/commit/32386faaa1531f2f8e9a3b245db8211ad7a20e18) Thanks [@jddunn](https://github.com/jddunn)! - The bot image posts its notice in a Google Meet whose chat is a Google Chat conversation (Workspace's Chat in Meet: the chat of a meeting scheduled in Calendar, for the host's own domain). That panel's composer is Google Chat's editable, a `contenteditable` div with the textbox role labelled "History is on" (or, in one reading of April 2026, an editable under a wrapper that carries the "Send a message" label), never the `<textarea>` labelled "Send a message" the adapter waited for; so the Chat key opened the panel and the fill waited out Playwright's thirty seconds, and the bot left with `notice_failed` and `notice: TimeoutError`, as the nightly real-join check's first Meet run did on 24 October 2026 (run 40068158228). The Meet adapter now finds the Chat key and the composer by role and accessible name, with the earlier markup kept as fallbacks and the editable found by its shape in any language, closes a tip laid over the call before it presses the key, opens the panel with Meet's Ctrl+Alt+c when the key is missing or will not take the click, presses the composer's Send key once when Enter left the text there, and reads its own message back as a new message among those its chat observer reads (an element carrying `data-message-id`, never the Pin key beside it that carries the same id, or an element with its sender's name), so a line the panel already held, the bot's own notice after a rejoin among them, never stands for the notice. Every step of the posting waits ten seconds at most and names itself when it fails (`chat_button_missing`, `chat_button_blocked`, `chat_input_missing`, `chat_input_blocked`, `chat_enter_blocked`, `chat_echo_missing`), so a failed night's reports name the step. The selectors are dated 2026-10-24. The fixture draws the two new composer shapes (`chat=history`, `chat=nested`) and the lifecycle test posts the notice through each.

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
