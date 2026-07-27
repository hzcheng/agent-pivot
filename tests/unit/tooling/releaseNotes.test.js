'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const releaseNotesChecks = require('../../../scripts/run-release-notes-checks');

test('release content validation cannot satisfy current facts from historical notes', () => {
    assert.equal(
        typeof releaseNotesChecks.validateReleaseContent,
        'function',
        'release checks must expose their pure release-content validator',
    );
    const changelog = [
        '# Changelog',
        '',
        '## [1.0.0] - 2026-07-26',
        '',
        '- Established the Agent Pivot identity.',
        '- Added a cross-workspace command center for Codex, Claude, and Kimi.',
        '- Added conversation navigation.',
        '',
        '## Unpublished Project Steward development history',
        '',
        '- Established the Pure Axis icon system.',
        '',
    ].join('\n');

    assert.throws(
        () => releaseNotesChecks.validateReleaseContent({
            readme: '# Agent Pivot\n',
            changelog,
            packageMetadata: {
                displayName: 'Agent Pivot',
                version: '1.0.0',
                description: 'Workspace command center.',
            },
        }),
        /1\.0\.0 CHANGELOG release must document Pure Axis icon system/,
    );
});
