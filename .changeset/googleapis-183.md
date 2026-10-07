---
'@framers/agentos-ext-channel-youtube': patch
'@framers/agentos-ext-email-gmail': patch
'@framers/agentos-ext-calendar-google': patch
---

Depend on googleapis ^183.0.0 (from ^130.0.0). It runs on googleapis-common 9 and google-auth-library 11, which need Node 22, the floor these packs already declare. The YouTube, Gmail and Calendar methods the packs call are unchanged.
