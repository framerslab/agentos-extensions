#!/usr/bin/env bash
# The parser's image under test, as a host runs it (image/docker-compose.test.yml): the parser with no network, a
# read-only root, every capability dropped and none added, no new privileges, uid and gid 1000 and the spool's tmpfs
# volume at /run/parser, and a client container from the same image that writes files into the spool and asks for them
# over the socket (image/lifecycle-client.mjs).
# It passes when the image runs as 1000:1000, declares its healthcheck, holds each of its packages at a version
# pnpm-lock.yaml lists (image/installed.mjs) and hands /run/parser to a new volume as its user's, the parser turns
# healthy under the healthcheck, every case of the client holds, the parser's container ran with each of the settings
# above, as Docker recorded them for it, and the parser's lines carry no file's text.
# From the repository's root, once the image is built:
#   docker build -f registry/curated/tools/document-parser/Dockerfile -t agentos-document-parser:test .
#   bash registry/curated/tools/document-parser/image/lifecycle.sh
# PARSER_IMAGE names another tag to test.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export PARSER_IMAGE="${PARSER_IMAGE:-agentos-document-parser:test}"
compose=(docker compose -f "$here/docker-compose.test.yml")

# A named volume of Docker's defaults, for the check that the image hands /run/parser's owner to a new volume.
plain=document-parser-lifecycle-plain
cleanup() {
  "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume rm -f "$plain" >/dev/null 2>&1 || true
}
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

# The image installs its packages from pnpm-lock.yaml and from nowhere else, so each one it holds is at a version the
# lockfile lists; a build that resolved one afresh would hold a release past the lockfile.
repository=$(cd "$here/../../../../.." && pwd)
docker run --rm --network none --read-only --user 1000:1000 \
  -v "$repository/pnpm-lock.yaml:/check/pnpm-lock.yaml:ro" -v "$here/installed.mjs:/check/installed.mjs:ro" \
  --entrypoint node "$PARSER_IMAGE" /check/installed.mjs /check/pnpm-lock.yaml /app/node_modules \
  || fail 'the image holds a package at a version pnpm-lock.yaml does not list'

trap cleanup EXIT
cleanup

# A new named volume takes the owner and mode of the image's folder it is first mounted on: with /run/parser the
# parser's in the image, a plain volume there is the parser's to write, as a tmpfs volume with uid and gid 1000 is.
plain_volume=$(docker run --rm --network none --read-only -v "$plain:/run/parser" --entrypoint sh "$PARSER_IMAGE" \
  -c 'mkdir /run/parser/spool && stat -c "%u:%g %a" /run/parser' 2>&1) || true
[ "$plain_volume" = '1000:1000 770' ] || fail "a new volume at /run/parser is not the parser's to write: $plain_volume"
docker volume rm -f "$plain" >/dev/null

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
# No capabilities: every one dropped, and none added back.
capabilities=$(docker inspect -f '{{join .HostConfig.CapDrop ","}} | {{join .HostConfig.CapAdd ","}}' "$parser")
[ "$capabilities" = 'ALL | ' ] || fail "the parser kept capabilities (dropped | added: $capabilities)"
security=$(docker inspect -f '{{join .HostConfig.SecurityOpt " "}}' "$parser")
grep -Eq '(^| )no-new-privileges([:=]true)?( |$)' <<<"$security" \
  || fail "the parser could gain privileges (its security options: ${security:-none})"
[ "$(docker inspect -f '{{.Config.User}}' "$parser")" = '1000:1000' ] || fail 'the parser did not run as 1000:1000'
spool_volume=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/parser"}}{{.Type}}:{{.Name}}{{end}}{{end}}' "$parser")
case "$spool_volume" in
  volume:?*) ;;
  *) fail "the parser had no volume at /run/parser: ${spool_volume:-nothing mounted there}" ;;
esac
[ "$(docker volume inspect -f '{{index .Options "type"}}' "${spool_volume#volume:}")" = tmpfs ] \
  || fail "the parser's volume at /run/parser was not a tmpfs"

logs=$("${compose[@]}" logs --no-color parser)
grep -q '"state":"listening"' <<<"$logs" || fail 'the parser wrote no listening line'
grep -q '"state":"answered"' <<<"$logs" || fail 'the parser wrote no answered line'
# The texts the client's files hold, each of which the parser read: none of them may reach a line.
for text in 'hello from the lifecycle test' 'hello in Markdown' 'First page' 'Second page' 'Memo'; do
  if grep -qF "$text" <<<"$logs"; then fail "a parser line carries a file's text: $text"; fi
done

echo 'lifecycle: the image held'
