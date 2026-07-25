# Task 10 Report: Production Conversation Composition

## Status and commits

Complete on branch `docs/active-session-conversation-outline-design`, based on
`10824ae`. The production implementation and tests were committed as:

```text
82a61b4 feat: wire Active Session conversation history
```

Nothing was pushed, merged, or cleaned up.

## Outcome

- Added `createConversationCapability(options)` as the extension-host
  composition boundary for one Codex app-server client, one adapter per
  provider, one coordinator, one reusable viewer, and one Host controller.
- Bound the viewer directly to the coordinator's authoritative
  `readOutline`, `readPage`, and `watch` operations. Codex content uses only
  the private app-server stdio client; Kimi and Claude continue to resolve
  sources through their existing provider services.
- Added a narrow optional second factory argument for integration tests. The
  documented one-argument production overload and `ConversationCapabilityOptions`
  surface remain unchanged.
- Kept partial construction failure inside the composition factory. It
  releases already-created resources, reports exactly one sanitized
  `conversation-read/unavailable` diagnostic, and returns an idempotent
  unavailable capability that publishes only the public unavailable error.
- Wired the three exact ordinary Dashboard router keys for outline, open, and
  cancel messages. No provider-specialized router field or parallel route was
  added.
- Resolved authority through the exact current workspace card and exact
  provider/session active row. The Host continues to require focus for
  sidebar outline reads and projects stopped lifecycle state through the
  coordinator.
- Reconciled conversation state after authoritative AI-session refresh and
  active-terminal focus changes.
- Released sidebar-owned subscriptions when the sidebar hides or its Webview
  is disposed, while leaving the independent conversation viewer alive.
- Registered viewer/capability lifecycle ownership with extension
  subscriptions. Capability disposal is idempotent and transitively closes
  coordinator, adapters, and the lazy Codex child.
- Preserved older test/activation Webview doubles by feature-detecting
  `onDidDispose`; real VS Code Webview views register the disposal callback.
- Added a composed Kimi flow that requests an outline through the public
  message path, opens one selected interaction in one `AI Conversation`
  panel, closes it, and proves private prompt text never reaches diagnostics.

## TDD evidence

### RED

Tests and safety contracts were added before production composition:

```text
npm run test-compile
  exit 0

node --test tests/integration/dashboard/conversationRouting.test.js
  exit 1: Cannot find module '../../../out/aiSessions/conversation/composition'

node --test tests/integration/dashboard/errorRecovery.test.js
  exit 1: Cannot find module '../../../out/aiSessions/conversation/composition'

node scripts/run-ai-session-safety-checks.js
  exit 1: composition.ts did not exist
```

The first full deterministic run after implementation exposed five activation
harness failures because older Webview test doubles did not implement
`onDidDispose`. The production provider was then made compatible with those
doubles while retaining disposal registration for real VS Code views. The
focused activation regression tests and a fresh full deterministic run passed.

### GREEN

The final focused gate passed:

```text
npm run test-compile
node --test tests/integration/dashboard/conversationRouting.test.js
node --test tests/integration/dashboard/errorRecovery.test.js
node scripts/run-ai-session-safety-checks.js
git diff --check
```

Observed results:

```text
conversationRouting.test.js: 6/6 passed
errorRecovery.test.js: 14/14 passed
AI session safety checks passed.
```

The broader regression gates also passed:

```text
npm run test:deterministic       189/189 integration tests passed
npm run test:browser:run         59/59 passed
npm run test:dashboard:run       passed
npm run test:architecture-baseline
npm run test:architecture-guards
npm run test:safety:run
```

The complete safety command reported:

```text
Workspace parity checks passed.
AI session tmux checks passed.
AI session safety checks passed.
Open workspace safety checks passed.
```

## Lint and diff review

A focused TSLint invocation over all changed TypeScript files exited `0`.
It emitted only unchanged legacy Dashboard warnings outside the modified
hunks. `git diff --check` passed.

`npm run lint:ci` still reports:

```text
src/aiSessions/conversation/codexAppServerClient.ts semicolon 0=5
```

Those five warnings pre-date Task 10, are in an unchanged Task 5 file, and are
not introduced by this commit. No Task 10 file increased the warning set.

## Self-review

- Confirmed the production factory constructs exactly one provider graph and
  the Codex process remains lazy, so two viewer opens use at most one child.
- Confirmed partial-construction cleanup tolerates nested and repeated
  disposal without leaking or surfacing caught error text.
- Confirmed Dashboard authority rejects wrong project/provider/session
  identities and the Host rejects unfocused outline targets.
- Confirmed sidebar hiding disposes only the card subscription; viewer
  ownership remains independent until panel or extension disposal.
- Confirmed source checks prohibit Codex JSONL fallback, provider-specific
  routing branches, and private diagnostic fields.
- Confirmed only the seven Task 10 implementation/test files and this report
  are included.
