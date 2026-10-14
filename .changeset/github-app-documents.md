---
"@framers/agentos-ext-github": minor
---

Add a `./documents` entry with a GitHub App's installation mode and a typed documents connector: the app's JWT and installation tokens narrowed to the repositories asked for, the user's web flow on the auth module's `RedirectOAuthFlow`, the installations and repositories a user token reaches, the webhook signature check, a daily reconcile of installations, heads and failed deliveries, the uninstall, and `GitHubDocumentsConnector`, an account source connector that reads a repository's documentation by tree within a request budget, reads each file raw under a cap, and compares a push by the tree at its `after` commit. `GitHubRepoIndexer` indexes the repositories its caller gives. The peer floor on `@framers/agentos` rises to 0.13.40.
