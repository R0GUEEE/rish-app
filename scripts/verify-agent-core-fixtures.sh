#!/bin/zsh
# Verifies the frozen agent-core assets against the digests pinned in
# modules/rish/core/fixtures/FROZEN.md. None of them can be regenerated: the
# native implementations they were recorded from are gone. The repository's
# Actions are disabled, so this is the only thing that checks them.
set -euo pipefail

readonly SCRIPT_DIR=${0:A:h}
readonly REPO_ROOT=${SCRIPT_DIR:h}
readonly FIXTURES=${REPO_ROOT}/modules/rish/core/fixtures
readonly MANIFEST=${FIXTURES}/FROZEN.md

fail() {
  print -u2 -- "verify-agent-core-fixtures: $*"
  exit 1
}

[[ -f "${MANIFEST}" ]] || fail "no manifest at ${MANIFEST}"

typeset -i checked=0
typeset -i failed=0
# Every table row names an asset in backticks, then its digest in backticks.
while read -r name expected; do
  [[ -n "${name}" ]] || continue
  path=${FIXTURES}/${name}
  if [[ ! -f "${path}" ]]; then
    print -u2 -- "missing: ${name}"
    failed+=1
    continue
  fi
  actual=$(/usr/bin/shasum -a 256 "${path}" | /usr/bin/awk '{print $1}')
  checked+=1
  if [[ "${actual}" != "${expected}" ]]; then
    print -u2 -- "changed: ${name}"
    print -u2 -- "  pinned ${expected}"
    print -u2 -- "  actual ${actual}"
    failed+=1
  fi
done < <(/usr/bin/sed -n 's/^| `\([^`]*\)` | `\([0-9a-f]\{64\}\)` .*/\1 \2/p' "${MANIFEST}")

(( checked > 0 )) || fail "the manifest lists no assets; has its table changed shape?"
if (( failed > 0 )); then
  fail "${failed} frozen asset(s) do not match ${MANIFEST}. These cannot be regenerated: a real behaviour change belongs in a new fixture beside them, never in an edit to one."
fi
print -- "verify-agent-core-fixtures: ${checked} frozen assets match"
