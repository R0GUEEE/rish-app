#!/bin/sh
set -eu
request=$1
state=$2
count=$(sed -n 's/.*"count":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$state")
count=${count:-0}
if grep -q '"inc"' "$request"; then
  count=$((count + 1))
fi
printf '{"count":%s}\n' "$count" > "$state"
cat "$state"
