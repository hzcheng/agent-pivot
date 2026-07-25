# Task 10 Report: Production Conversation Composition

## Status and commits

Complete on branch `docs/active-session-conversation-outline-design`, based on
`10824ae`. The implementation history is:

```text
82a61b4 feat: wire Active Session conversation history
ee7663a docs: report production conversation composition
5740729 fix: harden conversation production lifecycle
```

Nothing was pushed, merged, or cleaned up.

## Outcome

- Added `createConversationCapability(options)` as the extension-host boundary
  for one lazy Codex app-server client, one adapter per provider, one
  coordinator, one reusable viewer, and one Host controller.
- Kept the documented TypeScript surface to one public one-argument overload.
  The implementation retains a second JavaScript argument only as the
  integration-test constructor seam.
- Bound the viewer directly to the coordinator's authoritative
  `readOutline`, `readPage`, and `watch` operations. Codex remains
  app-server-only; no transcript fallback was added.
- Added a unified capability reconcile used by both existing Dashboard
  lifecycle hooks. The Host now rereads and republishes current outline state
  with generation-safe suppression after lifecycle changes.
- Kept the viewer independent of sidebar visibility. When its exact
  current-workspace active authority disappears, it aborts the read, releases
  the watch, retains a stale snapshot, and prohibits new source reads. When
  authority returns, it establishes a fresh watch and authoritative read.
  Reconcile after panel closure is an idempotent no-op.
- Restored panel-close focus by first revealing Project Steward and then
  publishing one exact version-1 origin message. The Webview rejects malformed
  or wrong-project messages and restores ACTIVE before focusing the exact
  expanded marker, the same-row header, or the ACTIVE tab fallback. It never
  focuses another session.
- Derived trimmed conversation display names and deterministic normalized
  same-provider duplicate metadata from only the current workspace's active
  sessions. The existing viewer appends the first eight session-ID characters
  only for duplicates.
- Passed current workspace `workspace.roots[].hostPath` dynamically only to
  Claude source resolution. Duplicate Claude UUIDs follow workspace root
  changes and fail unavailable outside the current roots. Kimi and Codex source
  contracts are unchanged.
- Made construction ownership immediate and explicit. Successful resources
  transfer to their aggregate owner only after that owner is created, so
  Kimi, Claude, coordinator, viewer, and controller constructor failures
  release all earlier resources exactly once and produce one sanitized
  unavailable diagnostic.
- Kept the three exact ordinary Dashboard router keys and added structural AST
  guards for their production call targets, the single public factory
  overload, current-root/metadata wiring, and the structured Codex app-server
  spawn.
- Strengthened the composed Kimi flow to copy the committed
  `tests/fixtures/conversations/kimi/wire.jsonl` fixture and assert visible
  panel content, selected interaction, read-only HTML, source-call arity, and
  absence of fixture secrets, paths, and diagnostic leaks.

## TDD evidence

### Initial production composition RED

The original Task 10 tests and safety contracts were written before the
production composition existed:

```text
node --test tests/integration/dashboard/conversationRouting.test.js
  exit 1: composition module missing

node --test tests/integration/dashboard/errorRecovery.test.js
  exit 1: composition module missing

node scripts/run-ai-session-safety-checks.js
  exit 1: production composition missing
```

The first implementation was committed in `82a61b4`.

### Review-fix RED

The five Important and two Minor review findings were converted to focused
tests before follow-up production changes:

```text
Host lifecycle reconcile                  0/2
Viewer authority suspend/resume           0/2
Composition focus restoration             0/2
Browser focus restoration                 0/2
Constructor-boundary ownership            0/5
```

Additional focused failures proved:

- the production capability had no unified `reconcile`;
- display metadata and the metadata helper were absent;
- duplicate Claude UUID resolution did not follow current workspace roots;
- the TypeScript AST exposed two public overload declarations plus the
  implementation;
- production panel close never executed the focus command or published the
  correlated origin message.

The committed Kimi fixture flow already passed when strengthened, confirming
the real Kimi adapter path while the other production gaps remained RED.

The scoped follow-up reviewer then found one additional focus race: an expanded
ACTIVE row can remain in the DOM after the user selects SESSIONS. The new
browser scenario actually selected SESSIONS and observed:

```text
ACTIVE-SESSION-CONVERSATION-FOCUS-001      0/1
actual ACTIVE aria-selected: false
expected ACTIVE aria-selected: true
```

Production now restores and persists ACTIVE before focusing the exact marker
or header and verifies the actual focused element.

### GREEN

The focused follow-up groups passed:

```text
Host lifecycle reconcile                  2/2
Viewer authority                          4/4
Production routing/lifecycle/display/
Claude roots/focus/Kimi                    6/6
Constructor recovery                      passed
Browser focus restoration                 2/2
AI session safety checks                  passed
```

The complete related files also passed:

```text
conversationCoordinator.test.js           37/37
conversationRouting/viewer/errorRecovery  50/50
activeSessionConversationOutline.test.js  16/16
```

## Final verification

Fresh verification after the final review fix:

```text
npm run test-compile                       passed
npm run test:deterministic:run             passed
npm run test:browser:run                   61/61
npm run test:safety:run                    passed
npm run test:dashboard:run                 passed
npm run test:architecture-baseline         passed
npm run test:architecture-guards           passed
git diff --check                           passed
src/media Webview script parity            passed
```

The final deterministic integration segment reported `201/201`. The complete
safety command reported:

```text
Workspace parity checks passed.
AI session tmux checks passed.
AI session safety checks passed.
Open workspace safety checks passed.
```

## Lint classification

A focused TSLint invocation over all changed TypeScript files exited `0`. Its
only warnings are unchanged legacy lines in `src/dashboard.ts`.

`npm run lint:ci` still reports:

```text
src/aiSessions/conversation/codexAppServerClient.ts semicolon 0=5
```

That file is byte-identical to `HEAD` before the follow-up and the same five
warnings pre-date Task 10. No changed file increased the warning baseline.

## Review

The initial root review reported five Important and two Minor findings. All
were reproduced, fixed, and verified.

The first read-only follow-up review reported:

```text
Critical:  0
Important: 1 (hidden ACTIVE panel focus restoration)
Minor:     1 (locale-dependent duplicate normalization)
```

Both were fixed. The second read-only scoped review of those fixes reported:

```text
Critical:  0
Important: 0
Minor:     0
Verdict:   Ready
```

The reviewer also confirmed source/media Webview scripts are byte-identical
and made no checkout changes.
