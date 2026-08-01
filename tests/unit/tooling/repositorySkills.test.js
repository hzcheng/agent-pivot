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
    const skill = readSkill('.codex/skills/resilient-webview-mutation-protocols/SKILL.md');

    assertSkillMentions(skill, [
        ['schema version', /schema version/i],
        ['request correlation', /requestId/],
        ['Host authority', /Host.*authoritative/i],
        ['authoritative replacement', /authoritative replacement/i],
        ['mirrored persistence repair', /mirrored persistence[\s\S]*repair/i],
        ['composite identity', /composite (?:identity|key)/i],
        ['partial results', /partial results?/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 keeps regression audits path-based and current', () => {
    const skill = readSkill('.codex/skills/fixing-regressions-with-ci/SKILL.md');

    assertSkillMentions(skill, [
        ['path-based classification', /changed paths/i],
        ['literal behavior IDs', /literal behavior IDs/i],
        ['behavior-contract validation', /npm run test:behavior-contracts/i],
        ['audit-head currency', /audit.head/i],
        ['skill and owner-test implementation paths', /\.codex\/skills\/[\s\S]*skill-owner tests[\s\S]*implementation paths/i],
        ['post-commit SHA audit sequence', /final implementation commit[\s\S]*full SHA[\s\S]*assign it exactly once[\s\S]*audit\.head/i],
        ['explicit GitHub repository selection', /origin[\s\S]*upstream[\s\S]*--repo <owner\/name>/i],
        ['tracked or CI-produced test inputs', /git-tracked or produced by an earlier step of the CI job/i],
        ['build outputs absent rerun', /build outputs absent/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 verifies remote extension installation on the active host', () => {
    const skill = readSkill('.codex/skills/installing-vscode-extensions-locally/SKILL.md');

    assertSkillMentions(skill, [
        ['stale VSCODE_IPC_HOOK_CLI handling', /stale[\s\S]*VSCODE_IPC_HOOK_CLI/i],
        ['active code-server selection', /active code-server/i],
        ['host-specific workspace installation', /workspace extension[\s\S]*active remote Server host/i],
        ['socket-independent extension-management entry point', /socket-independent[\s\S]*extension-management entry point/i],
        ['entry point matches active Server commit', /extension-management entry point[\s\S]*reports? (?:a )?version\/commit[\s\S]*active Server commit/i],
        ['wrapper resolves to active Server installation', /wrapper[\s\S]*resolve[\s\S]*verify[\s\S]*active Server installation/i],
        ['remote-cli active IPC gate', /remote-cli[\s\S]*(?:only|unless)[\s\S]*reachable[\s\S]*active host/i],
        ['representative hash comparison', /representative[\s\S]*hash/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 requires whole-branch review and blocks unexplained failures', () => {
    const skill = readSkill('.codex/skills/review-fix-commit-loop/SKILL.md');

    assertSkillMentions(skill, [
        ['merge-base-to-HEAD integration review', /merge-base-to-HEAD/i],
        ['unexplained CI or harness failures', /unexplained[\s\S]*(?:CI|harness)[\s\S]*failures/i],
        ['blocking failure classification', /blocking[\s\S]*classif|classif[\s\S]*blocking/i],
        ['build-cleaner dependency ordering', /cleans or rebuilds `out\/`[\s\S]*consume `out\/`/i],
        ['post-implementation capability audit', /final implementation or skill-owner commit[\s\S]*audit\.head/i],
        ['exit-code-gated verification', /own exit code[\s\S]*pipefail[\s\S]*never `;`/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 verifies ambiguous GitHub writes and transport recovery', () => {
    const skill = readSkill('.codex/skills/publishing-and-merging-github-prs/SKILL.md');

    assertSkillMentions(skill, [
        ['workflow lesson harvest before audit', /harvesting-workflow-lessons[\s\S]*before[\s\S]*final capability audit/i],
        ['explicit repository selection', /--repo <owner\/name>[\s\S]*automatic remote[\s\S]*selection/i],
        ['transport result verification', /HTTP 408[\s\S]*unexpected EOF[\s\S]*remote branch SHA/i],
        ['HTTP/1.1 retry', /http\.version=HTTP\/1\.1 push/i],
        ['non-force retry', /same non-force refspec/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 harvests evidence-backed workflow lessons without forced churn', () => {
    const skill = readSkill('.codex/skills/harvesting-workflow-lessons/SKILL.md');

    assertSkillMentions(skill, [
        ['task-local evidence', /user corrections[\s\S]*failed checks[\s\S]*false starts/i],
        ['instruction versus compliance gap', /instruction gap[\s\S]*compliance gap/i],
        ['existing skill before new skill', /improve[\s\S]*existing skill[\s\S]*create a new skill only/i],
        ['validated skill iteration', /skill-creator[\s\S]*quick_validate\.py[\s\S]*owner tests/i],
        ['implementation-path audit sequence', /\.codex\/skills\/[\s\S]*implementation paths[\s\S]*full commit SHA[\s\S]*audit\.head/i],
        ['valid no-change decision', /no skill change/i],
        ['bounded non-recursive pass', /only one harvest pass[\s\S]*do[\s\S]*not recursively trigger/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 installs dependencies inside fresh worktrees before verification', () => {
    const skill = readSkill('.codex/skills/protecting-main-with-worktrees/SKILL.md');

    assertSkillMentions(skill, [
        ['worktree-local dependency install', /npm ci/i],
        ['parent node_modules masking', /parent checkout's node_modules/i],
        ['path-constructed lookup failure', /constructs[\s\S]*node_modules\/\.\.\.[\s\S]*paths directly/i],
    ]);
});
