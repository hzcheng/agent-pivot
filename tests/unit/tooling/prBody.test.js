'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { checkPrBody, findHarvestSection } = require('../../../scripts/check-pr-body');

test('ARCH-PR-SKILL-HARVEST-GATE-001 accepts a recorded no-change decision', () => {
    const body = [
        '## Summary',
        '',
        'Fix the thing.',
        '',
        '## Skill harvest',
        '',
        'no skill change — the failure is already covered by run-ai-session-safety-checks.js',
        '',
        '## Verification',
        '',
        '- npm run test:ci:linux passes',
    ].join('\n');
    assert.deepEqual(checkPrBody(body), []);
    assert.equal(
        findHarvestSection(body),
        'no skill change — the failure is already covered by run-ai-session-safety-checks.js'
    );
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 accepts an updated-skills decision', () => {
    const body = '## Skill harvest\n\nupdated .skills/publishing-and-merging-github-prs — PRs are English-only\n';
    assert.deepEqual(checkPrBody(body), []);
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 rejects a missing section', () => {
    const errors = checkPrBody('## Summary\n\nNo harvest here.\n');
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('## Skill harvest'));
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 rejects a placeholder-only section', () => {
    const body = [
        '## Skill harvest',
        '',
        '<!--',
        'Required; CI rejects pull requests without this section.',
        '-->',
        '',
        '## Verification',
    ].join('\n');
    const errors = checkPrBody(body);
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes('empty'));
});

test('ARCH-PR-SKILL-HARVEST-GATE-001 stops section extraction at the next heading', () => {
    assert.equal(findHarvestSection('## Skill harvest\n## Verification\n'), '');
    assert.equal(findHarvestSection(''), null);
    assert.equal(findHarvestSection(undefined), null);
});
