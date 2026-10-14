# The bot: Debian with Node 24, Chromium through Playwright, PulseAudio, Xvfb.
# Built from the pack's folder, which holds the protocol the bot shares with the scheduler:
#   docker build -f image/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY image/package.json image/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY image/tsconfig.json ./
COPY image/src ./src
COPY src/protocol.ts ./src/protocol.ts
RUN npx tsc -p tsconfig.json

FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
RUN apt-get update && apt-get install -y --no-install-recommends pulseaudio pulseaudio-utils xvfb ca-certificates fonts-liberation tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY image/package.json image/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npx playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*
COPY --from=build /build/dist ./dist
COPY image/entrypoint.sh /app/entrypoint.sh
COPY image/pulse/default.pa /etc/pulse/bot.pa
RUN useradd --create-home --uid 10001 bot && chmod +x /app/entrypoint.sh && mkdir -p /home/bot/profile && chown -R bot:bot /home/bot /app
USER bot
# The root file system is read-only when the scheduler runs the bot, and /run/pulse is a tmpfs owned by the container's
# root. PulseAudio refuses a runtime folder another user owns and stops when it cannot make its state folder or its
# cookie, so all three live in folders the entrypoint makes under /run/pulse as the bot user. Chromium keeps its crash
# handler's database in its config folder and does not start when it cannot make one, so that folder is in the /tmp tmpfs.
ENV HOME=/home/bot XDG_CONFIG_HOME=/tmp/.config XDG_RUNTIME_DIR=/run/pulse/user PULSE_RUNTIME_PATH=/run/pulse/user/pulse PULSE_STATE_PATH=/run/pulse/state PULSE_COOKIE=/run/pulse/cookie PULSE_SERVER=unix:/run/pulse/native
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
