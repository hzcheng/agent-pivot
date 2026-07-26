# Task 11 Report: Conversation Release Gates

## Status and commits

Complete on branch `docs/active-session-conversation-outline-design`, from
Task 10 head `3853df927fa9ac083bc458f6f6839652adb4fd10` through:

```text
88e29eb89e8413f69267faa99b3d92775e7139b7 test: gate conversation outline behavior
c9178dec0f4e9d4b922cd85cfd0efcf9449898f9 docs: audit conversation outline coverage
ef901b8b3ea926dae228f9904f3d8c56e72332aa docs: report conversation outline release gates
e227fb9d42451b032d4d910f15037b149689b3d5 test: harden conversation release gates
cd1f3892d71f9960aaab506cf2c65b2baab15667 docs: refresh conversation release audit
08a3a8aedeed4e3b5aeaed8c26e8c59f537a3e7a docs: report hardened conversation gates
4c4d42586ea23d8f3e3fecb27a16834500b1cb00 test: enforce canonical watcher release guards
6642367882ebfefe04ff2401084b7b6e45aadae3 docs: advance conversation guard audit
cfd333b86942c39007cd8d3c08697b204593a837 docs: report canonical conversation guards
bdc7f637d4621e96cc956716091d19429d90992e test: guard dynamic conversation imports
4c8f69778f7a40fa84c592aa264f0cf328709662 docs: advance dynamic import audit
```

Nothing was pushed, merged, installed, or cleaned up.

Task review package:

```text
.superpowers/sdd/review-3853df9..4c8f697.diff
```

## Outcome

- Added `ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001` with controlled
  mutations for:
  - filesystem/JSONL-reader imports anywhere in the transitive local
    relative-import graph reachable from the Codex adapter, including
    `node:fs/promises`, CommonJS `require`, TypeScript import-equals, and
    dynamic `import()` declarations, plus star and named re-exports; the
    structured app-server client path remains allowed;
  - extension-host DOMPurify static, deep, CommonJS, and TypeScript
    import-equals imports, plus dynamic `import()`;
  - exact source, scan, line, outline, page, viewer, Codex response/timeout,
    auto-scroll, request-ID, per-provider cache count, and cache TTL limits;
  - any conversation-marker `innerHTML`/`insertAdjacentHTML` write;
  - console, `process.stdout.write`, or `process.stderr.write` app-server
    logging and a structurally no-op stderr callback; both `=> undefined` and
    an empty `=> {}` block are accepted safe sinks;
  - exactly one provider watcher acquisition, assignment ownership, guarded
    release control flow, disposal, and clearing for all three providers.
    Release methods require the executable top-level sequence
    `subscriptions.size` guard, direct optional dispose, then direct clearing;
    negated/always-true guards and conditionally unreachable disposal fail.
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

The follow-up review added eight controlled mutations before changing the
guard. The RED run was exact:

```text
architectureGuards.test.js
  20 passed
  8 failed with "Missing expected exception"
```

The failures covered `node:fs/promises`, a DOMPurify deep import, CommonJS
Purify require, cache TTL drift, wrapped `innerHTML`, raw
`process.stderr.write`, unconditional watcher-release return, and a second
provider-watch acquisition. After the AST/structural guard was hardened:

```text
architectureGuards.test.js 28/28
```

The second follow-up review added six controlled mutations plus one safe
fixture before implementation. The RED run was again exact:

```text
architectureGuards.test.js
  28 passed
  7 failed
```

The six rejected variants cover TypeScript import-equals for
`node:fs/promises` and DOMPurify, `process.stdout.write`, a negated
subscription-size condition, `subscriptions.size || true`, and a dispose call
hidden beneath `if (false)`. The seventh failure was the safe empty-block
stderr sink, proving the old guard had a false positive. After switching to
canonical executable AST statements and accepting both safe no-op spellings:

```text
architectureGuards.test.js 35/35
```

The final review added two dynamic-import mutations before the AST walker
changed:

```text
architectureGuards.test.js
  35 passed
  2 failed with "Missing expected exception"
```

They use `void import('node:fs/promises')` in the Codex adapter and
`void import('dompurify')` in the extension-host viewer. After
`moduleReferences` learned the TypeScript `ImportKeyword` call shape with one
string argument:

```text
architectureGuards.test.js 37/37
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

The duplicate-listener regression was observed RED originally and was
re-verified during review with controlled production regressions in both
Codex and Claude:

```text
same callback registered twice
  observed notifications: 1
  expected notifications: 2
```

The existing production wrapper listeners were restored unchanged. New
Codex and Claude contract tests now prove that disposal of the first
registration leaves the second active; Kimi already owned the same case.
The three-provider focused adapter run passed 30/30.

## Performance harness and measurements

The fixture is created beneath `os.tmpdir()`, never in the repository. It
contains exactly 10 MiB and exactly 1,000 Kimi interactions. The interaction
records use canonical `{ timestamp, message: { type, payload } }` envelopes
for real `TurnBegin`, `ContentPart`, and `TurnEnd` messages. Remaining
bytes are a small number of syntactically valid JSON string records shaped
as:

```json
"pppppppppppppppp"
```

Those records are read by `readConversationJsonl` in 256 KiB chunks, split
into physical lines, decoded, and passed through `JSON.parse`. The Kimi
normalizer deliberately ignores their non-object values. The fixture is not
sparse, NUL/blank padded, or skipped with a seek.

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
cachedAdapterOutlineReadMs    1.513 /   1.461
```

The final focused performance run measured:

```json
{
  "coldMs": 132.747,
  "appendMs": 10.209,
  "cachedAdapterOutlineReadMs": 2.257,
  "outlineInteractions": 1001,
  "serializedPageBytes": 69289,
  "boundaryBytes": 67108864,
  "boundaryRecords": 6076,
  "boundaryReaderMs": 149.498,
  "boundaryAdapterMs": 417.136,
  "oversizedAdapterMs": 391.682,
  "boundaryOutlineInteractions": 2001,
  "oversizedOutlineInteractions": 2000,
  "retainedInteractions": 86,
  "retainedBytes": 4156986
}
```

The cached measurement is an adapter outline-read budget. It is not evidence
of Webview render latency.

The append fixture is exactly 1 MiB and introduces interaction 1,001. The
harness also creates a dense, fully valid JSONL source of exactly 64 MiB with
2,001 real Kimi interactions. The exact-boundary source passes
`openValidatedConversationSource`, `readConversationJsonl` (6,076 decoded
records, zero malformed or oversized lines), Kimi normalization, and the
production 2,000-entry outline cap. After one byte is appended, the validated
source reports a read start of byte 1; a fresh Kimi adapter follows that real
oversized-prefix rejection path, returns `partial: true`, and normalizes the
remaining 2,000 interactions. No boundary assertion constructs normalized
interaction objects directly. The harness also serializes a real adapter
page and invokes the production Viewer's `evict()`/`snapshotBytes()` paths.

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
implementation commits from Tasks 1–10 plus gate commits `88e29eb`,
`e227fb9`, `4c4d425`, and `bdc7f63`, for 30 real full hashes total. It owns:

```text
SESSION-AI-SESSION-CONVERSATION-ADAPTER-001
WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001
WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001
SECURITY-AI-SESSION-CONVERSATION-SOURCE-001
```

Its PR gate is `test:ci:linux`, its scheduled job is `scheduled-macos`, and
`realEnvironmentRequired` is false. `audit.head` is the full dynamic-import
gate hash `bdc7f637d4621e96cc956716091d19429d90992e`.
The two design commits and plan commit use their real full hashes as explicit
documentation exemptions. The additional plan-review and task-report commits
are documentation-only and are accepted by the schema without disguising
implementation.

`npm run test:behavior-contracts` passed both the behavior catalog and main
capability currency checks. The fresh audit-only commit follows `audit.head`
and changes only `docs/testing/main-capability-coverage.json`.

## Verification

Focused final gates:

```text
npm run test-compile                                      passed
three-provider conversation adapter contracts             30/30
JSONL TTL plus coordinator timer/watch contracts           47/47
node --test tests/unit/tooling/architectureGuards.test.js 37/37
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

The same exact command was run again after every review round. The final
dynamic-import review result was exit `0`; its tail ended with
`Coverage baseline checks passed.`
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
