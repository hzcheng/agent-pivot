---
name: resilient-webview-mutation-protocols
description: Use when Agent Pivot VS Code Webviews submit Host-owned mutations or authoritative HTML replacement, mirrored persistence, stale acknowledgements, stuck pending UI, focus loss, or partial batch failures are in scope.
---

# Resilient Webview Mutation Protocols

## Overview

Treat an Agent Pivot Webview mutation as one correlated lifecycle across protocol, Host
persistence, authoritative DOM replacement, and UI recovery. Keep the Host
authoritative; let the Webview submit intent and display only transient pending
state until authoritative state is applied.

## Repository Layout

Webview script sources live in `src/webview/*.js`; the byte-identical
`media/*.js` copies are BUILD OUTPUTS regenerated from the manifest's
`directCopies` declarations by every `npm run test-compile`
(`scripts/lib/webviewDirectCopies.js`) and are never committed. Edit only
`src/webview/`; browser tests load `src/webview/`, while the running
extension loads the generated `media/` copies, so the release packaging check
asserts packaged bytes equal the `src/webview/` sources.

Register every new Webview script in all of these places, or the package
silently ships without it while unit checks keep passing:

1. `src/webview/<name>.js` (canonical) plus its `directCopies` entry in
   `docs/testing/architecture-webview-manifest.json` — the architecture check
   fails closed when a bundle member omits it (only an explicit `bundledOnly`
   entry may skip it).
2. The document builder (e.g. `src/aiSessions/conversation/viewerDocument.ts`):
   `asWebviewUri` + nonce `<script>` tag ordered before the main script; the
   integration script-order chain asserts the position.
3. `.vscodeignore`: re-include `media/<name>.js` alongside its siblings.
4. `scripts/run-release-packaging-checks.js`: `EXPECTED_MAIN_ENTRIES`.
5. The browser test harness (`tests/browser/conversationViewer.test.js`):
   `fs.readFileSync` plus the `page.route` fulfillment for the new basename.
6. `docs/testing/behavior-contracts.json`: list the file in the owning
   contract's `evidence`.

Find every consumer by grepping an existing sibling script name (e.g.
`conversationReconcileScripts`) across the repository.

Styles follow the same generated-copy pattern: edit `media/styles.scss` and
regenerate the tracked, minified `media/styles.css` with
`npx gulp buildStyles` in the same commit. `test-compile` does not rebuild
it, and `scripts/run-ai-session-safety-checks.js` asserts selectors against
both the scss source and the compiled css, so a stale regeneration fails
there first.

Dashboard webview scripts are also evaluated in minimal Node VM sandboxes by
`scripts/run-dashboard-webview-checks.js` (`vm.runInNewContext` with a
hand-built `document`/`window`): no timers (`setTimeout` is undefined), no
`MutationObserver`, no `window.requestAnimationFrame` — only a bare global
`requestAnimationFrame`. Gate every optional global behind a
`typeof … === 'function'` check and follow the bare `requestAnimationFrame`
convention used by sibling scripts; an unguarded timer or observer throws
`ReferenceError` in the VM checks while real browsers stay silent.

Webview CSS selectors and DOM APIs must also run on the oldest supported
Workbench, not on the test harness: check `package.json` `engines.vscode`
(for example `^1.51.0` ≈ Chrome 83) before using modern features such as
`:has()`, container queries, or `structuredClone`. The browser tests always
launch a current Playwright Chromium, so an unsupported feature passes every
check and reaches users as silently broken layout or script errors. When
support is uncertain, drive state-dependent styling from Host-rendered
classes (kept in sync by the toggle handler) instead of modern CSS
selectors.

## Core Invariants

- Keep persistent state Host-authoritative. Never make optimistic Webview state
  appear committed.
- Define domain validity independently of current UI availability. Permit a
  selected-but-unavailable provider when the domain permits it.
- Correlate every request and settlement with a schema version, fresh
  `requestId`, operation, and authoritative target identity.
- Settle every recognized request exactly once. Clear success pending only
  after its correlated authoritative replacement is applied; clear failure
  pending only through its correlated failure.
- Keep popup openness, focus, and scroll local to the Webview replacement.
- Treat mirrored-state partial writes and composite-batch partial results as
  explicit failures or partial outcomes, never full success.

## Workflow

Use this checklist for each Host-owned mutation:

1. Define the versioned request, correlated settlements, authoritative target,
   operation payload, and validation rules.
2. Store the exact pending identity without changing persistent Webview state.
3. Resolve identity and domain rules from Host state, not DOM labels,
   availability, row indexes, or client snapshots.
4. Route every Host validation, guard, persistence, execution, and refresh
   outcome to exactly one settlement.
5. Apply correlated authoritative HTML before clearing success pending; on a
   correlated failure, clear only the matching pending entry.
6. Capture and restore local popup, semantic focus, and scroll around DOM
   replacement without sending them across the Host boundary.
7. Snapshot, write, and repair all mirrored persistence records as one logical
   mutation.
8. Use composite identities for batch items, preserve explicit partial results,
   refresh once, and settle aggregate pending once.
9. Test correlation, every settlement path, replacement and focus recovery,
   both mirrored writes and repair, composite collisions, partial results, and
   accessible announcements.

## Protocol Contract

Require every request and settlement to carry:

```ts
type MutationEnvelope = {
  version: 1;
  requestId: string;
  projectId: string;
  operation: 'selectProviders' | 'archiveSessions';
  payload: unknown;
};
```

Generate a fresh `requestId` per intent. Use the authoritative target identity,
such as `projectId`, plus exactly one operation-specific payload. Return the
same schema version, `requestId`, target, and operation on success and failure.

Validate the complete shape, bounds, and operation discriminant. Reject unknown
fields when practical. Resolve targets and permissions from Host state. Never
trust display labels, DOM data, or client-provided state as authority. Fail
closed on malformed, wrong-target, stale, duplicate, or out-of-order messages.

## Pending And Replacement Lifecycle

- Key pending state by the full correlation identity. Do not let rapid input
  overwrite an in-flight `requestId`; lock the control or represent later
  intent with a separate correlated request.
- Disable controls and announce pending without mutating persistent UI state.
- Make every recognized Host request reach exactly one settlement, including
  validation failures, guard failures, early returns, thrown errors,
  persistence failures, and refresh failures.
- Treat a standalone acknowledgement as progress, not success. Keep pending
  until either a matching failure arrives or the matching authoritative
  replacement has been validated and applied.
- Before replacement, capture only local transient state: popup openness,
  focused semantic item, and relevant scroll position. Apply authoritative
  HTML first, then clear matching pending.
- Restore popup state only if the matching control still exists and the pending
  lifecycle permits reopening it. Restore focus by semantic key, never by a
  detached node or row index. Keep transient popup state out of Host messages.
- Ignore stale or duplicate settlements without changing current pending state.
  On correlated failure, clear only the matching operation and leave or
  restore the authoritative UI.

## Mirrored Persistence

Treat canonical and compatibility records as one logical write:

1. Snapshot both authoritative records.
2. Validate the complete intended state before writing.
3. Write the canonical record, then the compatibility mirror.
4. If either write fails, restore or repair both records from the snapshot when
   possible.
5. Report the mutation as failed, including repair failure without exposing
   sensitive identity.
6. Refresh from actual authoritative store state, not in-memory assumptions.

A first-write failure, second-write failure, or repair failure is never full
success. Ensure reload observes the same state the refreshed Webview renders.

## Composite Batch Operations

Use a composite identity such as `{ provider, sessionId }`; a bare `sessionId`
is insufficient across providers. Bound and deduplicate inputs by the composite
key, resolve each item against authoritative Host state, group execution by
provider, and collect every group result. Refresh authoritative HTML once after
all groups settle.

Keep partial results explicit. Report bounded success and failure counts plus
provider-safe summaries in logs and polite live-region announcements. Do not
expose full session identifiers. Settle pending once for the aggregate request,
not once per provider.

## Verification Matrix

| Exercise | Required assertion |
|---|---|
| Malformed, unknown, or wrong-target input | Reject closed; settle a recognized request exactly once |
| Stale, duplicate, or out-of-order settlement | Preserve current pending and authoritative UI |
| Every early return and thrown error | Emit one correlated failure; never leave stuck pending UI |
| Success acknowledgement before replacement | Keep pending until correlated authoritative HTML is applied |
| Replacement with open popup or focus | Keep popup state local; restore only an existing semantic target |
| Selected provider currently unavailable | Accept it when domain rules allow selected-but-unavailable state |
| First or second mirrored write fails | Repair from snapshot, report failure, and refresh actual store state |
| Mirrored repair also fails | Expose failure safely and render observed authoritative state |
| Duplicate session IDs across providers | Distinguish composite keys and execute the correct provider group |
| Some batch groups fail | Preserve partial results, refresh once, and announce bounded counts |
| Keyboard operation and status updates | Preserve focus-visible behavior and use a polite live region |

## Common Mistakes

| Mistake | Correction |
|---|---|
| Update persistent controls optimistically | Show pending only; render committed state from the Host |
| Require every selected provider to be available | Enforce domain invariants, not transient availability |
| Clear pending on a generic acknowledgement | Wait for correlated failure or applied authoritative replacement |
| Send popup or focus state to the Host | Capture and restore it locally around replacement |
| Reuse one mutable pending slot | Lock input or track each later intent with its own `requestId` |
| Identify targets by label, row index, or bare session ID | Resolve Host identities and use semantic or composite keys |
| Treat one successful mirrored write as success | Repair from the snapshot, fail the mutation, and refresh |
| Collapse a partial batch into success or failure | Preserve per-group results and announce bounded totals |
| Decorate a tooltip-bearing element with `::before`/`::after` (rings, badges) | Tooltip systems (e.g. `conversation-telemetry-tooltip`) already own the element's pseudo-elements: shared pseudo-elements leave the decoration hidden by the tooltip's default rules and let state selectors restyle the hover tooltip instead. Grep the stylesheet for existing `::before`/`::after` rules on the element's classes first, and draw rings/badges with `box-shadow`/`outline` on the element itself |
| Assert on raw tag adjacency (e.g. `>Approved<`) in `panel.webview.html` | The initial publication embeds page HTML entity-escaped (`&gt;`/`&lt;`); assert on entity-safe substrings such as class names or plain text |
| Extend a conversation page message shape without auditing every protocol hop | Enumerate all role/payload whitelists — the coordinator runtime validator, the coordinator page transform, and the viewer publication copy — route copies through `copyConversationMessage`, and add a coordinator-level owner test so a missing hop fails CI instead of the user |
| Add a conversation source module without registering it in the architecture-guard fixture | `copyGuardFixture` in `tests/unit/tooling/architectureGuards.test.js` copies an explicit real-file list into its synthetic tree; register every new conversation module there or all guard tests fail on the unresolvable import |
| Attach version-skew strips to the wrong fixture chain | `previousViewerScript` and `previousOutlineScript` in `tests/browser/conversationViewer.test.js` are independent `.replace()` chains pinned by separate sha256 asserts; append strips for newly added Webview code to the chain of the script that actually contains it (a strip on the wrong chain silently no-ops). Fastest verification: apply the candidate strips standalone and diff the result byte-for-byte against `git show <merge-base>:<script>` (byte equality is exactly what the pinned hash certifies), then run the whole browser file |
| Gate payload omission on a signature of render inputs only | An omission/delta signature must identify the omitted *content* — mix in a content or render version that changes whenever the payload is re-produced — because deterministic ids and render inputs stay constant across in-place content updates; pin a test that mutates content without changing ids and asserts full redelivery |
| Treat `postMessage` delivery as Webview application | Only a correlated applied acknowledgement (generation + request id + content signature) may authorize omitting payload from later publications; a delta the Webview cannot apply must answer with a full-resync request, and the Host must bound rebuilds per publication so a persistent failure cannot reload-loop |
| Assert computed styles against a host-rendered document without styles | `openHostViewerDocument` fulfills `/conversationViewer.css` with an empty body unless the test passes `includeStyles: true` plus a `viewerThemeFixtures` entry, and the real document CSP blocks `page.addStyleTag`; reserve `addStyleTag` for synthetic `openViewerPage` pages |
