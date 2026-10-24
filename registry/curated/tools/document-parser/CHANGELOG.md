# @framers/agentos-ext-document-parser

## 0.1.1

### Patch Changes

- [#385](https://github.com/framerslab/agentos-extensions/pull/385) [`aa65a9a`](https://github.com/framerslab/agentos-extensions/commit/aa65a9a1a3cd870d16eb67431debbe7ee76487d5) Thanks [@jddunn](https://github.com/jddunn)! - The container image installs every package from the repository's `pnpm-lock.yaml` with pnpm's frozen install, at the versions and integrity the lockfile records, and both its stages start from `node:22.23.4-bookworm-slim` named by its digest, which Dependabot moves to each later Node 22 release. The build ran `npm install` without a lockfile on the `node:22-bookworm-slim` tag, so each build resolved the dependencies afresh, past the lockfile and the three-day release age Dependabot updates it under: a dependency's patch published an hour before a version pull request merged could land in that release's image, whose tag is never moved.

- [#385](https://github.com/framerslab/agentos-extensions/pull/385) [`aa65a9a`](https://github.com/framerslab/agentos-extensions/commit/aa65a9a1a3cd870d16eb67431debbe7ee76487d5) Thanks [@jddunn](https://github.com/jddunn)! - The spool the parser makes is mode 0770 whatever the process's umask. `mkdir`'s mode passed through the umask, 022 in a container by default, and left the spool 0750, so a host that shares the parser's group under a uid of its own could not write a file into it (`EACCES`). A spool that is already there keeps its mode.

- [#385](https://github.com/framerslab/agentos-extensions/pull/385) [`aa65a9a`](https://github.com/framerslab/agentos-extensions/commit/aa65a9a1a3cd870d16eb67431debbe7ee76487d5) Thanks [@jddunn](https://github.com/jddunn)! - The npm package carries no `Dockerfile`. The image builds only from a checkout of the repository, at its root: its build copies the repository's `pnpm-lock.yaml` and `package.json` and the pack's `image/manifests.mjs`, none of which the package holds, so the copy the package carried stopped at its first `COPY` (`docker build -f node_modules/@framers/agentos-ext-document-parser/Dockerfile .`). The README says where the image is built from.

## 0.1.0

### Minor Changes

- [#355](https://github.com/framerslab/agentos-extensions/pull/355) [`ce1d426`](https://github.com/framerslab/agentos-extensions/commit/ce1d426f27720cc99d152f70731474099a73cc50) Thanks [@jddunn](https://github.com/jddunn)! - A document reader over a Unix socket, for hosts that read files from people they do not know: the request and answer line protocol; a client with a connection of its own per call and connect and answer deadlines; the reader, which reads one PDF, Word, text or Markdown file with AgentOS's isolated loader under byte, page, character and time bounds and names each refusal; the server, which reads a file from its spool, deletes it and answers; and the `agentos-document-parser` binary with its health check. Its container image, `ghcr.io/framerslab/agentos-document-parser`, tagged with each release's version, runs the binary as uid and gid 1000, and the README runs it with no network and a read-only root beside a host that shares the spool's volume.
