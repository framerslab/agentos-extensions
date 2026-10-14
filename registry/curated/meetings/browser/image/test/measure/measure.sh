#!/usr/bin/env bash
# The capacity measurement, run on the worker as its bots user (the Measure meeting bots workflow copies this folder,
# the fixture and the seccomp profile to /srv/meeting/measure and runs it there):
#
#   bash measure.sh <bots at once> <minutes per bot>
#
# It starts a stack of its own on the bots' network (meeting-bots): LiveKit's server image with a key pair made for
# this run, one meeting fixture per bot, and a scheduler of the published pack's version whose test hosts are those
# fixtures, which starts the bots from the published bot image under its fixed container policy. The listening harness
# (measure-listen.mjs, in a container on the same network) sends each bot to its fixture, admits it, starts its capture
# after the notice and a heartbeat, listens to each run's room with a listen session and the Deepgram transcriber, and
# leaves after the minutes given. docker stats is sampled every 15 seconds for the bots, LiveKit and the harness. The
# harness prints one JSON document on stdout; everything else goes to stderr. The stack is removed on every exit.
#
# Reads: the transcriber's key from DEEPGRAM_KEY_FILE (default /srv/meeting/secrets/deepgram), DEEPGRAM_PRICE_PER_MIN
# (default 0.0048), MEASURE_PACK_VERSION (default the newest published version of the pack) and MEASURE_BOT_IMAGE
# (default ghcr.io/framerslab/agentos-meeting-bot:<that version>). While it runs, the bots reach the stack's containers
# on the bridge: the fixtures on 8787, LiveKit on 7880 and 7881 and 7882/udp, the scheduler's channel on 8798.
set -euo pipefail

N=${1:?bots at once}
MINUTES=${2:?minutes per bot}
[[ $N =~ ^[0-9]+$ ]] && (( N >= 1 && N <= 16 )) || { echo "bots at once: a whole number from 1 to 16" >&2; exit 2; }
[[ $MINUTES =~ ^[0-9]+$ ]] && (( MINUTES >= 1 && MINUTES <= 60 )) || { echo "minutes per bot: a whole number from 1 to 60" >&2; exit 2; }

HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$(cd "$HERE/../../.." && pwd) # the copy of the pack's folder: image/fixture, image/seccomp.json, image/test/measure
DEEPGRAM_KEY_FILE=${DEEPGRAM_KEY_FILE:-/srv/meeting/secrets/deepgram}
[ -r "$DEEPGRAM_KEY_FILE" ] || { echo "no transcriber key at $DEEPGRAM_KEY_FILE" >&2; exit 2; }
PACK_VERSION=${MEASURE_PACK_VERSION:-$(npm view @framers/agentos-ext-meeting-browser version 2>/dev/null || true)}
[ -n "$PACK_VERSION" ] || { echo "no published version of @framers/agentos-ext-meeting-browser; set MEASURE_PACK_VERSION" >&2; exit 2; }
BOT_IMAGE=${MEASURE_BOT_IMAGE:-ghcr.io/framerslab/agentos-meeting-bot:$PACK_VERSION}
NETWORK=meeting-bots
PREFIX=meeting-measure
WORK=$(mktemp -d)
SAMPLER=

cleanup() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
  docker ps -aq --filter label=dev.frame.meeting.worker=measure | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker ps -aq --filter "name=$PREFIX-" | xargs -r docker rm -f >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "measuring $N bots at once for $MINUTES minutes each: pack $PACK_VERSION, image $BOT_IMAGE" >&2
docker ps -aq --filter "name=$PREFIX-" | xargs -r docker rm -f >/dev/null 2>&1 || true
docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null
docker image inspect "$BOT_IMAGE" >/dev/null 2>&1 || docker pull -q "$BOT_IMAGE" >&2
docker build -q -f "$SRC/image/fixture/Dockerfile" -t agentos-meeting-fixture:measure "$SRC" >&2
docker build -q -f "$HERE/scheduler.Dockerfile" --build-arg "PACK_VERSION=$PACK_VERSION" -t agentos-meeting-scheduler:measure "$SRC" >&2
docker build -q -f "$HERE/harness.Dockerfile" -t agentos-meeting-harness:measure "$SRC" >&2

# this run's secrets, made here: the scheduler's client credential, in $WORK and removed with it, and LiveKit's key pair,
# which reaches its two containers through the docker command's environment (-e NAME reads it there), never its arguments
openssl rand -hex 24 > "$WORK/client"
LIVEKIT_SECRET=$(openssl rand -hex 32)

LIVEKIT_KEYS="measure: $LIVEKIT_SECRET" docker run -d --name "$PREFIX-livekit" --network "$NETWORK" \
  -e LIVEKIT_KEYS -e UDP_PORT=7882 \
  livekit/livekit-server:v1.13.7 --bind 0.0.0.0 >/dev/null
FIXTURES=
for i in $(seq 1 "$N"); do
  docker run -d --name "$PREFIX-fixture-$i" --network "$NETWORK" agentos-meeting-fixture:measure >/dev/null
  FIXTURES="${FIXTURES:+$FIXTURES,}$PREFIX-fixture-$i"
done
docker run -d --name "$PREFIX-scheduler" --network "$NETWORK" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$WORK/client:/run/secrets/client:ro" \
  -v "$SRC/image/seccomp.json:/etc/meeting/seccomp.json:ro" \
  -e MEETING_WORKER_ID=measure -e "MEETING_SLOTS=$N" -e MEETING_CLIENT_TOKEN_FILE=/run/secrets/client \
  -e "MEETING_BOT_IMAGE=$BOT_IMAGE" -e MEETING_LISTEN=0.0.0.0:8798 \
  -e "MEETING_CHANNEL_URL=ws://$PREFIX-scheduler:8798/channel" -e "MEETING_RESOLVE_ALLOW=$FIXTURES" \
  -e MEETING_SECCOMP_PROFILE=/etc/meeting/seccomp.json \
  agentos-meeting-scheduler:measure >/dev/null

# docker stats every 15 seconds, each batch after a line with its time, read by the harness when the runs are over
( while :; do
    printf '{"sample":%s}\n' "$(date +%s%3N)"
    docker stats --no-stream --format '{{json .}}' 2>/dev/null || true
    sleep 15
  done ) > "$WORK/stats.jsonl" &
SAMPLER=$!

MEMORY_KIB=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo)
LIVEKIT_API_SECRET="$LIVEKIT_SECRET" docker run --rm --name "$PREFIX-harness" --network "$NETWORK" --user "$(id -u):$(id -g)" \
  -v "$DEEPGRAM_KEY_FILE:/run/secrets/deepgram:ro" -v "$WORK:/run/measure:ro" \
  -e "MEASURE_BOTS=$N" -e "MEASURE_MINUTES=$MINUTES" \
  -e "LIVEKIT_URL=ws://$PREFIX-livekit:7880" -e LIVEKIT_API_KEY=measure -e LIVEKIT_API_SECRET \
  -e "SCHEDULER_URL=http://$PREFIX-scheduler:8798" -e "FIXTURE_PREFIX=$PREFIX-fixture-" \
  -e "REPORT_URL=http://$PREFIX-harness:8799/report" \
  -e "DEEPGRAM_PRICE_PER_MIN=${DEEPGRAM_PRICE_PER_MIN:-0.0048}" \
  -e "WORKER_CPUS=$(nproc)" -e "WORKER_MEMORY_BYTES=$(( MEMORY_KIB * 1024 ))" \
  -e "PACK_VERSION=$PACK_VERSION" -e "BOT_IMAGE=$BOT_IMAGE" \
  -e "LIVEKIT_CONTAINER=$PREFIX-livekit" -e "HARNESS_CONTAINER=$PREFIX-harness" \
  agentos-meeting-harness:measure
