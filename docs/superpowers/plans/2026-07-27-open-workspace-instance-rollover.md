# Open Workspace Instance Rollover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace stale open-workspace registrations when the workspace Extension Host reloads, without allowing delayed messages from the retired instance to reclaim the UI Bridge coordinator.

**Architecture:** Extend the existing serialized coordinator mutation boundary with an explicit active/retired instance lifecycle. Keep the wire protocol unchanged and protect the behavior with a focused contract regression owned by the Linux required check.

**Tech Stack:** TypeScript, VS Code Extension API, Node.js `node:test`, repository behavior-contract catalog.

## Global Constraints

- Work only in `.worktree/marketplace-identity`.
- Do not change the open-workspace protocol or workspace-card projection.
- Use RED-before-production-edit.
- Keep rollover atomic inside the existing coordinator mutation queue.
- A retired instance may neither reclaim ownership nor unregister the active replacement.
- The UI Bridge VSIX must be rebuilt for manual verification.

---

### Task 1: Protect Extension Host instance rollover

**Files:**
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `tests/contract/openProjects/coordinator.test.js`
- Modify: `extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts`

**Interfaces:**
- Consumes: `OpenWorkspaceCoordinator.publish(raw)` and `OpenWorkspaceCoordinator.unregister(raw)`.
- Produces: serialized replacement-instance takeover with retired-instance rejection.

- [ ] **Step 1: Add the behavior contract and failing regression**

Add `OPEN-WORKSPACE-INSTANCE-ROLLOVER-001` as an automated P0
`open-project` behavior owned by
`tests/contract/openProjects/coordinator.test.js`, with evidence in
`extensions/attention-ui-bridge/src/openWorkspaceCoordinator.ts`.

Add a coordinator test that publishes `SELF`, publishes `OTHER`, and asserts
that only `OTHER` remains. Then advance the fake clock and fire the interval,
asserting that only `OTHER` is renewed. Finally assert that a delayed `SELF`
publication rejects and a delayed `SELF` unregister leaves `OTHER` intact.

- [ ] **Step 2: Run RED**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/openProjects/coordinator.test.js
```

Expected: the new test fails when the second publication is rejected with
`open workspace coordinator received a different instanceId`.

- [ ] **Step 3: Implement minimal serialized rollover**

Add a retired-instance set. Replace the permanent binding check with logic
that rejects retired publishers, removes and retires the current instance
when a new publisher arrives, then creates the new instance store. Make
retired unregister requests no-ops while preserving strict validation for
unknown non-active IDs.

- [ ] **Step 4: Run focused GREEN**

Run:

```bash
npm run test-compile
node --test --test-concurrency=1 tests/contract/openProjects/coordinator.test.js
```

Expected: all coordinator tests pass.

- [ ] **Step 5: Run affected gates**

Run:

```bash
npm run test:behavior-contracts
npm run test:contract
npm run test:safety
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 6: Review and verify the branch**

Review the focused diff for rollover races and stale unregister behavior, then
run:

```bash
npm run test:ci:linux
```

Expected: the Linux CI-equivalent gate exits zero before the fix is committed
or prepared for VSIX testing.
