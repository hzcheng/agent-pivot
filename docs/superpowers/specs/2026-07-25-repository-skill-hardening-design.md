# Repository Skill Hardening Design

## Goal

Capture the reusable engineering lessons from the multi-provider AI session
work as repository-local skills without turning one feature's history into
project folklore.

The change adds one reusable Webview mutation skill and strengthens three
existing workflow skills. It does not change extension runtime code, package
versions, release notes, tags, artifacts, or marketplace state.

## Skill portfolio

Use one new technique skill rather than separate skills for request
correlation, DOM replacement, mirrored persistence, and composite batch
operations. Those concerns fail together at the same Host/Webview mutation
boundary and should be reviewed as one lifecycle.

Create:

- `.codex/skills/resilient-webview-mutation-protocols/`

Strengthen:

- `.codex/skills/fixing-regressions-with-ci/`
- `.codex/skills/installing-vscode-extensions-locally/`
- `.codex/skills/review-fix-commit-loop/`

Keep multi-provider list ordering and Sharingan rendering out of the new skill.
They are feature decisions, not generally reusable protocol rules.

Own the repository guidance with one CI-reachable behavior:

- `ARCH-REPOSITORY-SKILL-GUIDANCE-001`
- owner: `tests/unit/tooling/repositorySkills.test.js`

The owner verifies the stable guidance contract for all four skills. External
skill validation remains useful, but an absolute path under a developer's
Codex installation is not a portable PR gate.

## Baseline evaluation

Read-only evaluations were run before editing the skills.

The Webview protocol evaluation produced a strong design but still:

- made persistent Webview state optimistic instead of Host-authoritative;
- required selected providers to be available, which would reject a valid
  selected-but-unavailable provider;
- allowed an acknowledgement to clear pending before authoritative replacement
  HTML was applied; and
- sent transient popup state through the Host protocol instead of keeping it
  local to DOM replacement.

The regression workflow evaluation correctly classified implementation and
audit commits only after reading repository testing documentation. The current
skill itself does not explain audit-head currency, path-based documentation
exemptions, or why a late owner marker cannot prove RED-before-fix.

The local-install evaluation found the stale IPC and matching VS Code Server
CLI fallback, but did not verify that installed bytes match the just-built
VSIX. The current skill also does not make stale socket handling or the CLI
selection procedure explicit.

The review-loop evaluation required a final whole-branch integration review,
but identified that the current skill does not require one and does not
explicitly block on unexplained CI or harness failures.

These observed gaps define the minimum additions. Do not add hypothetical
rules that were not exercised by the feature or evaluations.

## Resilient Webview mutation protocol

The new skill applies when a VS Code Webview submits a Host-owned mutation,
especially when the Host persists state, replaces authoritative HTML, or
performs cross-scope batch work.

### Protocol envelope

Every request and settlement carries:

- a schema `version`;
- a fresh `requestId`;
- the authoritative target identity such as `projectId`; and
- one operation-specific payload.

The Host validates the complete shape, rejects unknown fields when practical,
resolves the target authoritatively, and never trusts DOM state or display
labels as identity. Success and failure settlements use the same correlation
fields. Stale, duplicate, malformed, or wrong-target settlements fail closed.

### Host authority and pending lifecycle

The Webview submits intent. It may disable controls and show pending feedback,
but it does not commit persistent state optimistically.

Every recognized request reaches exactly one settlement path, including
validation failures, guard failures, thrown errors, persistence failures, and
refresh failures. A success becomes visible only when the correlated
authoritative replacement has been applied. A generic correlated failure
clears only the matching pending operation and leaves or restores the
authoritative UI.

Fast repeated input must either be locked while pending or represented as
explicitly correlated later intent. It must never overwrite the identity of an
in-flight operation.

### Authoritative replacement and focus

Before replacing a card, capture only local transient state: popup openness,
focused semantic item, and relevant scroll position. Apply the authoritative
replacement first. Restore transient state only when the matching control
still exists and no pending lifecycle forbids reopening it. Use semantic keys,
not detached nodes or row indexes, for focus restoration.

### Mirrored persistence

When compatibility requires two state records:

1. snapshot both authoritative records;
2. validate the complete intended state;
3. write the canonical record;
4. write the compatibility mirror;
5. if either write fails, restore or repair from the snapshot when possible;
6. report the mutation as failed; and
7. refresh from the actual authoritative store state.

A partial write is not success. In-memory assumptions must not hide the state
that will be observed after reload.

### Composite batch operations

Cross-provider or cross-scope identities use a composite key such as
`{ provider, sessionId }`. The Host bounds and deduplicates items, resolves
them against authoritative state, groups execution by provider, and refreshes
once after all groups settle.

Partial results remain explicit. UI announcements and logs report bounded
counts and provider-safe summaries without exposing full session identifiers.
Pending state settles once for the aggregate request.

### Verification

The skill requires mutation-sensitive coverage for:

- malformed and wrong-target input;
- stale, duplicate, and out-of-order settlements;
- every early return and thrown error settling pending exactly once;
- success waiting for correlated authoritative replacement;
- replacement-time popup and focus restoration;
- first-write and second-write persistence failures plus repair failure;
- composite identity collisions, grouping, and partial results; and
- keyboard, focus-visible, and polite live-region behavior.

## Existing skill changes

### Regression CI

Add an audit-currency phase after behavior ownership:

- classify commits by changed paths and behavior, never by subject prefix;
- require automated owner files to literally reference their behavior IDs;
- treat tests and owner-marker commits as implementation evidence, not
  documentation exemptions;
- run `npm run test:behavior-contracts` after every implementation or owner
  change;
- advance the main-capability audit head only after every implementation commit
  is assigned to a capability with CI-reachable behavior ownership; and
- permit only genuinely documentation-only commits after the audit head.

An audit update cannot retroactively prove a missing RED observation.

### Local VS Code installation

Add a deterministic remote-host fallback:

- treat a missing or unreachable `VSCODE_IPC_HOOK_CLI` socket as stale;
- locate the CLI for the active VS Code Server commit instead of selecting an
  arbitrary `code` from `PATH`;
- install the workspace extension into the active remote Server host;
- report a UI-only bridge as packaged but not installed when the local UI Host
  is unreachable from the container; and
- verify extension ID/version and compare representative packaged and installed
  file hashes.

Packaging success and extension-list output alone do not prove that the current
build was installed.

### Review/fix/commit loop

Require a final review of the complete merge-base-to-HEAD diff after all
task-level reviews. This review targets cross-task protocols, shared state,
failure paths, accessibility announcements, and migration rollback.

Every failing check must be reproduced and classified. A task agent may not
defer a real harness or integration regression by calling it audit currency.
Critical and Important findings remain blocking until fixed, freshly verified,
and re-reviewed.

## Behavior ownership and audit currency

Add four focused tests to `tests/unit/tooling/repositorySkills.test.js`, one for
each changed skill. Each test references
`ARCH-REPOSITORY-SKILL-GUIDANCE-001` and checks durable semantic anchors rather
than whole paragraphs:

- the Webview skill requires versioned correlation, Host authority,
  authoritative replacement, mirrored-state repair, composite identities, and
  partial-result announcements;
- the regression skill requires path-based classification, literal behavior
  IDs, behavior-contract validation, and audit-head currency;
- the installation skill requires stale IPC diagnosis, active `code-server`
  selection, host-specific installation, and hash comparison; and
- the review skill requires a merge-base-to-HEAD integration review and blocks
  unexplained harness or CI failures.

Register the behavior in `docs/testing/behavior-contracts.json` with the four
SKILL.md files as evidence. The ordinary unit-test glob already reaches the
owner through required Linux CI.

Because `.codex/skills/` is not classified as a documentation path by
`scripts/lib/mainCapabilityCoverage.js`, every skill and owner commit is an
implementation commit for audit purposes. After all fixes are complete:

1. assign those commits to `MAIN-REGRESSION-CI-CURRENCY`;
2. add `ARCH-REPOSITORY-SKILL-GUIDANCE-001` to that capability;
3. advance the audit head to the last implementation commit; and
4. leave the manifest-only audit commit after that head.

If review creates another implementation commit, repeat the audit update. Do
not classify `.codex` changes by their `docs:` commit subjects.

## Skill metadata

The new skill includes `agents/openai.yaml` with only:

- `interface.display_name`;
- `interface.short_description`; and
- `interface.default_prompt`, explicitly naming the skill.

Existing metadata is regenerated only if its trigger or UI description becomes
stale. SKILL.md files remain concise and keep detailed repository-specific
commands in the workflow where they are needed.

## Validation

Before publication:

1. observe each repository skill owner test fail before its corresponding
   skill change;
2. run the skill validator for every repository-local skill;
3. rerun the baseline scenarios with the relevant updated skill loaded;
4. inspect every evaluation for the observed omissions;
5. run the focused owner, `npm run test:behavior-contracts`, and the affected
   unit suite;
6. update and revalidate main-capability audit currency;
7. run `git diff --check`;
8. perform a read-only whole-branch review; and
9. confirm the diff contains no runtime, version, release, or publication
   changes.
