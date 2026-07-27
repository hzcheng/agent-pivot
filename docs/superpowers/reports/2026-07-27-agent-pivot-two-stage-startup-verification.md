# Agent Pivot Two-Stage Startup Verification

Date: 2026-07-27

Status: **PASS**

Branch: `brand/marketplace-identity`

Capability: `MAIN-DASHBOARD-WEBVIEW-RECOVERY`

Behavior: `WEBVIEW-TWO-STAGE-STARTUP-001` (P0, automated)

## Decision

The Agent Pivot sidebar now paints a private boot shell before ordered runtime
bootstrap completes, then replaces that shell in the same Webview with the
authoritative dashboard. Focused owners, mutations, the complete Linux PR gate,
release packaging, and an installed Dev Container trace all passed.

CI proves ordering, ownership, state transitions, recovery, privacy, and the
ready dashboard interaction contract. The installed trace evaluates perceived
timing; it is not used as a wall-clock CI threshold.

## Before-change timing

The approved design records this pre-fix Dev Container evidence:

- VS Code began activating `hzcheng.agent-pivot` at `09:04:12.783`;
- the Open Workspaces client was constructed at `09:04:13.854`;
- the first cold workspace/session card build took 124 ms;
- a later `dashboard-visible` incremental message build took 7 ms.

The design therefore identified the activation boundary, rather than the later
incremental render, as the dominant delay and set the real-environment target
to paint the shell substantially before the former approximately three-second
first-content point.

## CI ownership and reachability

The required workflow reaches every new owner as follows:

```text
.github/workflows/verify.yml
  quality-linux
    -> npm run test:ci:linux
       -> npm run test:deterministic:run
          -> tests/contract/aiSessions/runtimeComposition.test.js
          -> tests/integration/dashboard/twoStageStartup.test.js
       -> npm run test:browser:run
          -> tests/browser/dashboardBootShell.test.js
```

`tests/integration/dashboard/bootContent.test.js` is also reached by the
deterministic integration glob. The capability manifest records both
`test:deterministic:run` and `test:browser:run`, so all three catalog owners are
reachable from declared PR gates.

The Linux gate's architecture baseline also reported
`providerRegistryCalls: 1`, which guards the single Agent Pivot view-provider
registration.

## Capability audit

`docs/testing/main-capability-coverage.json` now:

- adds `WEBVIEW-TWO-STAGE-STARTUP-001` to
  `MAIN-DASHBOARD-WEBVIEW-RECOVERY`;
- assigns the Task 1–6 implementation and test commits through
  `2f76bf86b88cda8d37f96fa77d9fdb17cb57a63f`;
- advances `audit.head` to that full hash;
- accounts for design commit
  `42dadfde510145f80423bf8e6bd318a4a7cfb63b` and plan commit
  `994c0b5e608d015fa5fd566e475bfbc8b6857d73` through the repository's
  documentation-only exemption convention.

The new verification-time compatibility commits are:

- `5e6009097e935928188c100968c42dea6a13b4b1` — recognize
  bootstrap-owned runtime monitor construction in the architecture guard;
- `5eb992f8a150e1a40fdf485ceb0cb64363da7dbe` — make affected integration
  harnesses wait for authoritative two-stage readiness with bounded,
  observable deadlines;
- `2f76bf86b88cda8d37f96fa77d9fdb17cb57a63f` — migrate safety harnesses
  from legacy provider/timer/context ownership assumptions to the new
  lifecycle and bootstrap-resource contract.

These were test-harness compatibility regressions exposed by broader gates;
they did not change production startup behavior.

## Verification commands

| Command | Exit | Evidence |
| --- | ---: | --- |
| Initial `npm run test:behavior-contracts` | 1 (expected before reconciliation) | All 40 tooling tests passed; the repository checker identified the unaudited Task 1–5 commits |
| `npm run test-compile` | 0 | Main and attention-bridge TypeScript compiled |
| Focused bootstrap unit command | 0 | 23/23 passed |
| Focused contract/integration command | 0 | 72/72 passed |
| Focused browser owner command | 0 | 4/4 passed |
| `npm run test:deterministic` | 0 | Unit, contract, and integration layers passed; integration reported 255/255 |
| `npm run test:browser` | 0 | 84/84 passed, 0 skipped |
| `npm run test:safety:run` after harness reconciliation | 0 | Workspace parity, tmux, AI-session safety, and open-workspace safety passed |
| Reconciled `npm run test:behavior-contracts` | 0 | 40/40 tooling tests and both repository checks passed |
| Final `npm run test:ci:linux` | 0 | Exact Linux PR chain passed through build, audit, deterministic, remote-source, performance, browser, safety, dashboard, architecture, release, production build, and coverage |
| Coverage inside the final Linux gate | 0 | 1063/1063 passed; coverage baseline passed |

The final browser run reported 84/84 with no skips. The production builds emit
the repository's existing Webpack deprecation warnings for
`Compilation.modules` and `Module.errors`; Webpack and every enclosing gate
exited successfully.

## Mutation evidence

Each mutation was applied alone, compiled when required, rejected by its named
owner, and restored immediately. No mutation was committed.

| Invariant removed | Named owner | RED evidence | Restored evidence |
| --- | --- | --- | --- |
| Public activation awaited the bootstrap flight | `runtimeComposition.test.js` | 0/1; activation timed out while the injected Direct restoration remained pending | 1/1 |
| Stale generation was allowed to complete | `twoStageStartup.test.js` | 0/1; stale completion returned `true` instead of `false` | 2/2 combined stale/Retry owners |
| Retry was accepted while already booting | `twoStageStartup.test.js` | 0/1; a second retry event escaped the single-flight boundary | 2/2 combined stale/Retry owners |
| Reduced-motion shimmer suppression was removed | `dashboardBootShell.test.js` | 0/1; computed animation was `agent-pivot-boot-shimmer` instead of `none` | 1/1 |
| Raw bootstrap error text was interpolated into failure HTML | `bootContent.test.js` | 0/1; the private-path canary appeared in rendered HTML | 1/1 |

After all restorations, `git diff` was clean for the mutated sources and
`npm run test-compile` passed.

## Release artifacts

The requested direct commands passed:

- `npm run vscode:prepublish`;
- `npx @vscode/vsce package --no-dependencies`.

The direct main package is `agent-pivot-1.0.0.vsix`, contains 51 entries, is
403,471 bytes, and has SHA-256
`9cdd7dc5a20eec66fac3a1f5ea20f3e5a8a3e959148ab8c9ed21e624e46edce1`.

The final Linux gate regenerated the release archives:

| Artifact | Identity | Entries | Bytes | Final SHA-256 |
| --- | --- | ---: | ---: | --- |
| `artifacts/agent-pivot-1.0.0.vsix` | `hzcheng.agent-pivot@1.0.0`, workspace/UI extension kind | 51 | 403,471 | `fa0dd77e33e4f24f17014ebc9b7272c3345b48e0831616b34a577a20fbbd08df` |
| `artifacts/agent-pivot-attention-ui-bridge-1.0.0.vsix` | `hzcheng.agent-pivot-attention-ui-bridge@1.0.0`, UI extension kind | 7 | 21,715 | `b471f2904962ea2e9f69b67d9c44235c48e8698ab9dfddfc7c07343f567d2fe2` |

`unzip -t` passed for all three archives. The version was not changed and
nothing was published.

The UI bridge was packaged and inspected but not installed in the remote
extension host: it is a UI-kind extension owned by the local macOS workbench,
and this Dev Container has no local UI extension-management filesystem or
display boundary. Installing it into the remote Server would not test its
actual host.

## Active Dev Container installation

Read-only process discovery identified the active workspace server as VS Code
Server `1.127.0`, commit
`4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, `x64`, with
`REMOTE_CONTAINERS=true`.

The inherited `VSCODE_IPC_HOOK_CLI` path was a stale socket:
the filesystem entry existed, but no listener accepted a connection and a
direct probe returned `ECONNREFUSED`. It was not used for installation.

The main VSIX was force-installed through the socket-independent executable
owned by the exact active Server commit:

```text
<server-data-dir>/bin/4fe60c8b1cdac1c4c174f2fb180d0d758272d713/bin/code-server
  --server-data-dir <server-data-dir>
  --extensions-dir <extensions-dir>
  --install-extension <worktree>/artifacts/agent-pivot-1.0.0.vsix
  --force
```

The command exited 0 and reported a successful install. The same executable
and directories then listed `hzcheng.agent-pivot@1.0.0`, with exactly one
installed extension directory. A current, separately validated workbench IPC
channel also reported a successful UI-aware reinstall on
`Dev Container: DevBox @ reddev`.

The archive installed before the final gate regeneration had SHA-256
`d34786626a0ae997dcce4f07e5ed8fc8de483b5f1161ad944ec61e2365c91d9b`.
The final gate changed ZIP metadata, not the production payload. The final
packaged and installed payload hashes are identical:

| Payload | Packaged and installed SHA-256 |
| --- | --- |
| `dist/dashboard.js` | `78b409cb184fb079b9cdd97e916e21a82bd9b2bffcb1cebe4da0c478221f0560` |
| `media/webviewDashboardScripts.js` | `2391637d25fae237ea42abd9593206ee9b61f89b57b33f364a4a38c936c8f4f1` |
| `media/styles.css` | `b806681a86aba776ff95f5514e7891c694d4a6ce2cce10a5d22b1387e0964efb` |

VS Code injects an installation-only `__metadata` object into the installed
`package.json`, so raw manifest hashes differ. Removing only that object and
canonicalizing JSON produces the same SHA-256 on both sides:
`874949326e8ad3bc135af0388c52e67f14020294c0717d4d02631de204008c9b`.

## Installed timing trace

The UI command channel was first used to focus the exact dashboard workspace.
Because a same-version reinstall does not replace an already activated module,
the dashboard extension host was mapped by exact workspace-path evidence and
gracefully terminated. VS Code restarted that one host; the unrelated live
Dev Container extension host remained unchanged. The restored Agent Pivot view
then loaded the installed bytes and emitted exactly four startup diagnostics:

```text
[Dashboard] {"loggedAt":"2026-07-27T05:43:51.709Z","event":"agent-pivot-activation-entered"}
[Dashboard] {"loggedAt":"2026-07-27T05:43:52.407Z","event":"agent-pivot-boot-shell-assigned","generation":1}
[Dashboard] {"loggedAt":"2026-07-27T05:43:52.752Z","event":"agent-pivot-browser-first-paint","generation":1,"durationMs":1042.9859240000005}
[Dashboard] {"loggedAt":"2026-07-27T05:43:54.536Z","event":"agent-pivot-bootstrap-ready","generation":1,"durationMs":2826.7115679999997}
```

Observed installed timing:

- shell assignment occurred 698 ms after the activation diagnostic;
- browser first paint occurred 1042.986 ms after activation;
- authoritative bootstrap became ready at 2826.712 ms;
- visible first paint therefore preceded full readiness by approximately
  1783.726 ms.

The first-paint event is substantially before the design's former
approximately three-second first-content point. The trace contains generation,
duration, and stable event names only—no paths, session identities, or raw
errors.

The installed trace directly proves activation, shell delivery, browser paint,
and authoritative readiness timing. Automated owners prove the remaining
acceptance details: same-document replacement, single view-provider
registration, post-ready dashboard actions, single-flight Retry under a
controlled failure, reduced-motion behavior, stale-generation rejection, and
privacy-safe boot/failure HTML. No unsupported claim of manual interaction was
substituted for those tests.

## Residual observations

- The package retains the pre-existing `*` activation event; packaging reports
  it as a warning but succeeds.
- Webpack emits the two existing deprecation warnings noted above.
- The local UI bridge was deliberately not installed into the remote host.
- No version bump, publish, push, merge, or PR action was performed.
