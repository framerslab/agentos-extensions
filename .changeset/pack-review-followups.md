---
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-vision-pipeline': patch
'@framers/agentos-ext-google-cloud-stt': patch
'@framers/agentos-ext-google-cloud-tts': patch
---

Image editing and vision refuse image URLs on this machine or a private network (localhost, loopback, link-local such as 169.254.169.254, the private and carrier-grade NAT ranges, their IPv6 forms) and send the trimmed source they checked. Vision decodes a percent-encoded data URL byte by byte without throwing, logs a pipeline that fails to release, and gives the cloud tier the OpenAI key from its options or secrets; style transfer gets the chosen provider's key. Both keys take effect from `@framers/agentos` 0.12.14. The Google Cloud speech packs read a credentials value as an inline key only when it opens like a JSON object, so a key file path such as `{keys}/sa.json` loads again.
