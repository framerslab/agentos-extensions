---
"@framers/agentos-ext-github": patch
---

A body still being read when its call ends at the deadline or the caller's cancel is cancelled there, so nothing more of it is read through a fetch that leaves the body open past its signal: a JSON answer, a raw file, a refusal read to tell a rate limit and the code exchange's token answer, where the call answered `GitHubNoAnswer` and the read under it went on. A body the pack lets go (a refusal told by its status and headers, such as a 429 or a 5xx, and the answer to an uninstall or a redelivery) is released without waiting on its cancel, so a body whose cancel never settles no longer holds the call past its deadline.
