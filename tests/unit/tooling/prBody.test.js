'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkPrBody, findSection, findHarvestSection } = require('../../../scripts/check-pr-body');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

function approvalsSection(headSha = HEAD) {
    return [
        '## Owner approvals',
        '',
        'Copy each line into a separate PR comment below:',
        '',
        '```',
        `approve-architecture ${headSha}`,
        '```',
        '',
        '```',
        `approve ${headSha}`,
        '```',
    ].join('\n');
}

function validBody() {
    return [
        '## Summary',
        '',
        'Fix the thing.',
        '',
        '## Skill harvest',
        '',
        'no skill change — the failure is already covered by run-ai-session-safety-checks.js',
        '',
        approvalsSection(),
        '',
        '## Verification',
        '',
        '- npm run test:ci:linux passes',
    ].join('\n');
}

test('ARCH-PR-SKILL-HARVEST-GATE-001 accepts a recorded no-change decision', () => {
    const body = validBody();
    assert.deepEqual(checkPrBody(body, { headSha: HEAD }), []);
    assert.equal(
        findHarvestSection(body),
        'no skill change — the failure is already covered by run-ai-session-safety-checks.js'
    );
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 accepts an updated-skills decision', () => {
    const body = '## Skill harvest\n\nupdated .skills/publishing-and-merging-github-prs — PRs are English-only\n'
        + '\n' + approvalsSection() + '\n';
    assert.deepEqual(checkPrBody(body, { headSha: HEAD }), []);
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 rejects a missing section', () => {
    const errors = checkPrBody('## Summary\n\nNo harvest here.\n\n' + approvalsSection() + '\n', { headSha: HEAD });
    assert.ok(errors.some(error => error.includes('## Skill harvest')), JSON.stringify(errors));
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 rejects a placeholder-only section', () => {
    const body = [
        '## Skill harvest',
        '',
        '<!--',
        'Required; CI rejects pull requests without this section.',
        '-->',
        '',
        approvalsSection(),
        '',
        '## Verification',
    ].join('\n');
    const errors = checkPrBody(body, { headSha: HEAD });
    assert.ok(errors.some(error => error.includes('empty')), JSON.stringify(errors));
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 stops section extraction at the next heading', () => {
    assert.equal(findSection('## Skill harvest\n## Verification\n', 'Skill harvest'), '');
    assert.equal(findSection('', 'Skill harvest'), null);
    assert.equal(findSection(undefined, 'Skill harvest'), null);
});

test('ARCH-PR-OWNER-APPROVALS-001 accepts both commands bound to the head SHA', () => {
    assert.deepEqual(checkPrBody(validBody(), { headSha: HEAD }), []);
});

test('ARCH-PR-OWNER-APPROVALS-001 rejects a missing "## Owner approvals" section', () => {
    const body = '## Skill harvest\n\nno skill change — covered\n';
    const errors = checkPrBody(body, { headSha: HEAD });
    assert.ok(errors.some(error => error.includes('## Owner approvals')), JSON.stringify(errors));
});

test('ARCH-PR-OWNER-APPROVALS-001 rejects commands that bind a stale head SHA', () => {
    const body = [
        '## Skill harvest',
        '',
        'no skill change — covered',
        '',
        approvalsSection(OTHER),
    ].join('\n');
    const errors = checkPrBody(body, { headSha: HEAD });
    assert.ok(errors.some(error => error.includes(`approve ${HEAD}`)), JSON.stringify(errors));
    assert.ok(errors.some(error => error.includes(`approve-architecture ${HEAD}`)), JSON.stringify(errors));
});

test('ARCH-PR-OWNER-APPROVALS-001 rejects a section missing the architecture approval line', () => {
    const body = [
        '## Skill harvest',
        '',
        'no skill change — covered',
        '',
        '## Owner approvals',
        '',
        '```',
        `approve ${HEAD}`,
        '```',
    ].join('\n');
    const errors = checkPrBody(body, { headSha: HEAD });
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.ok(errors[0].includes('approve-architecture'));
});

test('ARCH-PR-OWNER-APPROVALS-001 rejects a missing head SHA context (fail closed)', () => {
    const errors = checkPrBody(validBody());
    assert.ok(errors.some(error => error.includes('PR_HEAD_SHA')), JSON.stringify(errors));
});

test('ARCH-PR-OWNER-APPROVALS-001 short SHAs and prose do not satisfy the section', () => {
    const body = [
        '## Skill harvest',
        '',
        'no skill change — covered',
        '',
        '## Owner approvals',
        '',
        `approve ${HEAD.slice(0, 8)}`,
        `please approve-architecture ${HEAD} soon`,
    ].join('\n');
    const errors = checkPrBody(body, { headSha: HEAD });
    assert.equal(errors.length, 2, JSON.stringify(errors));
});
