#!/usr/bin/env bash
# The parser's image under test, as a host runs it (image/docker-compose.test.yml): the parser with no network, a
# read-only root, no capabilities, uid and gid 1000 and the spool's tmpfs volume at /run/parser, and a client container
# from the same image that writes files into the spool and asks for them over the socket (image/lifecycle-client.mjs).
# It passes when the image runs as 1000:1000 and declares its healthcheck, the parser turns healthy under it, every case
# of the client holds, the parser ran with the settings above, and the parser's lines carry no file's text.
# From the repository's root, once the image is built:
#   docker build -f registry/curated/tools/document-parser/Dockerfile -t agentos-document-parser:test .
#   bash registry/curated/tools/document-parser/image/lifecycle.sh
# PARSER_IMAGE names another tag to test.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export PARSER_IMAGE="${PARSER_IMAGE:-agentos-document-parser:test}"
compose=(docker compose -f "$here/docker-compose.test.yml")

cleanup() { "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true; }
fail() {
  echo "lifecycle: $*" >&2
  "${compose[@]}" logs --no-color parser >&2 || true
  exit 1
}

if ! docker image inspect "$PARSER_IMAGE" >/dev/null 2>&1; then
  echo "lifecycle: there is no image $PARSER_IMAGE; build it first (see the top of this file)" >&2
  exit 1
fi

# The image's own settings, whatever a compose file says: its user and its healthcheck.
user=$(docker image inspect -f '{{.Config.User}}' "$PARSER_IMAGE")
[ "$user" = '1000:1000' ] || fail "the image runs as '$user', not 1000:1000"
docker image inspect -f '{{json .Config.Healthcheck}}' "$PARSER_IMAGE" | grep -q '"health"' \
  || fail 'the image declares no healthcheck that runs its health probe'

trap cleanup EXIT
cleanup

# The client exits once its cases are done, which stops the parser; a parser that never turns healthy fails the
# client's dependency, and the timeout bounds a run that hangs.
status=0
output=$(timeout 600 "${compose[@]}" up --abort-on-container-exit --exit-code-from client 2>&1) || status=$?
printf '%s\n' "$output"
[ "$status" -eq 0 ] || fail "the stack exited $status"
grep -Eq 'lifecycle: all [0-9]+ cases held' <<<"$output" || fail 'the client did not report its cases'

parser=$("${compose[@]}" ps --all --quiet parser)
[ -n "$parser" ] || fail 'there is no parser container'
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$parser")" = none ] || fail 'the parser had a network'
[ "$(docker inspect -f '{{.HostConfig.ReadonlyRootfs}}' "$parser")" = true ] || fail "the parser's root was writable"
[ "$(docker inspect -f '{{.Config.User}}' "$parser")" = '1000:1000' ] || fail 'the parser did not run as 1000:1000'

logs=$("${compose[@]}" logs --no-color parser)
grep -q '"state":"listening"' <<<"$logs" || fail 'the parser wrote no listening line'
grep -q '"state":"answered"' <<<"$logs" || fail 'the parser wrote no answered line'
if grep -qF 'hello from the lifecycle test' <<<"$logs"; then fail "a parser line carries a file's text"; fi

echo 'lifecycle: the image held'
