---
'@framers/agentos-ext-citation-check': minor
---

A new pack that checks the quoted claims of a document against the pages they cite, with no search service: `parseCitedClaims` reads markdown quotations followed by their addresses, or a JSON array of `{ claim, url, exact }`, with line numbers and uncited claims; `checkCitations` fetches each page once (Node's fetch or AgentOS's checked egress, a deadline, a size cap and the web scraper's tiers as the fallback), finds a claim's words on its page first, then grades the rest with AgentOS's `CitationVerifier` when an embedding function is given, or shows the nearest sentences, each check with the status of the page it cites; `renderCitationLog` writes the markdown for a "Citation check log" section. It ships the `citation_verify` tool and the `agentos-citations verify` command, with OpenAI embeddings through AgentOS's `embedText` behind `--embeddings openai`.
