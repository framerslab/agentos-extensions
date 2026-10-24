---
'@framers/agentos-ext-document-parser': patch
---

The container image installs every package from the repository's `pnpm-lock.yaml` with pnpm's frozen install, at the versions and integrity the lockfile records, and both its stages start from `node:22.23.4-bookworm-slim` named by its digest, which Dependabot moves to each later Node 22 release. The build ran `npm install` without a lockfile on the `node:22-bookworm-slim` tag, so each build resolved the dependencies afresh, past the lockfile and the three-day release age Dependabot updates it under: a dependency's patch published an hour before a version pull request merged could land in that release's image, whose tag is never moved.
