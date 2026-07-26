# Task 11 Report: Conversation Release Gates

## Status and commits

Complete on branch `docs/active-session-conversation-outline-design`, from
Task 10 head `3853df927fa9ac083bc458f6f6839652adb4fd10` through:

```text
88e29eb89e8413f69267faa99b3d92775e7139b7 test: gate conversation outline behavior
c9178dec0f4e9d4b922cd85cfd0efcf9449898f9 docs: audit conversation outline coverage
```

Nothing was pushed, merged, installed, or cleaned up.

Task review package:

```text
.superpowers/sdd/review-3853df9..c9178de.diff
```

## Outcome

- Added `ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001` with controlled
  mutations for:
  - Codex filesystem/JSONL-reader imports;
  - extension-host DOMPurify imports;
  - exact source, scan, line, outline, page, viewer, Codex response/timeout,
    auto-scroll, request-ID, and per-provider cache limits;
  - prompt-bearing marker `innerHTML`;
  - raw app-server stderr/response logging;
  - provider watcher release ownership.
- Added Windows portable edge-hash and `noFollowFlag: 0` fallback coverage
  without requiring symlink privileges. The fallback test injects an opened
  handle for a different file and proves realpath/stat/edge comparison rejects
  it.
- Added macOS device/inode/birth-time identity and continuation coverage.
- Added three independent remote cases (`ssh-remote`, `wsl`,
  `dev-container`) with distinct UI and extension-host homes. Every case
  resolves only the Kimi conversation beneath `KIMI_SHARE_DIR`, never the
  UI-side `HOME`.
- Added the scheduled macOS source-identity step at exact index 3 and retained
  stable Extension Host smoke at exact index 4. Release contracts require
  exactly five ordered steps and reject added, removed, or reordered steps.
- Required these exact main VSIX entries:

```text
extension/media/conversationViewer.css
extension/media/conversationViewerScripts.js
extension/media/purify.min.js
```

- Added Linux performance and remote-source scripts to `test:ci:linux`
  immediately after deterministic tests. Added the Windows source test to
  `test:ci:windows`.
- Registered the four planned P0 behavior contracts and made every listed
  owner name the exact behavior ID.
- Removed the five Task 5 semicolon baseline findings. `npm run lint:ci` now
  passes.
- Resolved three naturally related minor-ledger items:
  - Claude UUID inputs are normalized to lowercase before exact filename and
    event matching;
  - Windows fallback tests do not require symlink privilege and the ancestor
    race uses `O_NOFOLLOW || 0`, not a fake read flag;
  - duplicate registrations of the same watch callback now retain distinct
    logical listeners for Codex, Kimi, and Claude.

## TDD evidence

The architecture tests were written before the new guard. The first run
reported six expected failures:

```text
architectureGuards.test.js
  existing checks: 14 passed
  ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001 mutations: 6 failed
  reason: unknown architecture guard
```

After the guard was implemented:

```text
architectureGuards.test.js 20/20
```

The performance command was invoked before its package script existed:

```text
npm run test:conversation-performance
  Missing script: "test:conversation-performance"
```

The Claude platform regression was also observed RED:

```text
uppercase Claude UUID source
  actual: null
  expected: canonical lowercase JSONL source
```

It passed after normalizing the validated UUID.

The duplicate-listener regression was observed RED:

```text
same callback registered twice
  observed notifications: 1
  expected notifications: 2
```

It passed after assigning each logical registration an independent wrapper
listener; disposal of the first registration leaves the second active.

## Performance harness and measurements

The fixture is created beneath `os.tmpdir()`, never in the repository. It
contains exactly 10 MiB and exactly 1,000 Kimi interactions. The interaction
records use real `TurnBegin`, `ContentPart`, and `TurnEnd` events. Remaining
bytes are a small number of syntactically valid records shaped as:

```json
{"type":"Ignored","padding":"..."}
```

Those records are read by `readConversationJsonl` in 256 KiB chunks, split
into physical lines, decoded, and passed through `JSON.parse`. The Kimi
normalizer deliberately ignores their unknown `type`. The fixture is not
sparse, blank-line padded, or skipped with a seek.

An initial exploratory fixture placed almost all 10 MiB in assistant-visible
text. It measured about `1310.790 ms` cold. That passed the `1500 ms` limit,
but mixed repeated grapheme normalization into the intended source
I/O/indexing gate and left poor CI headroom. The final fixture preserves the
same byte and interaction counts while using the parsed `Ignored` records for
bulk bytes.

Representative consecutive final runs:

```text
coldMs    149.233 / 150.124
appendMs   10.506 /  10.220
cachedMs    1.513 /   1.461
```

The fresh full-CI run measured:

```json
{
  "coldMs": 148.207,
  "appendMs": 10.145,
  "cachedMs": 1.519,
  "outlineInteractions": 1001,
  "serializedPageBytes": 69289,
  "retainedInteractions": 86,
  "retainedBytes": 4156986
}
```

The append fixture is exactly 1 MiB and introduces interaction 1,001. The
harness also creates and opens an exact 64 MiB source, then a 64 MiB + 1 byte
source, constructs 2,001 normalized interactions and verifies the 2,000
outline cap, serializes a real adapter page, and invokes the production
Viewer's `evict()`/`snapshotBytes()` paths.

## Packaging evidence

`npm run test:release-packaging` rebuilt both real archives:

```text
artifacts/project-steward-2.1.7.vsix
artifacts/project-steward-attention-ui-bridge-0.1.4.vsix
```

`node scripts/run-release-packaging-checks.js` then exited 0 and reported
`Release packaging checks passed.` The exact-entry comparison includes all
three conversation viewer assets named above, so successful validation proves
they are in the main archive and no unreviewed entries were added.

The webpack deprecation messages about `Compilation.modules` and
`Module.errors` are pre-existing warnings; packaging and archive validation
both exited 0.

## Behavior and capability audit

The gate commit was followed by:

```text
git log --reverse --format='%H %s' origin/main..HEAD
```

`MAIN-AI-SESSION-CONVERSATION-OUTLINE` assigns all 26 non-documentation
implementation commits from Tasks 1–10 plus gate commit `88e29eb`, for 27
real full hashes total. It owns:

```text
SESSION-AI-SESSION-CONVERSATION-ADAPTER-001
WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001
WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001
SECURITY-AI-SESSION-CONVERSATION-SOURCE-001
```

Its PR gate is `test:ci:linux`, its scheduled job is `scheduled-macos`, and
`realEnvironmentRequired` is false. `audit.head` is the full gate hash.
The two design commits and plan commit use their real full hashes as explicit
documentation exemptions. The additional plan-review and task-report commits
are documentation-only and are accepted by the schema without disguising
implementation.

`npm run test:behavior-contracts` passed both the behavior catalog and main
capability currency checks. The audit-only commit follows `audit.head` and
changes only `docs/testing/main-capability-coverage.json`.

## Verification

Focused final gates:

```text
npm run test-compile                                      passed
node --test tests/unit/tooling/architectureGuards.test.js 20/20
Windows conversation source test                          1/1
macOS conversation source tests                           2/2
remote conversation source tests                          3/3
npm run test:conversation-performance                     passed
npm run test:release-packaging                            passed
node scripts/run-release-packaging-checks.js              passed
npm run test:dashboard                                    passed
npm run lint:ci                                           passed
npm run test:behavior-contracts                           passed
git diff --check                                          passed
```

The first full CI invocation ran through the complete process but its
high-volume tool output detached before preserving the final exit status. It
was not used as completion evidence. The exact command was run again with
`bash` pipefail and a bounded output tail:

```text
set -o pipefail; npm run test:ci:linux 2>&1 | tail -n 120
```

Fresh result: exit `0`. The tail ended with `Coverage baseline checks passed.`
This proves the full compile, behavior, lint, deterministic, remote,
performance, browser, safety, Dashboard, architecture, release notes,
release packaging, production build, coverage, and coverage-baseline chain.

The feature worktree is clean. The primary checkout still contains only the
user's pre-existing:

```text
 M .vscode/settings.json
```

## Remaining minor ledger

Intentionally deferred because Task 11 did not change their semantics and its
platform/performance/security gates do not require them:

- Blank physical JSONL lines remain ignored rather than counted malformed.
- The unit suite does not pin a multibyte sequence at the exact 256 KiB split
  or a single physical JSONL line accepted at exactly 1 MiB. Task 11 does
  cover an exact 1 MiB append segment, but that is not the same assertion.
- The cold-start continuation unit test still does not directly instrument
  how much continuation work occurred. Task 11 verifies the 1,000 to 1,001
  append result and append latency, but does not use internal read-byte
  instrumentation.
- A malformed Codex `-32601` error object without a string `message` still
  maps to update-required rather than unsupported protocol.

The previously recorded preview-bound item remains resolved by `a2bc701`.
