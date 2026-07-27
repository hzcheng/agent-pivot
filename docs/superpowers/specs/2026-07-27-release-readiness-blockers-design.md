# Agent Pivot Release-Readiness Blockers Design

## Problem

The marketplace-identity branch is functionally close to release, but two
deterministic blockers remain:

1. `activate()` returns before the public `agentPivot.*` commands are
   registered. A command invoked during background dashboard bootstrap can
   therefore fail with `command not found`.
2. The Attention spike packaging contract still contains pre-1.0 UI Bridge
   artifact names, and its renamed auto-run fixture still has the old fixed
   SHA-256 expectation.

## Goals

- Register the complete public command surface before background bootstrap
  starts.
- Keep `agentPivot.open` useful while the boot or failed shell is visible.
- Make every other command settle immediately with a stable error until the
  dashboard is ready.
- Bind ready handlers without registering commands a second time, and prevent
  failed, stale, or disposed bootstrap generations from retaining handlers.
- Derive current Attention artifact names and versions from package manifests.
- Keep the manual validation matrix aligned with the derived current artifact.
- Add deterministic PR-gated contracts for both regressions.

## Non-goals

- Queueing mutations issued before the dashboard is ready.
- Changing dashboard startup order, retry semantics, or provider protocols.
- Rewriting historical reports and plans that intentionally record older
  release versions.
- Treating arbitrary bridge handshake fixture versions as release identities.

## Command Lifecycle

`DashboardCommandRegistration` becomes a stable command facade. It registers
the ten contributed commands exactly once and owns immutable callbacks for the
extension lifetime.

Before a ready handler generation is active:

- `agentPivot.open` reveals the existing Agent Pivot view container and focuses
  the dashboard, so the boot or failed shell is visible.
- the remaining commands reject immediately with a stable startup message.
  They are neither silently ignored nor held behind an unbounded promise.

At the end of a successful dashboard composition, the facade stages handlers
for that bootstrap generation. The bootstrap completion callback first asks
the provider to adopt the ready dashboard and then activates the matching
staged command handlers. A rejected, failed, stale, or disposed generation is
discarded. The facade itself is context-owned, while generation handlers remain
generation-owned.

The existing dashboard reveal sequence is extracted as a reusable helper so
boot-time `open` and ready-time `open` keep the same container/focus fallback
behavior.

## Attention Artifact Identity

The package manifest in each extension directory is the source of truth for
the artifact filename:

```text
<manifest.name>-<manifest.version>.vsix
```

Both the spike packager and its contract checks derive the UI Bridge and
workspace probe paths from those manifests. The manual matrix remains static
human documentation, so deterministic tests verify that it contains the
currently derived filenames.

The auto-run filename contract retains a fixed expected digest independent of
the implementation under test, but updates that digest to the renamed Agent
Pivot fixture path.

Historical specifications and reports keep their recorded versions. The
workspace-first acceptance report generator is handled only as a complete
current generator: its main and bridge artifact identities must either both be
manifest-derived or remain explicitly historical.

## Testing and CI

`WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001` proves that activation exposes all
ten commands while bootstrap is pending, boot-time `open` reveals the existing
view, unavailable commands settle, retry generations can bind fresh handlers,
and disposal removes references.

`RELEASE-ATTENTION-SPIKE-ARTIFACT-VERSION-001` proves that Attention artifact
paths and the manual matrix follow the package manifests.

Both contracts are owned by deterministic Node test suites reached by
`test:ci:linux` and the required GitHub `quality-linux` job. The real Extension
Host smoke also checks the registered command surface immediately after
activation, but remains supplemental because it is not the only PR gate.

