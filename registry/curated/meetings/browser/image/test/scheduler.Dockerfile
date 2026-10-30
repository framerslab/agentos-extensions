# The scheduler under test: the pack's own build (dist/scheduler/main.js, which the pack's `build` writes before the
# stack starts) on its runtime dependencies at the versions the workspace's pnpm-lock.yaml resolves for this pack. It
# runs as root in this test stack, to reach the Docker socket the compose file mounts. Built from the pack's folder by
# image/test/compose.yml.
FROM node:24-bookworm-slim
WORKDIR /scheduler
RUN printf '%s\n' '{"name":"meeting-scheduler-under-test","private":true,"type":"module"}' > package.json \
  && npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-package-lock \
    dockerode@4.0.12 ws@8.22.0 zod@4.6.7 @framers/agentos@0.15.19
COPY dist ./dist
EXPOSE 8788
CMD ["node", "dist/scheduler/main.js"]
