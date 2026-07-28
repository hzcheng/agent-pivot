# Nested Container Provider Launch Design

**Date:** 2026-07-28

**Status:** Approved for planning

## Problem

Agent Pivot currently blocks a new AI session when its provider picker cannot
find the provider command by scanning the Extension Host's `PATH`.

That check can produce a false negative in a nested remote topology:

```text
local VS Code
  -> Remote SSH host
    -> Open Folder in Container
      -> DevBox container
```

In the reported DevBox window, the innermost Extension Host environment
included `/usr/local/bin`, `/usr/local/bin/kimi` existed, and
`kimi --version` succeeded. Nevertheless, the picker showed:

```text
Unavailable — kimi was not found on PATH
```

The picker therefore prevented a command that the actual Terminal runtime
could execute.

## Decision

The provider picker will stop treating a synchronous `PATH` scan as an
authorization gate.

Every registered provider remains selectable. After selection, the existing
session-creation flow creates the Terminal or tmux runtime and sends the
provider launch command unchanged. If the executable is genuinely missing,
the real runtime reports that failure in the Terminal.

This change applies equally to Codex, Kimi, and Claude. It does not add a
Kimi-specific path, fallback directory, shell invocation, or remote-container
special case.

## Rationale

The provider command is ultimately resolved by the runtime that launches it.
An earlier filesystem scan is a time-of-check/time-of-use approximation and
can disagree with Terminal, shell, tmux, SSH, or Dev Container environment
construction.

Allowing the real runtime to decide:

- removes the false blocking state;
- preserves the user's ability to inspect the actual command error;
- avoids duplicating VS Code and shell environment resolution;
- keeps the same behavior across local, SSH, WSL, and container windows.

## Alternatives Considered

### Keep the check and add “Launch Anyway”

This would recover from false negatives, but it would retain an unreliable
warning and add an unnecessary confirmation step to every affected launch.

### Reconstruct the innermost login-shell environment

This would add process and shell-specific complexity without guaranteeing the
same environment as the eventual direct or tmux runtime.

### Add known Kimi installation directories

This would address only selected installations, would not generalize to other
providers, and would still be vulnerable to remote-boundary mismatches.

## User Experience

The NEW provider picker shows each registered provider as an ordinary enabled
choice with:

```text
Open a new <Provider> session
```

It no longer displays `Unavailable — <command> was not found on PATH` or loops
back to the picker after selecting a provider that failed the preliminary
scan.

The rest of the flow is unchanged: optional title input, workspace-root
selection, pending-session state, runtime creation, and Terminal focus retain
their current behavior.

## Implementation Boundary

Remove the provider-availability gate from the picker wiring in
`src/dashboard.ts`.

Delete `src/aiSessions/providerAvailability.ts` only if no production caller
remains after the picker change. Remove or replace tests and catalog evidence
that protect the old blocking behavior. Do not alter provider definitions,
command builders, Terminal launch serialization, tmux discovery, or DevBox
configuration.

## Regression Ownership

Add a CI-owned behavior contract at the lowest stable layer that exercises
the production picker wiring or its extracted pure model. The test must prove
that all registered providers remain selectable without consulting executable
availability.

The owner must be reached by the required `quality-linux` PR check through:

```text
package.json test:ci:linux
  -> test:deterministic:run
    -> focused unit, contract, or integration owner
```

Before production code changes, the new test must fail against `origin/main`
because the current picker still performs the blocking availability check.

## Verification

The implementation is complete when:

1. the focused regression test passes;
2. `npm run test:behavior-contracts` passes;
3. the affected layered suite passes;
4. `npm run test:safety:run` passes;
5. `npm run test:ci:linux` passes;
6. a locally packaged extension can select Kimi from NEW in the nested DevBox
   window without showing the unavailable message.

The final manual check validates the real nested environment. Automated
coverage protects the host-side decision not to block provider selection.
