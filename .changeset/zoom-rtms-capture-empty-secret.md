---
'@framers/agentos-ext-meeting-zoom-rtms': patch
---

The capture tool, `agentos-zoom-rtms-capture`, refuses to start when the file that `ZOOM_CLIENT_SECRET_FILE`, `ZOOM_WEBHOOK_SECRET_FILE` or `CAPTURE_OPERATOR_TOKEN_FILE` names is empty or holds only whitespace, as the media worker does. It read such a file as an empty secret and started: with an empty operator token it answered an operator call that carried no token, and with an empty webhook secret it accepted a webhook signed with an empty key.
