# @framers/agentos-ext-document-parser

## 0.1.0

### Minor Changes

- [#355](https://github.com/framerslab/agentos-extensions/pull/355) [`ce1d426`](https://github.com/framerslab/agentos-extensions/commit/ce1d426f27720cc99d152f70731474099a73cc50) Thanks [@jddunn](https://github.com/jddunn)! - A document reader over a Unix socket, for hosts that read files from people they do not know: the request and answer line protocol; a client with a connection of its own per call and connect and answer deadlines; the reader, which reads one PDF, Word, text or Markdown file with AgentOS's isolated loader under byte, page, character and time bounds and names each refusal; the server, which reads a file from its spool, deletes it and answers; and the `agentos-document-parser` binary with its health check. Its container image, `ghcr.io/framerslab/agentos-document-parser`, tagged with each release's version, runs the binary as uid and gid 1000, and the README runs it with no network and a read-only root beside a host that shares the spool's volume.
