# Repository Skill Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one repository-local skill for reliable Host/Webview mutations and strengthen the regression, local-install, and review workflows with lessons proven by the multi-provider session work.

**Architecture:** Keep protocol, pending lifecycle, authoritative DOM replacement, mirrored persistence, and composite batch rules together in one technique skill. Add only repository-specific audit, installation, and final-review rules to the existing skills that already own those workflows.

**Tech Stack:** Markdown Agent Skills, YAML `agents/openai.yaml`, the skill-creator validation scripts, git worktrees, Node.js behavior-contract checks.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktree/skills-hardening` on `docs/skills-hardening`.
- The approved design is `docs/superpowers/specs/2026-07-25-repository-skill-hardening-design.md`.
- Add exactly one new skill: `resilient-webview-mutation-protocols`.
- Strengthen exactly three existing skills: `fixing-regressions-with-ci`, `installing-vscode-extensions-locally`, and `review-fix-commit-loop`.
- Use observed baseline omissions as the source of new guidance.
- Complete RED, GREEN, validation, and review for one skill before editing the next skill.
- Keep SKILL.md concise, imperative, and below 500 lines.
- Add no runtime dependency and change no extension runtime source.
- Do not change package versions, release notes, tags, artifacts, marketplace state, or publication scripts.
- Own the guidance with `ARCH-REPOSITORY-SKILL-GUIDANCE-001` in a required-CI-reachable unit test.
- Treat `.codex/skills/` and skill-owner tests as implementation paths for main-capability audit currency.
- Stage explicit paths and keep each skill change in an intentional commit.

---

### Task 1: Register failing repository-skill guidance contracts

**Files:**
- Create: `tests/unit/tooling/repositorySkills.test.js`
- Modify: `docs/testing/behavior-contracts.json`

**Interfaces:**
- Produces four focused tests sharing behavior ID
  `ARCH-REPOSITORY-SKILL-GUIDANCE-001`.
- Makes the guidance contract reachable through the existing
  `tests/unit/**/*.test.js` Linux CI path.

- [ ] **Step 1: Write four focused owner tests**

Read each SKILL.md as UTF-8. Use separate tests for:

1. versioned/correlated Host-authoritative Webview mutation and replacement,
   mirrored persistence repair, composite identity, and partial result rules;
2. path-based audit classification, literal behavior IDs, behavior-contract
   validation, and audit-head currency;
3. stale `VSCODE_IPC_HOOK_CLI`, active `code-server`, host-specific
   installation, and representative hash comparison; and
4. merge-base-to-HEAD integration review plus blocking classification of
   unexplained CI or harness failures.

Every test title must contain
`ARCH-REPOSITORY-SKILL-GUIDANCE-001`. Assert stable keywords or short semantic
fragments, not complete paragraphs.

- [ ] **Step 2: Register behavior ownership**

Append one automated P0 architecture entry to
`docs/testing/behavior-contracts.json`:

```json
{
  "id": "ARCH-REPOSITORY-SKILL-GUIDANCE-001",
  "domain": "architecture",
  "title": "Repository skills retain validated engineering workflows",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/unit/tooling/repositorySkills.test.js"
  ],
  "evidence": [
    ".codex/skills/resilient-webview-mutation-protocols/SKILL.md",
    ".codex/skills/fixing-regressions-with-ci/SKILL.md",
    ".codex/skills/installing-vscode-extensions-locally/SKILL.md",
    ".codex/skills/review-fix-commit-loop/SKILL.md"
  ]
}
```

- [ ] **Step 3: Observe RED**

Run:

```bash
node --test tests/unit/tooling/repositorySkills.test.js
```

Expected: all four focused tests fail because the new skill is missing and the
three existing skills lack their required semantic anchors.

`npm run test:behavior-contracts` is also expected to fail until the new
evidence file exists. Do not weaken the catalog entry to make this temporary
state green.

- [ ] **Step 4: Commit the owner**

```bash
git add \
  tests/unit/tooling/repositorySkills.test.js \
  docs/testing/behavior-contracts.json
git commit -m "test: register repository skill guidance"
```

---

### Task 2: Add the resilient Webview mutation skill

**Files:**
- Create: `.codex/skills/resilient-webview-mutation-protocols/SKILL.md`
- Create: `.codex/skills/resilient-webview-mutation-protocols/agents/openai.yaml`

**Interfaces:**
- Triggers when a VS Code Webview sends a Host-owned mutation, authoritative
  HTML is replaced, state is mirrored for compatibility, or composite batch
  work can partially fail.
- Produces one checklist covering protocol correlation, exact pending
  settlement, Host authority, DOM/focus restoration, persistence repair,
  composite identities, partial results, and tests.

- [ ] **Step 1: Preserve the RED evidence**

Use the baseline Webview evaluation recorded in the design. Confirm its
specific misses are: optimistic persistent UI, selected-provider availability
as a false invariant, acknowledgement clearing before authoritative
replacement, and transient popup state crossing the Host boundary.

- [ ] **Step 2: Initialize the skill**

Run the skill creator's `init_skill.py` with:

```bash
python /home/hzcheng/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  resilient-webview-mutation-protocols \
  --path .codex/skills \
  --interface 'display_name=Resilient Webview Mutation Protocols' \
  --interface 'short_description=Keep Host-owned Webview mutations consistent' \
  --interface 'default_prompt=Use $resilient-webview-mutation-protocols to design and verify this Host-owned Webview mutation.'
```

Do not create scripts, references, assets, examples, or placeholder files.

- [ ] **Step 3: Write the minimal skill**

Use this section order:

1. `Overview`
2. `Core Invariants`
3. `Workflow`
4. `Protocol Contract`
5. `Pending And Replacement Lifecycle`
6. `Mirrored Persistence`
7. `Composite Batch Operations`
8. `Verification Matrix`
9. `Common Mistakes`

The frontmatter description must start with `Use when` and mention VS Code
Webviews, Host-owned mutations, authoritative HTML replacement, mirrored
persistence, stale acknowledgements, stuck pending UI, focus loss, and partial
batch failures without summarizing the workflow.

- [ ] **Step 4: Validate GREEN**

Run:

```bash
python /home/hzcheng/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .codex/skills/resilient-webview-mutation-protocols
wc -l -w .codex/skills/resilient-webview-mutation-protocols/SKILL.md
```

Rerun the Webview scenario with only the new skill and verify it keeps the Host
authoritative, settles pending only through correlated failure or applied
authoritative replacement, keeps popup state local, permits unavailable
selected providers when the domain permits it, and repairs partial persistence.

Run only the Webview-focused owner test and verify it is now green while the
three not-yet-edited skill tests remain red.

- [ ] **Step 5: Commit**

```bash
git add \
  .codex/skills/resilient-webview-mutation-protocols/SKILL.md \
  .codex/skills/resilient-webview-mutation-protocols/agents/openai.yaml
git commit -m "docs: add resilient webview mutation skill"
```

---

### Task 3: Make behavior-audit currency explicit

**Files:**
- Modify: `.codex/skills/fixing-regressions-with-ci/SKILL.md`
- Modify only if stale: `.codex/skills/fixing-regressions-with-ci/agents/openai.yaml`

**Interfaces:**
- Extends the existing behavior ownership and CI reachability workflow with
  commit classification and main-capability audit currency.

- [ ] **Step 1: Preserve the RED evidence**

Use the baseline audit evaluation recorded in the design. The current skill
does not itself say that changed paths override a `docs:` subject, owner-marker
tests are implementation evidence, or the audit head advances only after all
implementation commits have CI-reachable ownership.

- [ ] **Step 2: Add an audit-currency workflow phase**

Add concise rules requiring:

- literal behavior IDs in automated owner files;
- `npm run test:behavior-contracts` after implementation, owner, catalog, or
  audit changes;
- path-and-behavior commit classification instead of subject-prefix
  classification;
- tests and owner markers to remain implementation commits;
- audit-head advancement only after complete capability assignment and
  CI-reachable ownership; and
- only genuine documentation commits after the audit head.

State that a later audit commit cannot create missing RED evidence.

- [ ] **Step 3: Validate GREEN**

Run the skill validator and rerun the audit scenario with the updated skill.
Verify that the agent treats audit-currency failures as immediate failures and
does not accept the disguised `docs:` implementation commit.

Run the audit-focused owner test and verify it is green before proceeding.

- [ ] **Step 4: Commit**

```bash
git add .codex/skills/fixing-regressions-with-ci/SKILL.md
git commit -m "docs: harden regression audit currency workflow"
```

---

### Task 4: Harden remote VS Code installation verification

**Files:**
- Modify: `.codex/skills/installing-vscode-extensions-locally/SKILL.md`
- Modify only if stale: `.codex/skills/installing-vscode-extensions-locally/agents/openai.yaml`

**Interfaces:**
- Extends local installation with stale IPC diagnosis, active Server CLI
  selection, host-specific VSIX routing, and installed-byte verification.

- [ ] **Step 1: Preserve the RED evidence**

Use the baseline installation evaluation recorded in the design. It did not
compare the packaged build with installed files, and the current skill does not
specify stale IPC or active Server CLI selection.

- [ ] **Step 2: Add the deterministic fallback**

Require:

- validation of `VSCODE_IPC_HOOK_CLI` before trusting it;
- selection of the CLI belonging to the active VS Code Server commit;
- installation of the workspace extension into that Server host;
- explicit reporting when the UI-only bridge cannot be installed from the
  remote host; and
- verification by extension ID/version plus representative file hashes from
  the VSIX and installed extension directory.

Keep environment-specific paths discoverable rather than hard-coded.

- [ ] **Step 3: Validate GREEN**

Run the skill validator and rerun the stale-IPC Dev Container scenario. Verify
that the result separates packaging from both host installations and requires
hash evidence for the main extension.

Run the installation-focused owner test and verify it is green before
proceeding.

- [ ] **Step 4: Commit**

```bash
git add .codex/skills/installing-vscode-extensions-locally/SKILL.md
git commit -m "docs: verify remote VS Code extension installs"
```

---

### Task 5: Require whole-branch integration review

**Files:**
- Modify: `.codex/skills/review-fix-commit-loop/SKILL.md`
- Modify only if stale: `.codex/skills/review-fix-commit-loop/agents/openai.yaml`

**Interfaces:**
- Extends task-level review with one merge-base-to-HEAD integration review and
  explicit classification of every failing check.

- [ ] **Step 1: Preserve the RED evidence**

Use the baseline review evaluation recorded in the design. The current skill
does not explicitly make whole-branch integration review mandatory or forbid
deferring a real harness regression as audit currency.

- [ ] **Step 2: Add final integration and failure-classification gates**

Require:

- one final read-only review of the entire merge-base-to-HEAD diff;
- explicit attention to cross-task protocols, shared state, partial failure,
  rollback, accessibility announcements, and replacement lifecycles;
- reproduction and classification of every failing check;
- no audit-currency label without matching audit-currency evidence; and
- fresh focused plus branch-level verification after the final fix.

- [ ] **Step 3: Validate GREEN**

Run the skill validator and rerun the nine-task integration scenario. Verify
that the agent blocks PR creation on unexplained CI failures and requires the
whole-branch review after task-level reviews.

Run the review-focused owner test and then the complete owner file. All four
tests must be green.

- [ ] **Step 4: Commit**

```bash
git add .codex/skills/review-fix-commit-loop/SKILL.md
git commit -m "docs: require final integration review"
```

---

### Task 6: Audit, validate, and review the complete skill set

**Files:**
- Verify: `.codex/skills/*/SKILL.md`
- Verify: `.codex/skills/*/agents/openai.yaml`
- Modify: `docs/testing/main-capability-coverage.json`
- Verify: `docs/superpowers/specs/2026-07-25-repository-skill-hardening-design.md`
- Verify: `docs/superpowers/plans/2026-07-25-repository-skill-hardening.md`

- [ ] **Step 1: Update main-capability audit currency**

Collect every commit after the current audit head. For each commit that changes
`.codex/skills/`, `tests/`, or `docs/testing/behavior-contracts.json`:

- assign its full hash to `MAIN-REGRESSION-CI-CURRENCY`;
- add `ARCH-REPOSITORY-SKILL-GUIDANCE-001` to that capability's behaviors; and
- advance `audit.head` to the last implementation commit.

Do not add the design/plan commits to `ignoredDocumentationCommits`; unassigned
`docs/` paths are already treated as documentation. Commit the manifest-only
audit update:

```bash
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit repository skill guidance"
```

- [ ] **Step 2: Run all skill validators**

```bash
validator=/home/hzcheng/.codex/skills/.system/skill-creator/scripts/quick_validate.py
for skill_dir in .codex/skills/*; do
  python "$validator" "$skill_dir"
done
```

- [ ] **Step 3: Run repository checks**

```bash
node --test tests/unit/tooling/repositorySkills.test.js
npm run test:behavior-contracts
git diff --check origin/main...HEAD
```

- [ ] **Step 4: Audit scope**

Confirm:

```bash
git diff --name-only origin/main...HEAD
git status -sb
```

The changed paths must be limited to the four skills, their owner and behavior
catalog, the main-capability audit manifest, and the approved design and plan.
No package version, release, runtime, artifact, or publication path may appear.

- [ ] **Step 5: Request whole-branch review**

Give a read-only reviewer the merge base, branch head, approved design, plan,
and full diff. Fix every Critical or Important finding, rerun covering checks,
and re-review before push.

- [ ] **Step 6: Repair audit currency after review fixes**

If review produces another implementation commit, add its full hash to the
capability, move `audit.head` to it, commit a new manifest-only audit update,
and rerun the complete repository checks.

- [ ] **Step 7: Publish and merge**

Push `docs/skills-hardening`, create a ready PR targeting `main`, wait for all
required checks, merge with the repository's normal merge-commit strategy,
delete the remote branch, and verify `origin/main` contains the merge. Do not
publish a version.
