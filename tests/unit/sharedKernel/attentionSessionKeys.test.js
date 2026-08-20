'use strict';

// Characterization tests for the attention session-key codecs pinned in the
// shared kernel (src/attentionSessionKeys.ts). The encodings are a persisted
// contract — runtime settlement, workspace projections, and the attention
// pipeline must agree byte-for-byte.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    getAttentionRuntimeSessionKey,
    getLogicalAttentionSessionKey,
} = require('../../../out/attentionSessionKeys');

test('getAttentionRuntimeSessionKey joins the five identity fields in order', () => {
    assert.equal(getAttentionRuntimeSessionKey({
        workspaceScopeIdentity: 'scope:one',
        provider: 'codex',
        sessionId: 'sess-1',
        runStartedAtMs: 42,
        backend: 'tmux',
    }), 'scope:one:codex:sess-1:42:tmux');
});

test('getLogicalAttentionSessionKey strips the scope hash, run timestamp, and backend', () => {
    assert.equal(
        getLogicalAttentionSessionKey(`${'a'.repeat(64)}:codex:sess-1:42:tmux`),
        'codex:sess-1',
    );
    assert.equal(getLogicalAttentionSessionKey('kimi:sess-2:7:vscode'), 'kimi:sess-2');
    assert.equal(
        getLogicalAttentionSessionKey('claude:session:with:colons:9:tmux'),
        'claude:session:with:colons',
    );
});

test('getLogicalAttentionSessionKey passes through keys outside the runtime shape', () => {
    assert.equal(getLogicalAttentionSessionKey('opaque-session-key'), 'opaque-session-key');
    assert.equal(getLogicalAttentionSessionKey(''), '');
    assert.equal(getLogicalAttentionSessionKey('codex:no-timestamp'), 'codex:no-timestamp');
});
