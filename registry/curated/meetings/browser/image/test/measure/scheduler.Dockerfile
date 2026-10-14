# The measurement's own scheduler: the pack at the published version the worker runs, its test hosts (the fixtures)
# named by measure.sh. It runs as root in the measurement's stack, to reach the Docker socket measure.sh mounts. Built
# from the measurement's copy of the pack's folder by image/test/measure/measure.sh.
FROM node:24-bookworm-slim
ARG PACK_VERSION
WORKDIR /scheduler
RUN test -n "$PACK_VERSION" \
  && printf '%s\n' '{"name":"meeting-scheduler-measure","private":true,"type":"module"}' > package.json \
  && npm install --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --no-package-lock "@framers/agentos-ext-meeting-browser@$PACK_VERSION"
EXPOSE 8798
CMD ["node", "node_modules/@framers/agentos-ext-meeting-browser/dist/scheduler/main.js"]
