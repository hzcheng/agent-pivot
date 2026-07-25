'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    projectAiSessionHistory,
} = require('../../../out/aiSessions/historyProjection');

test('WEBVIEW-MULTI-PROVIDER-SESSION-HISTORY-001 keeps pinned and unpinned provider runs adjacent', () => {
    const projection = projectAiSessionHistory(['kimi', 'codex', 'claude'], {
        codex: [
            { id: 'c-pin', provider: 'codex', pinned: true },
            { id: 'c-new', provider: 'codex' },
            { id: 'c-old', provider: 'codex' },
        ],
        kimi: [
            { id: 'k-pin', provider: 'kimi', pinned: true },
            { id: 'k-new', provider: 'kimi' },
        ],
        claude: [
            { id: 'a-new', provider: 'claude' },
        ],
    });

    assert.deepEqual(projection.pinned.map(item => item.id), ['k-pin', 'c-pin']);
    assert.deepEqual(projection.unpinned.map(item => item.id), [
        'k-new', 'c-new', 'c-old', 'a-new',
    ]);
});
