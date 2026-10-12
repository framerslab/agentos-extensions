---
'@framers/agentos-ext-image-editing': minor
---

`editImage` offers style transfer: `mode: 'style-transfer'` with a `styleImageUrl`, the image whose style is applied, while `imageUrl` keeps its subject and composition. A `styleImageUrl` given with no mode asks for it, and one given with another mode is refused, as a `maskUrl` is. The call goes through AgentOS's `transferStyle`, which from 0.13.59 sends the provider both images (Stability on its style-transfer endpoint, OpenAI as two `image[]` parts, Replicate on FLUX.2). On an older AgentOS, which sent one of the two, style transfer is refused with the release it needs, and the other modes run as before.
