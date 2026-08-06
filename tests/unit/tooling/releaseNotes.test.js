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
        '## [1.0.4] - 2026-08-06',
        '',
        '- AI Conversation renders provider tool calls as collapsible entries.',
        '- Added context-window usage telemetry.',
        '- The usage bar shows a worktree chip.',
        '- The quick-entry pills stay visible at zero count.',
        '',
        '## [1.0.2] - 2026-08-03',
        '',
        '- Added subagent viewing.',
        '',
    ].join('\n');

    assert.throws(
        () => releaseNotesChecks.validateReleaseContent({
            readme: '# Agent Pivot\n',
            changelog,
            packageMetadata: {
                displayName: 'Agent Pivot',
                version: '1.0.4',
                description: 'Workspace command center.',
            },
        }),
        /1\.0\.4 CHANGELOG release must document window switching command/,
    );
});
