---
'@framers/agentos-ext-channel-email': patch
---

`SqlSuppressionStore` and `SqlRecipientCapability` refuse a scope, a recipient or a nonce that holds U+0000 or a lone surrogate, with a `TypeError` that names the argument and none of its value, before any statement. PostgreSQL's text refuses U+0000, and UTF-8 cannot encode a lone surrogate, so node-postgres wrote U+FFFD in its place: on PostgreSQL a `revoke` given one could end another recipient's tokens, and `find` could answer a recipient other than the one the token was issued for. A name with characters past U+FFFF is kept as given.
