# Agent Pivot Release-Readiness Blockers Implementation Plan

**Goal:** Remove the startup command race and Attention artifact-version drift
before rebasing and opening the release PR.

**Design reference:**
`docs/superpowers/specs/2026-07-27-release-readiness-blockers-design.md`

## Constraints

- Follow RED -> GREEN for each blocker.
- Public commands register once before `DashboardBootstrapController.start()`.
- Only a provider-accepted bootstrap generation may become the active handler
  generation.
- Boot-time commands never wait indefinitely.
- Current artifact filenames come from manifests, not copied version strings.
- Historical release evidence is not rewritten.

## Task 1: Stable public command facade

Files:

- `src/dashboard/commandRegistration.ts`
- `src/dashboard/runtimeController.ts`
- `src/dashboard.ts`
- `tests/contract/dashboardBoundaries.test.js`
- `tests/fixtures/aiSessions/runtimeHostActivationHarness.js`
- `tests/contract/aiSessions/runtimeComposition.test.js`
- `tests/unit/tooling/extensionHostSuite.test.js`
- `tests/extension-host/suite/index.js`
- `docs/testing/behavior-contracts.json`

Steps:

1. Add failing tests for pre-bootstrap registration, boot-time open,
   finite unavailable-command failure, generation replacement, and disposal.
2. Run focused contract tests and record the expected failure.
3. Implement the stable facade and reusable reveal helper.
4. Register the facade before bootstrap, stage handlers at successful
   composition, and activate them only after provider adoption.
5. Add immediate full-command-surface assertions to deterministic and real
   Extension Host coverage.
6. Run focused command, bootstrap, and Extension Host tooling tests.

## Task 2: Manifest-derived Attention artifacts

Files:

- `scripts/package-attention-extensions.js`
- `scripts/run-attention-local-bridge-spike-checks.js`
- `spikes/attention-local-bridge/MANUAL-MATRIX.md`
- `tests/unit/tooling/packageScripts.test.js`
- `docs/testing/behavior-contracts.json`

Steps:

1. Add the failing manifest/artifact drift contract.
2. Update the renamed auto-run fixture's independent expected digest.
3. Derive both spike artifact filenames from their manifests.
4. Make spike checks compare current derived filenames and manifest
   capabilities without copied version literals.
5. Update the current manual matrix and prove the focused tests are green.
6. Run the complete Attention spike test and package both VSIX artifacts.

## Task 3: Verification and integration

1. Run behavior-contract validation and the complete Linux CI gate.
2. Perform a fresh two-stage code review and address findings.
3. Audit new implementation commits in the main-capability coverage ledger.
4. Fetch and rebase onto the latest `origin/main`.
5. Repeat affected focused tests plus Linux CI.
6. Only then prepare the PR and release workflow from `main`.

