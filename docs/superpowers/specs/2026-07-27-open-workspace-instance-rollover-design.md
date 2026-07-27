# Open Workspace Instance Rollover Design

## Goal

Prevent the current VS Code window from appearing as a stale `OTHER WINDOWS`
card after its workspace Extension Host reloads.

## Root Cause

The workspace extension creates a fresh random `instanceId` on every
activation. The per-window UI Bridge coordinator binds permanently to the
first instance, rejects publications from the replacement instance, and keeps
renewing the old registration. The old registration therefore never expires.

## Design

The UI Bridge coordinator will treat a publication from a new `instanceId` as
an Extension Host generation rollover for the same VS Code window.

Inside the existing serialized mutation queue, rollover will:

1. remove the previous instance registration;
2. retire the previous instance ID so delayed old publications cannot reclaim
   ownership;
3. create and bind the store for the replacement instance; and
4. publish and renew only the replacement registration.

An unregister request from a retired instance will be an idempotent no-op. It
must not remove or otherwise disturb the active replacement registration.
Publications from retired instances will be rejected.

This is safe at the coordinator boundary because the UI Bridge has
`extensionKind: ["ui"]` and each VS Code window owns its own coordinator and
command registrations. A different workspace-side instance reaching that
coordinator represents a generation change within that window, not another
VS Code window.

## Regression Ownership

`OPEN-WORKSPACE-INSTANCE-ROLLOVER-001` will be an automated P0 open-project
behavior owned by `tests/contract/openProjects/coordinator.test.js`, with
implementation evidence in
`extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts`.

The regression will prove that:

- a replacement instance removes the prior registration;
- lease renewal applies only to the replacement;
- a delayed prior publication cannot reclaim ownership; and
- a delayed prior unregister cannot remove the replacement.

The owner is reached by the required Linux PR check through:

`quality-linux` → `npm run test:ci:linux` →
`npm run test:deterministic:run` → contract tests.

## Verification

Development follows RED/GREEN with the focused coordinator contract test.
Final verification includes behavior-catalog validation, the full contract
suite, open-project safety checks, TypeScript compilation, and the Linux
CI-equivalent gate before merge.

Manual VSIX verification requires updating the UI Bridge extension because
the production fix lives in that extension.

## Out of Scope

- Changing workspace card visuals or deduplication rules.
- Changing the open-workspace protocol version.
- Changing navigation behavior.
- Publishing or merging the branch.
