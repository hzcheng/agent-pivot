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
    # Delegate to the worktree dependency guard rather than running `npm ci`
    # directly. Every line of work runs in a worktree, where a bare
    # project-scoped `npm ci` fails against an inherited user-level
    # allow-scripts config, and would delete node_modules while another command
    # in the same worktree is compiling or testing. The guard neutralizes that
    # config, takes the per-worktree lock, and skips the install entirely when
    # the dependencies are already current.
    run_step npm run worktree:bootstrap
else
    echo
    echo "==> skipping dependency installation because SKIP_NPM_CI=1"
fi

run_step npm run test-compile
run_step npm run lint
run_step npm run package:release
# Routing, absolute artifact paths and byte verification live in Node so they
# can be tested; set CODE_CMD to override the chosen CLI.
run_step node scripts/install-local-extensions.js
