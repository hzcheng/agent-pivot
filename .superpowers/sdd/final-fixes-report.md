# Active Session Conversation Outline — Final Fixes Report

## Status

The whole-branch review findings were fixed test-first in:

```text
295f061a7de35b1b98992bb193a3342d5a400b72 fix: align conversation adapters with production formats
41f5a3933ea302b7554847d6c60fc7ee960b07f6 test: align capped outline browser contract
327fddf9b411e76c81f958b4bcfd386e662cfc87 fix: harden conversation provider boundaries
cd6a339314ec75b5da935bd9318ba066ea21988b test: trace codex re-export dependencies
```

Nothing was pushed, merged, installed, or cleaned up.

Review package:

```text
.superpowers/sdd/review-522b128..327fddf.diff
```

## Production-format adapters

- Kimi now reads only the canonical
  `{ timestamp, message: { type, payload } }` envelope. The provider contract,
  composition tests, privacy assertions, live-watch test, and performance
  harness share the checked-in canonical provider fixture. Legacy invented
  top-level records are ignored. Finite numeric epoch seconds normalize to
  milliseconds exactly like lifecycle timestamps; millisecond inputs are
  preserved.
- Claude now accepts canonical string `message.content` as well as visible
  content-block arrays. Sidechain, tool-result, hidden, and non-visible blocks
  remain excluded. Exact string or array-text
  `[Request interrupted by user]` sentinels create no interaction or message;
  they mark only the preceding open interaction interrupted.
- Codex remains app-server-only. Its obsolete filesystem source resolver was
  removed. The architecture guard now recursively resolves the complete local
  relative import/require/dynamic/import-equals graph reachable from
  `codexAdapter`; any reachable `fs`/`node:fs`, `source`, or `jsonlReader`
  reference fails closed, while the structured app-server client remains
  allowed. Star and named TypeScript re-exports also participate in this
  graph. Service and composition filesystem routes are independently rejected.

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
  interactions;
- Claude string/array interrupt sentinels appeared as a marker or left the
  preceding interaction complete;
- Kimi epoch seconds remained unscaled in outline and page timestamps;
- the old Codex import whitelist rejected the legitimate app-server client but
  missed `model -> filesystem helper -> node:fs/promises`;
- star and named re-exports from a reachable model both hid the same filesystem
  helper from the dependency graph.

After implementation, the fresh focused run passed 202 unit/contract/integration
tests, the real-browser viewer run passed 9 tests, and the architecture
controlled-mutation run passed 40 tests. The final re-review additions passed
20 complete Claude/Kimi adapter tests, 45 architecture tests, and 31
viewer/browser-integration tests.

## Capability audit

Before the audit update, `npm run test:behavior-contracts` failed with:

```text
unaudited implementation commit 295f061a7de35b1b98992bb193a3342d5a400b72
```

`MAIN-AI-SESSION-CONVERSATION-OUTLINE` assigned that commit and advanced the
audit head to it. The live catalog and currency checks then passed. Full CI
exposed one remaining browser assertion that still expected a 2,001-input
outline to be complete. Its focused RED was `true !== false`; after
`41f5a39`, the exact focused Chromium test passed. The audit now also assigns
that test commit and advances its head to
`41f5a3933ea302b7554847d6c60fc7ee960b07f6`. After the final re-review,
the same check failed RED on unaudited implementation commit
`327fddf9b411e76c81f958b4bcfd386e662cfc87`; the capability now assigns it and
advances the audit head to that commit. The final re-export guard commit
`cd6a339314ec75b5da935bd9318ba066ea21988b` was likewise observed as unaudited
before assignment; the audit head now advances to that commit.

## Verification

Fresh focused verification passed:

- compile;
- 202 unit/contract/integration tests;
- 9 real-browser viewer tests;
- conversation performance gate;
- lint, Dashboard, behavior-contract, architecture, and safety gates;
- source/media viewer parity;
- `git diff --check`.

Fresh full `npm run test:ci:linux` after the final re-review fixes completed
with exit 0. Its browser gate passed 62/62, including the corrected 2,001-input
capped-outline contract; deterministic, remote-source, performance, safety,
Dashboard, architecture, release packaging, production Webpack/Gulp, full
coverage, and the stored coverage baseline all passed.

## Non-blocking ledger

- Blank physical JSONL lines remain intentionally ignored.
- Direct cold-continuation read instrumentation remains a future strengthening;
  checkpoint/continuation behavior is covered and the performance gate
  exercises the production reader.
- A malformed Codex `-32601` object without a string message still maps to
  update-required rather than unsupported protocol.
