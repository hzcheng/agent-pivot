---
name: registering-extension-commands
description: Use when adding, renaming, or removing an Agent Pivot VS Code command, keybinding, or a TypeScript module under a packaged out/ root (src/openWorkspaces, src/workspaces) or shared with the attention-ui-bridge — exact-match command registries, the reviewed VSIX file list, and the bridge tsconfig include list must be synced in the same change.
---

# Registering Extension Commands

## Overview

Agent Pivot pins its public command surface and packaged VSIX footprint in
several exact-match registries. Adding a command or packaged runtime module
without syncing every registry compiles cleanly, then fails late gates
(dashboard webview checks, release packaging) with deep-equal mismatches.

## Workflow

1. Probe for every command registry with a sibling entry instead of trusting
   memory:
   - `grep -rln 'agentPivot.nextAttentionSession' src/ tests/ scripts/ package.json`
   - every file that enumerates commands is a sync point; re-run the probe
     after editing, because registries accrete. Today that is
     `package.json` (`contributes.commands`),
     `src/dashboard/commandRegistration.ts` (handler interface + id map),
     `src/dashboard.ts` (handler implementation),
     `tests/contract/dashboardBoundaries.test.js` (command list, handler
     names, manifest contract),
     `tests/unit/tooling/extensionHostSuite.test.js`,
     `tests/extension-host/suite/index.js` (subset list — match its intent),
     `tests/contract/aiSessions/runtimeComposition.test.js`, and
     `scripts/run-dashboard-webview-checks.js` (handler names, command ids,
     expected call order).

2. Sync the reviewed VSIX list for new packaged modules. Files compiled under
   `out/openWorkspaces/` and `out/workspaces/` ship inside the VSIX next to
   the webpacked bundle, so a new source module under `src/openWorkspaces/`
   or `src/workspaces/` must be added to both the exact packaged-entries list
   and the required-artifacts list in
   `scripts/run-release-packaging-checks.js`.

3. Register bridge-shared modules in the bridge build. A `src/` TypeScript
   module imported by `extensions/attention-ui-bridge/` must be added to that
   package's `tsconfig.json` `include` list, or `attention:bridge:compile`
   cannot see it.

4. Add or update the manifest contract test (no default keybinding unless the
   feature owns one) and the behavior-contract catalog entries for the new
   user-visible behavior.

## Verification

- Run `npm run test:dashboard:run` and `npm run test:release-packaging` plus
  the unit/contract suites with real exit codes (`set -o pipefail`, or a log
  file plus an explicit status echo) — never pipe gate output through `tail`.

## Pitfalls

- A successful compile proves nothing about registry sync: the command-list
  and VSIX-list assertions are runtime deep-equal checks in scripts.
- The extension-host suite list is intentionally a subset; sync it to keep
  its "every listed command is registered" coverage meaningful.
