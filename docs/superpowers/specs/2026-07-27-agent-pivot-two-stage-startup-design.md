# Agent Pivot Two-Stage Startup Design

## Problem

Opening the Agent Pivot view still leaves a visible blank interval even after
runtime enrichment was removed from the first-render path.

Evidence from the July 27, 2026 Dev Container reload shows:

- VS Code began activating `hzcheng.agent-pivot` at 09:04:12.783.
- the Open Workspaces client was constructed at 09:04:13.854;
- the first cold workspace/session card build took 124 ms;
- a later `dashboard-visible` incremental message build took only 7 ms.

The remaining user-visible delay is therefore dominated by the extension
activation boundary, not by the incremental session message. VS Code cannot
show the registered Webview while activation is still waiting for unrelated
startup work.

## Goals

- Replace the initial blank view with a stable Agent Pivot boot shell as soon
  as the view is resolved.
- Return from the public extension activation path without waiting for the
  complete dashboard bootstrap.
- Preserve the existing order and safety guarantees of runtime restoration,
  storage migration, controller composition, and authoritative publication.
- Upgrade the same Webview from boot shell to the real dashboard exactly once
  for each successful bootstrap generation.
- Make bootstrap failures visible, privacy-safe, and retryable.
- Add diagnostics that distinguish extension activation, shell delivery,
  bootstrap completion, and browser-visible first paint.

## Non-goals

- Persisting rendered dashboard HTML between extension-host processes.
- Rendering stale project or session data as if it were authoritative.
- Changing session discovery, runtime restoration, data migration, or bridge
  protocols.
- Optimizing steady-state scrolling, expansion, or incremental updates.
- Adding a second Webview, editor, panel, or window.

## Considered Approaches

### 1. Two-stage startup

Register a boot-capable provider immediately, return from activation, and run
the current dashboard composition in a managed background bootstrap. The
provider first renders a stable shell and later adopts the real dashboard
callbacks.

This directly removes the blank activation interval and retains the current
initialization order. It is the selected approach.

### 2. Make only late startup work nonblocking

Keep the current provider composition but detach
`DashboardStartupController.startUp()`. This is a smaller change, but runtime
and persistence restoration before provider construction would still leave a
substantial blank interval. It improves the symptom without guaranteeing
immediate visual feedback.

### 3. Persist and replay the previous HTML

Store the previous complete dashboard document and replay it at startup. This
would be fast but introduces stale session state, versioning, privacy, and
resource-URI problems. It is rejected.

## User Experience

When Agent Pivot is opened during extension activation:

1. The normal view container appears.
2. The Webview immediately shows an Agent Pivot boot shell containing the
   existing top-level tab geometry and stable card-shaped placeholders.
3. The shell is marked `aria-busy="true"` and contains no controls that appear
   actionable but cannot work.
4. With reduced motion enabled, the shell is static. Otherwise it may use the
   existing restrained loading treatment without changing layout.
5. When bootstrap succeeds, the same Webview document is replaced once with
   the authoritative dashboard.
6. The replacement must not open an editor, side panel, or window.

The initial shell is a temporary state, so it does not preserve card scroll or
focus into the authoritative document. After the authoritative dashboard is
mounted, all existing scroll, focus, expansion, and incremental replacement
contracts continue unchanged.

If bootstrap fails, the shell becomes a privacy-safe startup error view. It
shows a real Retry action owned by the boot layer. Retry starts a new bootstrap
generation in the same view. The error must not contain paths, session IDs,
provider payloads, stack traces, or raw error messages.

## Architecture

### Boot-capable view provider

`AgentPivotViewProvider` gains an explicit boot lifecycle:

- `booting`: render the boot shell and accept only the boot protocol;
- `ready`: use the authoritative dashboard callbacks;
- `failed`: render the safe startup error and accept Retry.

The provider remains the only object registered for
`agentPivot.dashboard`. It does not register a temporary second provider.

The provider's authoritative callbacks are installed after dashboard
composition succeeds. Existing message, visibility, disposal, refresh, and
generation behavior remains inside the same provider. Adopting the
authoritative callbacks triggers one current-view refresh followed by the
normal visible preparation sequence.

### Fast public activation

The exported activation function performs only the work required to own the
view safely:

1. create the Agent Pivot output/diagnostic boundary;
2. create the boot-capable provider;
3. register the provider and its boot lifecycle disposal;
4. start a managed dashboard bootstrap generation;
5. return without awaiting that generation.

The current dashboard composition moves behind a bootstrap function. It
continues to execute runtime restoration, controller construction, migration,
event registration, and startup behavior in their existing semantic order.
The refactor must not parallelize operations that currently require ordering.

### Bootstrap owner

A small bootstrap owner coordinates:

- one active generation;
- cancellation/disposal;
- retry after failure;
- authoritative callback adoption;
- sanitized failure reporting.

Only the latest non-disposed generation may change provider state. A Retry
invalidates the failed generation before beginning another. Extension
deactivation invalidates the generation and disposes every resource that a
partially completed bootstrap has already created.

Resources created during bootstrap must be added to an owned disposable
collection as they are created. A failed or superseded generation releases its
partial collection exactly once. Successful resources transfer to the
extension context exactly once.

## Data and Control Flow

```text
VS Code activates extension
        |
        v
register boot-capable provider -----> resolve view -> render boot shell
        |
        +---- return activation
        |
        v
background bootstrap, existing order
        |
        +---- failure -> sanitize -> failed shell -> Retry
        |
        v
install authoritative callbacks
        |
        v
refresh same view once -> normal visible preparation -> incremental updates
```

The boot shell contains no project, workspace, provider, session, prompt, or
TODO data. Authoritative data remains owned by the existing services and is
read only after the bootstrap reaches `ready`.

## Protocol

The boot layer accepts one exact versioned message:

```ts
{
    type: 'retry-agent-pivot-bootstrap';
    version: 1;
}
```

It is accepted only in `failed`. Unknown, malformed, duplicate, booting, or
ready-state boot messages have no effect. Dashboard messages are routed only
in `ready`.

## Diagnostics and Performance Evidence

Diagnostics record bounded, non-sensitive events using a monotonic generation
number and durations, never absolute paths or session identities:

- `agent-pivot-activation-entered`;
- `agent-pivot-boot-shell-assigned`;
- `agent-pivot-bootstrap-ready`;
- `agent-pivot-browser-first-paint`;
- `agent-pivot-bootstrap-failed`, with a stable category only.

The boot document posts `agent-pivot-browser-first-paint` on the first
animation frame after its root is mounted. Host diagnostics correlate it with
the current boot generation and ignore stale acknowledgements.

The product target is:

- no blank document after Webview resolution;
- activation returns while bootstrap is still pending;
- boot shell assignment precedes any awaited dashboard bootstrap work;
- the real Dev Container trace should show the boot shell substantially before
  the former three-second first-content point.

CI owns ordering and state correctness, not wall-clock thresholds. Real timing
is evaluated from the emitted diagnostics in the installed extension.

## Error Handling

- Synchronous boot-provider failures render the existing safe view error.
- Dashboard bootstrap failures are logged through the sanitized diagnostic
  boundary and transition only the latest generation to `failed`.
- A failure never replaces a healthy authoritative dashboard.
- Retry is single-flight; repeated activation is ignored while booting.
- A superseded or disposed generation cannot install callbacks, refresh HTML,
  post messages, or retain resources.
- Failure of browser first-paint acknowledgement is diagnostic-only and does
  not replace the shell or dashboard.

## Testing and CI Ownership

The change receives a P0 automated behavior contract for nonblank two-stage
startup. Focused tests must prove:

- activation returns while an injected bootstrap promise remains unresolved;
- a resolved view receives boot HTML before bootstrap completion;
- the shell contains no authoritative or private data and has no inert
  controls;
- successful bootstrap upgrades the same view exactly once;
- the ready transition runs current visible preparation;
- failed bootstrap produces only the safe error state;
- Retry creates one newer generation;
- stale, failed, replaced, and disposed generations cannot update the view;
- partial bootstrap resources are disposed exactly once;
- ready-state dashboard messages retain their existing routing behavior;
- the first-paint acknowledgement is accepted only for the current generation.

The focused owner must be reachable through:

```text
test file
  -> npm run test:deterministic:run
  -> npm run test:ci:linux
  -> required quality-linux check
```

Browser coverage verifies shell geometry, `aria-busy`, reduced motion, the
single in-place transition, and the functional Retry action. Existing
Extension Host, remote-source, runtime-composition, Webview recovery, scroll,
focus, and conversation tests remain required.

Before packaging, run the focused tests, behavior-contract validation, the
affected deterministic and browser layers, safety checks, and the complete
Linux CI equivalent.

