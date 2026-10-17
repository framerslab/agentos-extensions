---
"@framers/agentos-ext-channel-email": patch
---

`SqlRecipientCapability.issue` takes a key made in another realm, such as a `vm` context or a test runner's sandbox, as the same bytes made here. Its check was `instanceof Uint8Array`, which is false for such a key, so a key of 32 bytes was refused with a `TypeError`; the check now reads the value with `util.types.isUint8Array`. The rule is otherwise unchanged: a `Uint8Array` or a `Buffer` of 32 bytes or more.
