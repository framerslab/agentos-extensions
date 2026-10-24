# The document parser's container image: the pack's server (`node dist/bin.js`) on Node 22 as uid and gid 1000,
# listening on /run/parser/parser.sock and reading files from /run/parser/spool, on the one volume a host shares with
# it. Build it from the repository's root, which holds the lockfile:
#   docker build -f registry/curated/tools/document-parser/Dockerfile -t agentos-document-parser .
#
# Every package it installs comes from pnpm-lock.yaml. image/manifests.mjs cuts two projects from it, each a package.json
# and a lockfile that holds the workspace's packages under one importer: the compiler's (the pack's TypeScript and
# @types/node and the @framers/agentos release the lockfile resolves for the pack, the release its tests run against)
# and the parser's (that release and the pack's own dependencies). pnpm, at the release the repository's packageManager
# field names, installs each with --frozen-lockfile, so every package is the version the lockfile records, checked
# against the integrity it records, without optional packages and without install scripts. Nothing the parser loads
# needs one: the protocol, the server, the isolated loader and its readers load pino, mammoth, unpdf, yaml and
# gray-matter and the rest of the release's own dependencies.
#
# Both stages start from one base, named by its Node release and by its digest, so a tag pushed again changes no build;
# Dependabot proposes each later Node 22 release's image (.github/dependabot.yml).

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d AS build
WORKDIR /build
COPY package.json root/package.json
COPY pnpm-lock.yaml registry/curated/tools/document-parser/image/manifests.mjs ./
COPY registry/curated/tools/document-parser/package.json pack/package.json
RUN node manifests.mjs root/package.json pack/package.json pnpm-lock.yaml .
# The pnpm package has no dependencies of its own: this fetches that one package, at the release pnpm.txt names.
RUN npm install --global --no-audit --no-fund --ignore-scripts "$(cat pnpm.txt)"
# Hoisted: node_modules laid out as plain folders, as npm lays them out, which the runtime stage copies as they are.
RUN cd compile && pnpm install --frozen-lockfile --ignore-scripts --no-optional --config.node-linker=hoisted
COPY registry/curated/tools/document-parser/tsconfig.json compile/tsconfig.json
COPY registry/curated/tools/document-parser/src compile/src
RUN cd compile && node_modules/.bin/tsc -p tsconfig.json
RUN cd runtime && pnpm install --frozen-lockfile --prod --ignore-scripts --no-optional --config.node-linker=hoisted

FROM node:22.23.4-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
LABEL org.opencontainers.image.title="agentos-document-parser" \
      org.opencontainers.image.description="Reads one PDF, Word, text or Markdown file at a time over a Unix socket with AgentOS's isolated loader, in a container of its own" \
      org.opencontainers.image.licenses="Apache-2.0"
WORKDIR /app
# package.json for its "type": "module", which makes dist/*.js ES modules. The files belong to root: the parser reads
# them and can change none of them.
COPY registry/curated/tools/document-parser/package.json registry/curated/tools/document-parser/LICENSE ./
COPY --from=build /build/runtime/node_modules ./node_modules
COPY --from=build /build/compile/dist ./dist
# The base image's node user has uid and gid 1000; a host's container that shares the spool runs as the same pair.
# /run/parser is theirs too, so a named volume first mounted there starts out as theirs.
RUN mkdir -m 0770 /run/parser && chown 1000:1000 /run/parser
USER 1000:1000
ENV PARSER_SOCKET=/run/parser/parser.sock PARSER_SPOOL=/run/parser/spool NODE_OPTIONS=--max-old-space-size=256
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD ["node", "dist/bin.js", "health"]
ENTRYPOINT ["node", "dist/bin.js"]
