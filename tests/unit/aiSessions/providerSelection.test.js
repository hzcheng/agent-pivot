'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    normalizeAiSessionProviderSelection,
} = require('../../../out/aiSessions/providerSelection');

const registeredProviders = ['codex', 'kimi', 'claude'];

test('SESSION-MULTI-PROVIDER-SELECTION-001 migrates one primary provider and normalizes ordered selections', () => {
    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'kimi',
    }), {
        primaryProvider: 'kimi',
        selectedProviders: ['kimi'],
    });

    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'kimi',
        selectedProviders: ['claude', 'unknown', 'codex', 'claude'],
    }), {
        primaryProvider: 'claude',
        selectedProviders: ['claude', 'codex'],
    });

    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'codex',
        selectedProviders: ['codex', 'claude', 'kimi'],
    }), {
        primaryProvider: 'codex',
        selectedProviders: ['codex', 'kimi', 'claude'],
    });

    assert.deepEqual(normalizeAiSessionProviderSelection({
        registeredProviders,
        primaryProvider: 'unknown',
        selectedProviders: [],
        sessionCounts: { codex: 0, kimi: 3, claude: 1 },
    }), {
        primaryProvider: 'kimi',
        selectedProviders: ['kimi'],
    });
});
