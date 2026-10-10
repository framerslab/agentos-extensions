---
'@framers/agentos-ext-image-editing': patch
'@framers/agentos-ext-vision-pipeline': patch
---

The image-editing and vision-pipeline tools refuse image URLs on the blocks the IANA special-purpose registries mark not globally reachable that their host check missed: 192.88.99.0/24, 100::/63, 2001::/23, 3fff::/20 and 5f00::/16.
