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
        '## [1.0.1] - 2026-07-31',
        '',
        '- Added a rich AI Conversation review workflow.',
        '- Added context-window usage telemetry.',
        '- Added pinning for other open workspace cards.',
        '- Kept the AI Conversation reading position stable.',
        '',
        '## [1.0.0] - 2026-07-26',
        '',
        '- Added an AI Skills workspace.',
        '',
    ].join('\n');

    assert.throws(
        () => releaseNotesChecks.validateReleaseContent({
            readme: '# Agent Pivot\n',
            changelog,
            packageMetadata: {
                displayName: 'Agent Pivot',
                version: '1.0.1',
                description: 'Workspace command center.',
            },
        }),
        /1\.0\.1 CHANGELOG release must document AI Skills management/,
    );
});
