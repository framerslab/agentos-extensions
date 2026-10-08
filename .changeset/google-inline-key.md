---
'@framers/agentos-ext-google-cloud-stt': patch
'@framers/agentos-ext-google-cloud-tts': patch
---

An inline service-account key works. The credentials secret is a key when it starts with `{` and a key file path otherwise. Every real key holds `/` and `\`, which the packs took as the mark of a path, so they opened an inline key as a file and the first call failed with an error that quoted the key. A key that starts with `{` but is not valid JSON now fails when the pack loads, with a message that quotes none of it.
