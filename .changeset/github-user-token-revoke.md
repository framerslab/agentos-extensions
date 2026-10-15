---
"@framers/agentos-ext-github": patch
---

`GitHubAppUserFlow.revoke(token)` deletes a user access token at GitHub (`DELETE /applications/{client_id}/token`, authenticated as the app with its client id and secret), so a server done with a person's token can end it at once instead of leaving it valid until it expires. It threw before, since the flow names no revocation endpoint. GitHub answers 204; any other answer throws `OAuthGrantRefused` (reason `revoke`, its status), a redirect is refused unfollowed, and the call ends at the flow's deadline with `GitHubNoAnswer`. `GitHubAppUserFlowOptions` takes `apiBase`.
