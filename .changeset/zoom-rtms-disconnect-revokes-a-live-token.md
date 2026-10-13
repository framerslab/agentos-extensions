---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

`ZoomTokenKeeper.disconnect` refreshes an access token at the end of its hour before revoking it, since Zoom's revocation takes a live token, writes the rotated pair under the store's lease, and sends no revocation for a grant Zoom calls dead. The connection is removed in every case, as before.
