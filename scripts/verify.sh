#!/usr/bin/env bash
#
# Deliberately tiny, framework-free CI check. It must be *able to fail* — the
# failure is the demo.
#
# 1. npm lint/test, but only if a root package.json exists.
# 2. One repo-agnostic guard that needs no toolchain at all: no tracked file may
#    contain the pipeline marker.
#
set -uo pipefail

status=0

if [ -f package.json ]; then
  echo "==> npm run lint --if-present"
  npm run lint --if-present || status=1
  echo "==> npm test --if-present"
  npm test --if-present || status=1
else
  echo "==> no root package.json; skipping npm lint/test"
fi

# The marker is spliced from two string literals so that this script never
# matches itself.
marker="TODO""(pipeline)"

echo "==> scanning tracked files for the ${marker} marker"
if hits=$(git grep -n -F -e "$marker" -- \
    ':!scripts/verify.sh' \
    ':!README-issue-to-pr.md' \
    ':!.claude' 2>/dev/null); then
  echo "FAIL: ${marker} marker found in tracked files:"
  printf '%s\n' "$hits" | sed 's/^/  /'
  status=1
else
  echo "OK: no ${marker} markers in tracked files."
fi

if [ "$status" -ne 0 ]; then
  echo "verify.sh: FAILED"
else
  echo "verify.sh: OK"
fi

exit "$status"
