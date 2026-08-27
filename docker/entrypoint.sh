#!/bin/sh
# Expand OH_DSH_TRUSTED_HOSTS into --trusted-host flags and start Oh-DSH Web.
# dsh-web-app refuses --host 0.0.0.0; Docker publish needs a non-loopback
# listener, so proxy 0.0.0.0:3080 onto the loopback server.
set -eu

if [ -z "${OH_DSH_TRUSTED_HOSTS:-}" ]; then
  printf 'ohdsh-web: OH_DSH_TRUSTED_HOSTS is required (DNS-rebinding fence)\n' >&2
  exit 1
fi

mkdir -p /data /workspace

hosts=$(printf '%s' "$OH_DSH_TRUSTED_HOSTS" | tr ',;' ' ')
set --
for host in $hosts; do
  set -- "$@" --trusted-host "$host"
done
if [ "$#" -eq 0 ]; then
  printf 'ohdsh-web: OH_DSH_TRUSTED_HOSTS parsed to no authorities\n' >&2
  exit 1
fi

export OH_DSH_HOME=/data
export DSH_OH_WEB_OPEN="${DSH_OH_WEB_OPEN:-0}"
export OH_DSH_UPDATE_CHECK="${OH_DSH_UPDATE_CHECK:-0}"

socat TCP-LISTEN:3080,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:3081 &

exec tini -- /opt/oh-dsh/bin/ohdsh web \
  --host 127.0.0.1 \
  --port 3081 \
  --data /data \
  --no-open \
  "$@"
