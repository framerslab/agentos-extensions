---
'@framers/agentos-ext-google-drive': patch
---

`GoogleOAuthFlow` refuses an answer past its 65,536-byte cap at once, even when the answer's stream never finishes cancelling, so the cap and the 15-second deadline hold. `accessToken` checks `drive.file` on the grant a refresh renews, the one read in the key's turn, and refuses a grant without it before Google is asked; once the signal has aborted it answers no token, not even one held in memory. A malformed client, endpoint override, `begin` input or `complete` input throws `GoogleOAuthFault` `configuration` rather than a `TypeError`.
