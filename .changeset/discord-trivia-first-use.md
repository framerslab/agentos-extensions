---
'@framers/agentos-ext-channel-discord': patch
---

Fetch trivia questions from Open Trivia DB the first time one is asked for, instead of when the module loads, so importing the pack sends no request. Declare Node.js 22 or later in `engines`, the range `@framers/agentos` requires.
