# The document parser's container image: the pack's server (`node dist/bin.js`) on Node 22 as uid and gid 1000,
# listening on /run/parser/parser.sock and reading files from /run/parser/spool, on the one volume a host shares with
# it. Build it from the repository's root, which holds the lockfile:
#   docker build -f registry/curated/tools/document-parser/Dockerfile -t agentos-document-parser .
#
# The build uses npm alone. image/manifests.mjs reads the @framers/agentos release that pnpm-lock.yaml resolves for the
# pack, the release its tests run against; the pack is compiled with its own TypeScript and @types/node against it, and
# the image holds that release's runtime dependencies as npm installs them, without dev, optional or peer packages and
# without install scripts. Nothing the parser loads needs one: the protocol, the server, the isolated loader and its
# readers load pino, mammoth, unpdf, yaml and gray-matter and the rest of the release's own dependencies.

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY pnpm-lock.yaml registry/curated/tools/document-parser/image/manifests.mjs ./
COPY registry/curated/tools/document-parser/package.json pack/package.json
RUN node manifests.mjs pack/package.json pnpm-lock.yaml compile runtime
RUN cd compile && npm install --no-audit --no-fund --ignore-scripts --omit=optional
COPY registry/curated/tools/document-parser/tsconfig.json compile/tsconfig.json
COPY registry/curated/tools/document-parser/src compile/src
RUN cd compile && node_modules/.bin/tsc -p tsconfig.json
RUN cd runtime && npm install --no-audit --no-fund --ignore-scripts --omit=dev --omit=optional --omit=peer

FROM node:22-bookworm-slim
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
USER 1000:1000
ENV PARSER_SOCKET=/run/parser/parser.sock PARSER_SPOOL=/run/parser/spool NODE_OPTIONS=--max-old-space-size=256
HEALTHCHECK --interval=5s --timeout=3s --retries=12 CMD ["node", "dist/bin.js", "health"]
ENTRYPOINT ["node", "dist/bin.js"]
