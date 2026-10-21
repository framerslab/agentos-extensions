---
'@framers/agentos-ext-account-sources': patch
'@framers/agentos-ext-citation-check': patch
'@framers/agentos-ext-gmail-source': patch
'@framers/agentos-ext-google-drive': patch
'@framers/agentos-ext-public-sources': patch
---

The `engines` field asks for Node.js 22 or later, which every `@framers/agentos` release the pack's peer range admits declares (0.10.35 and every release after it). The pack asked for Node.js 20.19, so npm installed it on Node 20 beside a core that does not support Node 20.
