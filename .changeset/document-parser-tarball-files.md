---
'@framers/agentos-ext-document-parser': patch
---

The npm package carries no `Dockerfile`. The image builds only from a checkout of the repository, at its root: its build copies the repository's `pnpm-lock.yaml` and `package.json` and the pack's `image/manifests.mjs`, none of which the package holds, so the copy the package carried stopped at its first `COPY` (`docker build -f node_modules/@framers/agentos-ext-document-parser/Dockerfile .`). The README says where the image is built from.
