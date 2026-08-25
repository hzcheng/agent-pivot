'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveHandoffSessionAlias } = require('../../../out/aiSessions/handoffNaming');

// SESSION-HANDOFF-002

test('a named source becomes "<name> (2)"', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: 'Auth fix',
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        existingNames: ['Auth fix'],
    });
    assert.equal(alias, 'Auth fix (2)');
});

test('a previous handoff continues the generation chain instead of nesting', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: 'Auth fix (2)',
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        existingNames: ['Auth fix', 'Auth fix (2)'],
    });
    assert.equal(alias, 'Auth fix (3)');
});

test('collisions skip to the next free generation', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: 'Auth fix',
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        existingNames: ['Auth fix', 'Auth fix (2)', 'Auth fix (3)'],
    });
    assert.equal(alias, 'Auth fix (4)');
});

test('an unnamed source falls back to provider and short session id', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: '',
        sourceProviderLabel: 'Claude',
        sourceSessionId: 'abc12345-6789-0000-0000-000000000000',
        existingNames: [],
    });
    assert.equal(alias, 'Handoff from Claude · abc12345');
});

test('an unnamed fallback colliding with an existing name gets a generation suffix', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: '',
        sourceProviderLabel: 'Kimi',
        sourceSessionId: 'deadbeef-0000',
        existingNames: ['Handoff from Kimi · deadbeef'],
    });
    assert.equal(alias, 'Handoff from Kimi · deadbeef (2)');
});

test('long source names are bounded so the generation suffix stays visible', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: 'A very long session alias that keeps going well past the row width',
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        existingNames: [],
    });
    assert.ok(alias.length <= 52, `alias stays within the row label budget: ${alias}`);
    assert.match(alias, / \(2\)$/);
});

test('fragments are sanitized against control characters and whitespace', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: '  Fix \n login\r\n bug  ',
        sourceProviderLabel: 'Codex',
        sourceSessionId: 'abc-123',
        existingNames: [],
    });
    assert.equal(alias, 'Fix   login  bug (2)');
    assert.ok(!/[\r\n]/.test(alias));
});

test('a missing provider label and session id still produce a usable alias', () => {
    const alias = deriveHandoffSessionAlias({
        sourceName: '',
        sourceProviderLabel: '',
        sourceSessionId: '',
        existingNames: [],
    });
    assert.equal(alias, 'Handoff from AI');
});
