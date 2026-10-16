---
"@framers/agentos-ext-github": patch
---

`GitHubAppUserFlow.revoke` takes GitHub's 204 alone as a deleted token: a 200, a 202 or any other answer throws `OAuthGrantRefused` (reason `revoke`, its status), where any 2xx resolved before. The answer is told by its status alone and its body released unread, so a refusal with a body past 64 KiB throws `OAuthGrantRefused` rather than the size cap's error, and a refusal whose body stays open no longer holds the revocation. Every call of the pack (the REST calls, the code exchange and the revocation) now ends at its deadline or its caller's cancel with `GitHubNoAnswer` even when the injected `fetch` leaves the request or the answer's body open past the signal it was handed; an answer that comes after the deadline has its body released unread.
