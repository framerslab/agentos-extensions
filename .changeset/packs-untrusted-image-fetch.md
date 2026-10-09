---
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-vision-pipeline': patch
---

The image-editing and vision-pipeline tools fetch an http(s) image through AgentOS's `imageToBuffer` with `untrusted: true` when the installed AgentOS has that mode (0.13.16 or later): every address the host resolves to is checked when the connection is made, each redirect is checked the same way, and the fetch stops at 50 MiB and 30 seconds. With an older AgentOS the URL goes to AgentOS as before, checked by its host as written.
