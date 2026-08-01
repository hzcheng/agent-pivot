#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SKIP_NPM_CI="${SKIP_NPM_CI:-0}"

if ! command -v node >/dev/null 2>&1; then
    echo "error: node is not installed or not on PATH" >&2
    exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
    echo "error: npm is not installed or not on PATH" >&2
    exit 1
fi


run_step() {
    echo
    echo "==> $*"
    "$@"
}

if [[ "$SKIP_NPM_CI" != "1" ]]; then
    run_step npm ci
else
    echo
    echo "==> skipping npm ci because SKIP_NPM_CI=1"
fi

run_step npm run test-compile
run_step npm run lint
run_step npm run package:release
# Routing, absolute artifact paths and byte verification live in Node so they
# can be tested; set CODE_CMD to override the chosen CLI.
run_step node scripts/install-local-extensions.js
