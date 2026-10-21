---
'@framers/agentos-ext-document-parser': minor
---

A document reader over a Unix socket, for hosts that read files from people they do not know: the request and answer line protocol; a client with a connection of its own per call and connect and answer deadlines; the reader, which reads one PDF, Word, text or Markdown file with AgentOS's isolated loader under byte, page, character and time bounds and names each refusal; the server, which reads a file from its spool, deletes it and answers; and the `agentos-document-parser` binary with its health check.
