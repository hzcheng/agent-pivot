'use strict';

// RELEASE-MARKETPLACE-DISCOVERABILITY-001
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const manifest = require(path.resolve(__dirname, '../../../package.json'));

test('RELEASE-MARKETPLACE-DISCOVERABILITY-001 description names every provider and the core surfaces', () => {
    const description = manifest.description;
    assert.equal(typeof description, 'string');
    for (const provider of ['Codex', 'Claude', 'Kimi']) {
        assert.ok(description.includes(provider),
            `description must name the ${provider} provider`);
    }
    for (const surface of ['project manager', 'prompt library']) {
        assert.ok(description.toLowerCase().includes(surface),
            `description must cover the ${surface} surface`);
    }
});

test('RELEASE-MARKETPLACE-DISCOVERABILITY-001 keywords cover the provider and feature search terms', () => {
    const keywords = manifest.keywords;
    assert.ok(Array.isArray(keywords), 'package.json must carry a keywords array');
    for (const term of [
        'agent', 'ai',
        'codex', 'codex cli',
        'claude', 'claude code',
        'kimi', 'kimi cli',
        'ai sessions', 'session manager',
        'project manager', 'projects',
        'prompts', 'prompt library',
        'workspace', 'tmux', 'dashboard',
    ]) {
        assert.ok(keywords.includes(term), `keywords must include "${term}"`);
    }
    assert.equal(new Set(keywords).size, keywords.length, 'keywords must not repeat');
    assert.ok(keywords.length <= 30, 'keywords stay within the marketplace keyword budget');
});
