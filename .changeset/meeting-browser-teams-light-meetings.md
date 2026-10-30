---
'@framers/agentos-ext-meeting-browser': patch
---

Join Microsoft Teams through the client Microsoft serves an anonymous guest. The bot's browser now loads Microsoft's static CDN (`*.static.microsoft`, `*.usercontent.microsoft`) and `*.lync.com`, which Microsoft lists as required, so the launcher and the light-meetings client draw their join controls. The Teams adapter reads that client as it drew its pages on 30 October 2026: the name field by its `data-tid`, the lobby by its screen or its words, the call by its Leave key (`button#hangup-button`), which it also presses to leave, a message's text in `div#content-<id>` and its author from the message's item, and the People key, the roster key at its first shown match (never a hidden copy of it or a key such as Invite people), reading "People" alone as the bot alone and other words with no number as no count.
