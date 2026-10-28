---
'@framers/agentos-ext-channel-slack': patch
---

An answer a `fetch` gives with no body stream is read by its status alone and its `text()` is never called, so a post never holds an answer whole however long it is. The pack and its two tools report the version in the package's own `package.json`, where they reported `0.1.0`. A workflow link's text is escaped as an incoming webhook's is (`&`, `<` and `>` as `&amp;`, `&lt;` and `&gt;`), so a `<!channel>`, `<!here>`, user or channel mention in it shows as written, and `slackTextLength` and the 40,000-character limit count the escaped text for both kinds of link.
