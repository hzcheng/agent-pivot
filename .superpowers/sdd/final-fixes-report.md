# Active Session Conversation Outline — Final Fixes Report

## Status

The whole-branch review findings were fixed test-first in:

```text
295f061a7de35b1b98992bb193a3342d5a400b72 fix: align conversation adapters with production formats
```

Nothing was pushed, merged, installed, or cleaned up.

Review package:

```text
.superpowers/sdd/review-b207acc..295f061.diff
```

## Production-format adapters

- Kimi now reads only the canonical
  `{ timestamp, message: { type, payload } }` envelope. The provider contract,
  composition tests, privacy assertions, live-watch test, and performance
  harness share the checked-in canonical provider fixture. Legacy invented
  top-level records are ignored.
- Claude now accepts canonical string `message.content` as well as visible
  content-block arrays. Sidechain, tool-result, hidden, and non-visible blocks
  remain excluded.
- Codex remains app-server-only. Its obsolete filesystem source resolver was
  removed, and controlled architecture mutations reject either a resolver
  reintroduction or composition routing through one.

## Bounded reading, live updates, and outline cap

- An invalid unterminated JSONL tail is retained at its line start, does not
  increment the malformed count, and is emitted once when a later append
  completes it. A valid final record without a newline remains accepted.
- Exact 256 KiB multibyte-split and exact 1 MiB physical-line boundaries are
  locked by regression tests.
- Kimi's live fingerprint includes bounded file size/mtime identity, so an
  append to an already non-empty `wire.jsonl` triggers a refresh.
- More than 2,000 normalized user interactions now marks the outline partial,
  retains the newest 2,000, and keeps viewer navigation on authoritative global
  positions. For example, `Input 2001 of 2,000+` means global input 2001 is
  selected while the UI exposes a known lower bound of 2,000 retained inputs.

## Lifecycle and metric correctness

- Codex, Kimi, and Claude roll back listener ownership and retained cache state
  if provider watch registration throws.
- Host reconciliation retries a missing provider subscription without creating
  duplicates once registration succeeds.
- The performance report now names the measured value
  `cachedOutlineReadMs`: it is a cached adapter outline read, not Webview
  rendering time.
- Source and generated Webview viewer scripts are byte-identical.

## TDD evidence

Each binding regression was first observed RED:

- canonical Kimi fixture produced 0 of 3 expected interactions;
- Claude string content normalized to empty;
- an invalid tail counted one malformed line and advanced past it;
- a real Kimi poller timed out after an append;
- a 2,001-input outline reported `partial: false`;
- failed provider watches leaked one callback in all three adapters;
- Host reconciliation attempted provider watch registration once instead of
  retrying;
- three Codex filesystem architecture mutations were accepted;
- canonical-only Kimi parsing reduced the performance fixture to zero
  interactions.

After implementation, the fresh focused run passed 202 unit/contract/integration
tests, the real-browser viewer run passed 9 tests, and the architecture
controlled-mutation run passed 40 tests.

## Capability audit

Before the audit update, `npm run test:behavior-contracts` failed with:

```text
unaudited implementation commit 295f061a7de35b1b98992bb193a3342d5a400b72
```

`MAIN-AI-SESSION-CONVERSATION-OUTLINE` now assigns that commit and advances the
audit head to it. The live catalog and currency checks then passed.

## Verification

Fresh focused verification passed:

- compile;
- 202 unit/contract/integration tests;
- 9 real-browser viewer tests;
- conversation performance gate;
- lint, Dashboard, behavior-contract, architecture, and safety gates;
- source/media viewer parity;
- `git diff --check`.

Full `npm run test:ci:linux`: pending final run.

## Non-blocking ledger

- Blank physical JSONL lines remain intentionally ignored.
- Direct cold-continuation read instrumentation remains a future strengthening;
  checkpoint/continuation behavior is covered and the performance gate
  exercises the production reader.
- A malformed Codex `-32601` object without a string message still maps to
  update-required rather than unsupported protocol.
