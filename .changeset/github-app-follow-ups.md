---
"@framers/agentos-ext-github": patch
---

`GitHubAppCredential.installationToken` refuses an empty repository list and `verifyWebhookSignature` an empty secret with a `TypeError`, `reconcileInstallations` keeps the lists it computed when GitHub refuses its deliveries listing or a redelivery, reporting the refusal in its new `deliveries` field, and leaves failed a delivery its route refused with a 4xx other than 408 or 429, and the package's entry exports `ECOSYSTEM_REPOS`, `IndexedRepository` and `GitHubRepoIndexerOptions`.
