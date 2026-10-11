---
"@framers/agentos-ext-channel-google-chat": patch
---

App-URL verification accepts tokens signed by a Workspace add-on's service account. The issuer pattern was written with doubled backslashes and matched no address, so those requests were rejected as unauthorized.
