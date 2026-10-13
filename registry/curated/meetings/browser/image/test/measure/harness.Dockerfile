# The measurement's listening harness: a listen session per run with the Deepgram transcriber, a receiver for the
# scheduler's reports, and the recording's reference text for the word error rate. Built from the measurement's copy
# of the pack's folder by image/test/measure/measure.sh, which runs it as the worker's bots user.
FROM node:24-bookworm-slim
WORKDIR /harness
COPY image/test/measure/package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock
COPY image/test/measure/measure-listen.mjs ./
COPY image/fixture/recording.txt ./
EXPOSE 8799
CMD ["node", "measure-listen.mjs"]
