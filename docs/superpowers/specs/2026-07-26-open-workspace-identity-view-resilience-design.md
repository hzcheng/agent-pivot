# Open Workspace Identity and View Resilience Design

## Goal

Fix two release-blocking regressions without broadening the Agent Pivot feature
surface:

1. An `OTHER WINDOWS` card for a local or SSH workspace must not navigate to a
   Dev Container workspace that happens to expose the same filesystem path.
2. A transient AI-session runtime refresh failure must not replace the Agent
   Pivot dashboard with the generic render-failure page.

## Root Causes

The UI Bridge replaces workspace and root URI strings with the authoritative
URIs seen by the UI extension host, but it preserves identities derived from
the pre-rewrite URIs. The projection layer deduplicates by
`navigationIdentity`, so same-path workspaces from different authorities
collapse and the most recently focused record wins.

When the dashboard becomes visible, `DashboardRuntimeController` forces an
AI-session runtime refresh. It logs a refresh error and then rethrows it.
`AgentPivotViewProvider` treats that rejection as a failure to prepare the
whole view and renders the generic error page even though runtime discovery is
an auxiliary capability.

## Design

### Authoritative workspace identity

The UI Bridge will snapshot each authoritative `vscode.Uri` as both:

- its navigation string; and
- its identity components: `scheme`, `authority`, and `path`.

`replaceOpenWorkspacePublicationUris` will validate the original and
authoritative resource paths, replace the URI strings, and recompute every
identity derived from a replaced URI:

- each root `id`;
- `scopeIdentity` from the complete authoritative root set; and
- `navigationIdentity` from the authoritative navigation URI.

Single-folder navigation uses its sole root. Saved multi-root navigation uses
the authoritative workspace-file URI. Untitled multi-root workspaces continue
to be non-navigable; their root and scope identities are still authoritative,
while their navigation identity is replaced only when an authoritative
untitled workspace URI is available.

The bridge must use URI components supplied by VS Code rather than reparsing
the serialized URI. This preserves VS Code's decoded authority and path
semantics, including encoded remote authorities and literal percent escapes.

### Non-fatal runtime refresh

`DashboardRuntimeController.handleAiSessionViewVisibilityChanged` will keep the
forced refresh and structured runtime diagnostic, but it will resolve after a
refresh failure instead of rethrowing it. The backend already marks failed
discovery snapshots stale, so the dashboard can safely render its last known
state. Runtime-specific actions retain their existing error handling.

`AgentPivotViewProvider` remains strict for other visibility lifecycle
failures. The change is deliberately limited to the auxiliary runtime refresh
boundary so unrelated preparation defects still reach the safe error page.

## Regression Ownership

Two new P0 behavior contracts will own the regressions:

- `OPEN-OPEN-PROJECT-AUTHORITATIVE-IDENTITY-001` verifies distinct
  authoritative authorities produce distinct identities and distinct cards,
  while matching the current workspace identity derived from the same VS Code
  URI components.
- `RUNTIME-DASHBOARD-VISIBILITY-RESILIENCE-001` verifies a rejected runtime
  refresh is logged once and the visible dashboard still renders.

The focused tests are reached by the required `quality-linux` PR check through:

`npm run test:ci:linux` → `npm run test:deterministic:run` → contract and
integration tests.

The existing open-project safety script will be corrected so it no longer
asserts the invalid invariant that identities survive an authority rewrite
unchanged.

## Verification

Development follows RED/GREEN independently for each regression. Final
verification includes the focused tests, behavior-catalog validation,
open-project safety checks, dashboard checks, deterministic suites, tmux smoke,
the full Linux CI-equivalent gate, and a clean diff/status review.

Before release, manually reload the Extension Host after uninstalling the old
Project Steward extension and verify one local/SSH and one Dev Container window
that expose the same path remain separate and navigate correctly.

## Out of Scope

- Migrating or deleting historical Project Steward data.
- Changing the visual design of workspace cards or the generic error page.
- Making tmux discovery errors invisible; they remain structured diagnostics.
- Publishing to the VS Code Marketplace.
