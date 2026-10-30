---
'@framers/agentos-ext-meeting-browser': patch
---

Join Microsoft Teams through the client Microsoft serves an anonymous guest. The bot's browser now loads Microsoft's static CDN (`*.static.microsoft`, `*.usercontent.microsoft`) and `*.lync.com`, which Microsoft lists as required, so the launcher and the light-meetings client draw their join controls. The Teams adapter reads that client as it drew its pages on 30 October 2026: the name field by its `data-tid`, the lobby by its screen or its words, the call by its Leave key (`button#hangup-button`), which it also presses to leave, a message's text in `div#content-<id>` and its author from the message's item, and a People key with no number as the bot alone.
