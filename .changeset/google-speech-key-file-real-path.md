---
'@framers/agentos-ext-google-cloud-stt': patch
'@framers/agentos-ext-google-cloud-tts': patch
---

A key file path is handed to the Google client as the real path of the file that was checked. A path through a link followed by `..` (`/keys/link/../sa.json`) was checked as the file the file system reaches and then opened as a different one, the path with `link/..` removed as text, so the client could sign in with another key.
