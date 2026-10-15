---
"@framers/agentos-ext-github": patch
---

`GitHubDocumentsConnector` checks a call's signal before its inputs: `list`, `read`, `changesSince`, `head` and `listing` throw `GitHubNoAnswer` (`cancelled`) for an already aborted signal whatever the inputs, where an input they refuse (an id that is not a repository id, a repository outside the link, a cursor they did not answer) threw that input's `TypeError` or `Error` first. Every aborted call now answers alike, before any request.
