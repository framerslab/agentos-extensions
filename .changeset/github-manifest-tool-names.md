---
"@framers/agentos-ext-github": patch
---

`manifest.json` lists the 26 tools by the names the pack registers them under (`github_search`, `github_issue_list` and the rest) instead of `githubSearch` and the like, so the extension registry's listing and AgentOS's capability discovery offer names a model can call. The pack reports its package's version instead of `0.1.0`.
