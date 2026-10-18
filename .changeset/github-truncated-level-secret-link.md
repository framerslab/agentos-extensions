---
'@framers/agentos-ext-github': patch
---

`readTree` throws `TreeTooLarge` with the new `reason: 'truncated'` when GitHub answers a level of the tree truncated even when it is asked for without recursion, before any folder under it is asked for; it took that level as whole, so the files past the cut dropped out of the listing and `changesSince` answered them `removed`. A tree past its request budget throws with `reason: 'budget'`, as before.

`readWebhookDelivery` and `readWebhookRequest` throw the `TypeError` for an empty or missing secret before anything else: a body past `maxBytes` was refused as `too_large` first, and `readWebhookRequest` read the whole body before it checked the secret.

A read's attribution link encodes the commit or branch segment by segment, as it does the path: a default branch named `docs#1` linked as `blob/docs#1/...`, which a browser and `sourceRefLink` cut at the `#`.

`uninstallInstallation`'s documentation says what it does: any 2xx and 404 count as done.
