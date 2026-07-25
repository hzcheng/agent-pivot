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
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 verifies remote extension installation on the active host', () => {
    const skill = readSkill('.codex/skills/installing-vscode-extensions-locally/SKILL.md');

    assertSkillMentions(skill, [
        ['stale VSCODE_IPC_HOOK_CLI handling', /stale[\s\S]*VSCODE_IPC_HOOK_CLI/i],
        ['active code-server selection', /active code-server/i],
        ['host-specific workspace installation', /workspace extension[\s\S]*active remote Server host/i],
        ['representative hash comparison', /representative[\s\S]*hash/i],
    ]);
});

test('ARCH-REPOSITORY-SKILL-GUIDANCE-001 requires whole-branch review and blocks unexplained failures', () => {
    const skill = readSkill('.codex/skills/review-fix-commit-loop/SKILL.md');

    assertSkillMentions(skill, [
        ['merge-base-to-HEAD integration review', /merge-base-to-HEAD/i],
        ['unexplained CI or harness failures', /unexplained[\s\S]*(?:CI|harness)[\s\S]*failures/i],
        ['blocking failure classification', /blocking[\s\S]*classif|classif[\s\S]*blocking/i],
    ]);
});
