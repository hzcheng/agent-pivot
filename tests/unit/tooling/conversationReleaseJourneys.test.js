'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../../../scripts/check-conversation-release-journeys');
const { loadBehaviorCatalog } = require('../../../scripts/lib/behaviorCatalog');
const {
    loadReleaseJourneyCatalog,
    validateReleaseJourneyCatalog,
} = require('../../../scripts/lib/releaseJourneyCatalog');

const repositoryRoot = path.resolve(__dirname, '../../..');
const manifest = loadReleaseJourneyCatalog(path.join(
    repositoryRoot,
    'docs/testing/conversation-release-journeys.json'
));
const behaviors = loadBehaviorCatalog(path.join(
    repositoryRoot,
    'docs/testing/behavior-contracts.json'
));

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

test('RELEASE-CONVERSATION-JOURNEYS-001 command reports accepted and rejected catalogs', () => {
    const acceptedLogs = [];
    assert.equal(main({
        manifest,
        behaviors,
        logger: {
            error: message => acceptedLogs.push(`error:${message}`),
            log: message => acceptedLogs.push(message),
        },
    }), 0);
    assert.deepEqual(acceptedLogs, [
        `AI Conversation release journey checks passed: ${manifest.blockers.length} blockers.`,
    ]);

    const rejected = clone(manifest);
    rejected.blockers[0].behaviors[0] = 'MISSING-BEHAVIOR-001';
    const rejectedLogs = [];
    assert.equal(main({
        manifest: rejected,
        behaviors,
        logger: {
            error: message => rejectedLogs.push(message),
            log: message => rejectedLogs.push(`log:${message}`),
        },
    }), 1);
    assert.match(rejectedLogs.join('\n'), /references missing behavior/);
});

test('RELEASE-CONVERSATION-JOURNEYS-001 accepts every reviewed AI Conversation release blocker', () => {
    assert.deepEqual(validateReleaseJourneyCatalog(manifest, { behaviors }), []);
    assert.deepEqual(manifest.blockers.map(blocker => blocker.id), [
        'CONVERSATION-RELEASE-PROVIDERS-001',
        'CONVERSATION-RELEASE-READING-FOCUS-001',
        'CONVERSATION-RELEASE-MERMAID-001',
        'CONVERSATION-RELEASE-COMMENT-PERSISTENCE-001',
        'CONVERSATION-RELEASE-COMMENT-STAGING-001',
        'CONVERSATION-RELEASE-SESSION-SWITCH-001',
        'CONVERSATION-RELEASE-OUTLINE-001',
        'CONVERSATION-RELEASE-NARROW-LAYOUT-001',
        'CONVERSATION-RELEASE-LARGE-SESSION-001',
        'CONVERSATION-RELEASE-PACKAGED-HOST-001',
    ]);
});

test('RELEASE-CONVERSATION-JOURNEYS-001 rejects missing, downgraded, or nonautomated PR evidence', () => {
    const missing = clone(manifest);
    missing.blockers[0].behaviors[0] = 'MISSING-BEHAVIOR-001';
    assert.match(
        validateReleaseJourneyCatalog(missing, { behaviors }).join('\n'),
        /references missing behavior/
    );

    const downgradedBehaviors = clone(behaviors);
    downgradedBehaviors.find(item =>
        item.id === 'CONVERSATION-READING-FOCUS-001'
    ).priority = 'P1';
    assert.match(
        validateReleaseJourneyCatalog(manifest, {
            behaviors: downgradedBehaviors,
        }).join('\n'),
        /must remain P0/
    );

    const scheduledPrBehaviors = clone(behaviors);
    scheduledPrBehaviors.find(item =>
        item.id === 'CONVERSATION-COMMENTS-PERSISTENCE-001'
    ).status = 'scheduled';
    assert.match(
        validateReleaseJourneyCatalog(manifest, {
            behaviors: scheduledPrBehaviors,
        }).join('\n'),
        /pull-request behavior .* must remain automated/
    );
});

test('RELEASE-CONVERSATION-JOURNEYS-001 requires unique exact blockers and scheduled release evidence', () => {
    const duplicate = clone(manifest);
    duplicate.blockers[1].id = duplicate.blockers[0].id;
    duplicate.blockers[0].extra = true;
    const duplicateErrors = validateReleaseJourneyCatalog(duplicate, { behaviors });
    assert.match(duplicateErrors.join('\n'), /has duplicate id/);
    assert.match(duplicateErrors.join('\n'), /must define exactly/);

    const noScheduledEvidence = clone(behaviors);
    noScheduledEvidence.find(item =>
        item.id === 'RELEASE-SCHEDULED-EXTENSION-HOST-001'
    ).status = 'automated';
    assert.match(
        validateReleaseJourneyCatalog(manifest, {
            behaviors: noScheduledEvidence,
        }).join('\n'),
        /must retain scheduled Extension Host evidence/
    );
});
