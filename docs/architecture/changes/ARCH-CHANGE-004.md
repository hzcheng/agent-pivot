# ARCH-CHANGE-004 — Narrow MOD-WORKTREE-LIFECYCLE to one public entrypoint

Date: 2026-08-18
Status: approved by repository owner (review repair R8)
Modules: MOD-WORKTREE-LIFECYCLE

## Problem and evidence

W1 review Blocker 4: the Stage 1B RFC approved `src/worktrees/index.ts` as
the module's only public entrypoint, but the registry still declares the
whole `src/worktrees/**` surface public and the entrypoint does not exist.
Measured on the R7 merge base: 83 external import edges from 22 consumer
files deep-import 33 of the 36 internal files, so any internal move is
externally load-bearing and the strict-mode claim "the boundary is the
contract" is unenforced.

## Old rule → new rule

- Old: `publicEntrypoints: ["src/worktrees/**"]` — every internal file is
  importable; boundary enforcement for the module is a no-op.
- New: `publicEntrypoints: ["src/worktrees/index.ts"]`. The new entrypoint
  re-exports exactly the externally consumed surface (stores, controllers,
  handlers, protocol functions, identity codecs, and types). A composition
  role claims `index.ts` (the pilot RFC's designated role); every other file
  keeps its current role.

## Alternatives considered

- Keeping the coarse surface and policing only mayDependOn: rejected — that
  is exactly the state the review rejected; deep-import count into W1
  internals must reach zero before the module can re-enter strict.
- Splitting the surface across several thematic entrypoints: rejected for
  this wave; one entrypoint is the approved pilot design and keeps the
  migration mechanical. Re-partitioning later is a first-class operation.

## Compatibility and migration

No runtime, protocol, or persisted-format change. Consumer import paths move
to the entrypoint; symbol identity is preserved by re-export, so type and
value semantics are unchanged. Pure move, reviewed line by line.

## Tests

- Closed-world classification stays exact-once with `index.ts` in the
  composition role.
- Module boundary check: zero deep imports into `src/worktrees/` internals.
- Full deterministic suite, dashboard webview checks, and the coverage gate.

## Rollback

Revert the merge commit: the entrypoints widen and the consumers' import
paths return; no data or protocol state is involved.

## Machine summary

```arch-change
{
  "id": "ARCH-CHANGE-004",
  "status": "approved",
  "modules": ["MOD-WORKTREE-LIFECYCLE"],
  "delta": {
    "rePartition": true
  }
}
```
