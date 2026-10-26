---
'@framers/agentos-ext-channel-email': patch
---

`authentication` comes from the topmost Authentication-Results field alone, the receiving host's, since each host that checks a message adds its field at the top (RFC 8601 sections 2.1 and 4). Given `authServId`, that field counts only when it names that host, and no field below it ever counts, so a field a sender wrote naming the host is never read in place of a topmost field that names another host or none. A field that names no authserv-id, as Outlook writes it, is read from its first result and names no host, so it counts with no `authServId` and never under one. `parseAuthenticationResults` and `readHeaderFields` refuse an `authServId` that is not text, holds a control character or is white space alone with the `Error` that `readInbox` and `searchEmails` throw.
