---
"@framers/agentos-ext-web-search": patch
"@framers/agentos-ext-web-browser": patch
---

The README loads the pack through AgentOS.create. It called extensionManager.register, which does not exist.
