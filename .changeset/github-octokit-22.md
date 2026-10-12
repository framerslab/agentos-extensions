---
'@framers/agentos-ext-github': patch
---

The GitHub pack runs on `@octokit/rest` 22. Version 22.0.0 drops Node.js 18 and removes the deprecated Projects and Copilot usage metrics endpoints (https://github.com/octokit/rest.js/releases/tag/v22.0.0); the pack calls none of them, and every endpoint it calls, `search.issuesAndPullRequests` included, is in the endpoint methods that 22 bundles.
