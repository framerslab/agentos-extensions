---
"@framers/agentos-ext-github": patch
---

`GitHubDocumentsConnector.read` throws `GitHubApiError` when GitHub refuses the installation token (404 for an installation it no longer has) instead of answering the file `removed`, so a lost installation never reads as every file gone; only the contents read's own 404 answers a file removed. `GitHubAppCredential.installationToken` takes `{ signal, timeoutMs }` as an optional third argument: the connector's calls pass their signal on to the token request, and `reconcileInstallations` its `timeoutMs`. A refused call whose body stops while it is read to tell a rate limit (at the deadline, the caller's cancel or a dropped connection) throws `GitHubNoAnswer` with its reason instead of a `GitHubApiError` told by its status alone. `changesSince` refuses a cursor it did not answer for a push to another branch too.
