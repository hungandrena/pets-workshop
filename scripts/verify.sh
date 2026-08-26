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

if [ -f app/server/test_app.py ]; then
  echo "==> python unit tests (app/server)"
  if command -v python3 >/dev/null 2>&1; then
    # Deliberately not guarded by an import check: a missing dependency must
    # fail the build rather than quietly skip the only test of the API.
    if (cd app/server && python3 -m unittest discover); then
      echo "OK: python unit tests passed."
    else
      echo "FAIL: python unit tests failed."
      echo "      If this is an import error, install the dependencies:"
      echo "        pip install -r app/server/requirements.txt"
      status=1
    fi
  else
    echo "FAIL: python3 not found, so app/server/test_app.py cannot run."
    status=1
  fi
else
  echo "==> no app/server/test_app.py; skipping python tests"
fi

if [ -x scripts/hello.sh ]; then
  echo "==> scripts/hello.sh smoke check"
  if out=$(./scripts/hello.sh 2>&1); then
    if [ -n "$out" ]; then
      echo "OK: hello.sh exited 0 and printed: ${out}"
    else
      echo "FAIL: hello.sh exited 0 but printed nothing."
      status=1
    fi
  else
    echo "FAIL: hello.sh exited $? instead of 0. Output:"
    printf '%s\n' "$out" | sed 's/^/  /'
    status=1
  fi
else
  echo "==> no executable scripts/hello.sh; skipping smoke check"
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
