---
'@framers/agentos-ext-meeting-browser': patch
---

The bot image leaves the call only on a chat message that is the run's stop phrase: the message and the phrase are compared with case ignored, each run of whitespace read as one space and the whitespace around them dropped, and the message may close with `.`, `!` or `?`. A message that holds the phrase among other words is reported as `chat_message` alone. A bot's notice tells people to type the phrase, so two bots in one meeting no longer stop each other on their notices. AgentOS's meeting manager applies the same rule to `chat_message` reports from framerslab/agentos#588.

A message the adapters read from its whole element, because the client drew no body element, is marked (`bodyRead: false` on `ChatMessage`), and a line of it that is the phrase, other than the line of the sender's name, is a stop too, so a stop sent there is still heard. The bot decides the stop on the text it reports, a message's first 4,000 characters, which is the text the manager reads. The scheduler and the bot refuse a job whose stop phrase is blank once its whitespace is folded.
