---
'@framers/agentos-ext-calendar-google': patch
---

`idTokenAccount` refuses an ID token that names a second audience beside the client, or an authorized party (`azp`) other than the client (OpenID Connect Core 1.0, section 3.1.3.7, items 3 and 5), and one whose expiry is not a finite number: an overflowing JSON number parsed to `Infinity` and passed the expiry check. A token Google's token endpoint issues to the client names it alone, so the exchange of a grant is unchanged.
