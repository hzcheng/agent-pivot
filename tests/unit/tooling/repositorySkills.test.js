'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '../../..');

function readSkill(relativePath) {
    return fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');
}

function assertSkillMentions(source, requirements) {
    const missing = requirements
        .filter(([, expression]) => !expression.test(source))
        .map(([description]) => description);
    assert.deepEqual(missing, []);
}

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 keeps Host-owned Webview mutations correlated and recoverable', () => {
    const skill = readSkill('.skills/resilient-webview-mutation-protocols/SKILL.md');

    assertSkillMentions(skill, [
        ['schema version', /schema version/i],
        ['request correlation', /requestId/],
        ['Host authority', /Host.*authoritative/i],
        ['authoritative replacement', /authoritative replacement/i],
        ['mirrored persistence repair', /mirrored persistence[\s\S]*repair/i],
        ['composite identity', /composite (?:identity|key)/i],
        ['partial results', /partial results?/i],
        ['VM sandbox global guards', /vm\.runInNewContext[\s\S]*typeof/i],
        ['oldest supported Webview Chromium', /engines\.vscode[\s\S]*Chrome \d+/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 keeps regression audits path-based and current', () => {
    const skill = readSkill('.skills/fixing-regressions-with-ci/SKILL.md');

    assertSkillMentions(skill, [
        ['path-based classification', /changed paths/i],
        ['literal behavior IDs', /literal behavior IDs/i],
        ['behavior-contract validation', /npm run test:behavior-contracts/i],
        ['audit-head currency', /audit.head/i],
        ['skill and owner-test implementation paths', /\.skills\/[\s\S]*skill-owner tests[\s\S]*implementation paths/i],
        ['post-commit SHA audit sequence', /final implementation commit[\s\S]*full SHA[\s\S]*assign it exactly once[\s\S]*audit\.head/i],
        ['audit regeneration CLI', /regenerate-capability-audit\.js[\s\S]*--assign[\s\S]*--commit[\s\S]*advances `audit\.head`/i],
        ['explicit GitHub repository selection', /origin[\s\S]*upstream[\s\S]*--repo <owner\/name>/i],
        ['tracked or CI-produced test inputs', /git-tracked or produced by an earlier step of the CI job/i],
        ['build outputs absent rerun', /build outputs absent/i],
        ['machine state hermeticity', /git identity, environment variables, tools on PATH/i],
        ['user-visible rendered owner', /every user-visible UI\/Webview regression[\s\S]*automated owner[\s\S]*final rendered or interaction surface[\s\S]*ViewModel[\s\S]*insufficient/i],
        ['cross-feature rendered journey', /cross-feature journey[\s\S]*real rendered surface[\s\S]*provider[\s\S]*viewport\s+matrix/i],
        ['post-repair mutation sensitivity', /implementation is already repaired[\s\S]*mutation sensitivity[\s\S]*reintroduce each causal defect/i],
        ['default-branch check ownership', /pull_request_target[\s\S]*default-branch files/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 verifies remote extension installation on the active host', () => {
    const skill = readSkill('.skills/installing-vscode-extensions-locally/SKILL.md');

    assertSkillMentions(skill, [
        ['stale VSCODE_IPC_HOOK_CLI handling', /stale[\s\S]*VSCODE_IPC_HOOK_CLI/i],
        ['active code-server selection', /active code-server/i],
        ['host-specific workspace installation', /workspace extension[\s\S]*active remote Server host/i],
        ['socket-independent extension-management entry point', /socket-independent[\s\S]*extension-management entry point/i],
        ['entry point matches active Server commit', /extension-management entry point[\s\S]*reports? (?:a )?version\/commit[\s\S]*active Server commit/i],
        ['one-shot production gulp builds', /npx gulp --production/i],
        ['wrapper resolves to active Server installation', /wrapper[\s\S]*resolve[\s\S]*verify[\s\S]*active Server installation/i],
        ['remote-cli active IPC gate', /remote-cli[\s\S]*(?:only|unless)[\s\S]*reachable[\s\S]*active host/i],
        ['representative hash comparison', /representative[\s\S]*hash/i],
        ['post-install Extension Host activation', /Extension Host process start time[\s\S]*installed-file timestamp[\s\S]*Developer: Reload Window[\s\S]*observed before that reload/i],
        ['installation versus runtime activation', /verified disk bytes[\s\S]*verified runtime activation/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 requires whole-branch review and blocks unexplained failures', () => {
    const skill = readSkill('.skills/review-fix-commit-loop/SKILL.md');

    assertSkillMentions(skill, [
        ['merge-base-to-HEAD integration review', /merge-base-to-HEAD/i],
        ['unexplained CI or harness failures', /unexplained[\s\S]*(?:CI|harness)[\s\S]*failures/i],
        ['blocking failure classification', /blocking[\s\S]*classif|classif[\s\S]*blocking/i],
        ['build-cleaner dependency ordering', /cleans or rebuilds `out\/`[\s\S]*consume `out\/`/i],
        ['performance-threshold isolation', /browser performance-threshold tests[\s\S]*without concurrent CPU-intensive[\s\S]*coverage[\s\S]*rerun[\s\S]*browser suite alone/i],
        ['aggregate runtime safety gate', /runtime identity[\s\S]*tmux metadata versions[\s\S]*runtime-binding[\s\S]*npm run test:safety:run[\s\S]*migration[\s\S]*recovery[\s\S]*cross-host race/i],
        ['post-implementation capability audit', /final implementation or skill-owner commit[\s\S]*audit\.head/i],
        ['exit-code-gated verification', /own exit code[\s\S]*pipefail[\s\S]*never `;`/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 verifies ambiguous GitHub writes and transport recovery', () => {
    const skill = readSkill('.skills/publishing-and-merging-github-prs/SKILL.md');

    assertSkillMentions(skill, [
        ['workflow lesson harvest before audit', /harvesting-workflow-lessons[\s\S]*before[\s\S]*final capability audit/i],
        ['explicit repository selection', /--repo <owner\/name>[\s\S]*automatic remote[\s\S]*selection/i],
        ['base freshness before final artifacts', /before final verification[\s\S]*feature branch is behind[\s\S]*rebase[\s\S]*Never publish or report artifacts built before the[\s\S]*rebase/i],
        ['companion protocol version bump', /separately packaged extension[\s\S]*runtime or protocol[\s\S]*manifest version[\s\S]*origin\/main[\s\S]*higher version/i],
        ['transport result verification', /HTTP 408[\s\S]*unexpected EOF[\s\S]*remote branch SHA/i],
        ['HTTP/1.1 retry', /http\.version=HTTP\/1\.1 push/i],
        ['non-force retry', /same non-force refspec/i],
        ['owner approvals section in PR body', /## Owner approvals[\s\S]*approve-architecture <full-head-sha>[\s\S]*approve <full-head-sha>[\s\S]*SEPARATE comment/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 harvests evidence-backed workflow lessons without forced churn', () => {
    const skill = readSkill('.skills/harvesting-workflow-lessons/SKILL.md');

    assertSkillMentions(skill, [
        ['task-local evidence', /user corrections[\s\S]*failed checks[\s\S]*false starts/i],
        ['instruction versus compliance gap', /instruction gap[\s\S]*compliance gap/i],
        ['existing skill before new skill', /improve[\s\S]*existing skill[\s\S]*create a new skill only/i],
        ['validated skill iteration', /skill-creator[\s\S]*quick_validate\.py[\s\S]*owner tests/i],
        ['implementation-path audit sequence', /\.skills\/[\s\S]*implementation paths[\s\S]*full commit SHA[\s\S]*audit\.head/i],
        ['canonical editable skills directory', /live under `\.skills\/`[\s\S]*canonical, editable[\s\S]*untracked\s+local\s+mirrors/i],
        ['mirror edit prohibition', /Edit skills only under `\.skills\/`[\s\S]*Never modify, create, or delete skill/i],
        ['valid no-change decision', /no skill change/i],
        ['bounded non-recursive pass', /only one harvest pass[\s\S]*do[\s\S]*not recursively trigger/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 installs dependencies inside fresh worktrees before verification', () => {
    const skill = readSkill('.skills/protecting-main-with-worktrees/SKILL.md');

    assertSkillMentions(skill, [
        ['worktree-local dependency install', /npm ci/i],
        ['parent node_modules masking', /parent checkout's node_modules/i],
        ['path-constructed lookup failure', /constructs[\s\S]*node_modules\/\.\.\.[\s\S]*paths directly/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 syncs exact command and packaging registries on surface changes', () => {
    const skill = readSkill('.skills/registering-extension-commands/SKILL.md');

    assertSkillMentions(skill, [
        ['sibling probe over memory', /sibling entry instead of trusting[\s\S]*memory[\s\S]*grep -rln/i],
        ['command registry sync points', /commandRegistration\.ts[\s\S]*dashboardBoundaries\.test\.js[\s\S]*run-dashboard-webview-checks\.js/i],
        ['reviewed VSIX list sync', /out\/openWorkspaces[\s\S]*run-release-packaging-checks\.js/i],
        ['bridge tsconfig include list', /attention-ui-bridge[\s\S]*tsconfig\.json[\s\S]*include/i],
        ['real exit codes', /pipefail[\s\S]*never pipe[\s\S]*tail/i],
    ]);
});


test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 verifies provider adapters against real on-disk data', () => {
    const skill = readSkill('.skills/developing-provider-conversation-adapters/SKILL.md');

    assertSkillMentions(skill, [
        ['real data verification rule', /real on-disk provider data/i],
        ['self-consistent fixture trap', /self-consistent trap/i],
        ['probe before assuming', /probe real data first/i],
        ['large framed responses are measured against the transport cap', /framed protocol[\s\S]*full response byte size[\s\S]*large live response[\s\S]*transport cap/i],
        ['layout mirroring', /mirror the real layout/i],
        ['status inference guidance', /no status[\s\S]*transcript tail/i],
        ['type imports remain inside the Codex boundary', /full relative-import graph[\s\S]*type-only imports[\s\S]*architecture-guarded/i],
        ['rollout readers are injected at composition', /rollout telemetry readers[\s\S]*composition\.ts[\s\S]*local structural type/i],
        ['focused architecture verification', /npm run test:architecture-guards[\s\S]*before the full gate/i],
    ]);
});


test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 gates every PR merge on explicit approval', () => {
    const skill = readSkill('.skills/publishing-and-merging-github-prs/SKILL.md');

    assertSkillMentions(skill, [
        ['merge gated by default', /every merge as gated by default/i],
        ['green CI is not merge authorization', /green CI is never merge authorization/i],
        ['stop and wait for explicit approval', /stop, report the state, and wait for an explicit in-conversation approval/i],
        ['every PR type covered', /refactors, test-only changes, and behavior changes alike/i],
        ['pure-refactor merge habits do not carry over', /does not carry over/i],
        ['guardrail: checks are not approval', /Never merge a PR without an explicit in-conversation approval[\s\S]*green checks are not approval/i],
        ['mechanical merge-approval status', /`merge-approval` status[\s\S]*turns green only after the repository owner posts an approval comment/i],
        ['never bypass or forge approval', /Never use `--admin`[\s\S]*never post, edit, or imitate the approval comment/i],
        ['post-merge audit catches violations', /run-merge-approval-audit\.js[\s\S]*fails red/i],
    ]);
});
