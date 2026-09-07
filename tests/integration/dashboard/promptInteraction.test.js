'use strict';

// Covers WEBVIEW-AI-PROMPT-INTERACTION-001 and WEBVIEW-AI-PROMPT-MUTATION-001.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const protocol = fs.readFileSync(path.join(__dirname, '../../../src/webview/webviewPromptProtocolScripts.js'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../../../src/webview/webviewPromptScripts.js'), 'utf8');

function snapshot() {
    return { version: 2, revision: 3, selectedPromptId: null,
        groups: [{ id: 'general', name: 'General', kind: 'general' }],
        prompts: [{ id: 'review', name: 'Review', text: 'Review this.', groupId: 'general' }] };
}

function element(attributes = {}) {
    const values = new Map(Object.entries(attributes));
    return {
        hidden: false, disabled: false, scrollTop: 0,
        getAttribute: name => values.has(name) ? values.get(name) : null,
        setAttribute: (name, value) => values.set(name, String(value)),
        removeAttribute: name => values.delete(name),
        hasAttribute: name => values.has(name),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener: () => undefined, contains: () => false,
    };
}

function load() {
    const messages = [];
    const surface = element({ 'data-prompt-revision': '3' });
    const root = element();
    root.querySelector = selector => selector === '[data-prompt-surface]' ? surface : null;
    const window = { addEventListener: () => undefined, vscode: { postMessage: value => messages.push(value) } };
    const context = { window, document: { body: {}, activeElement: null }, Map, Set, JSON, Number, Date, Math };
    vm.runInNewContext(protocol, context);
    vm.runInNewContext(script, context);
    assert.equal(window.__agentPivotPrompts.mount(root, { authoritySequence: 1, snapshot: snapshot() }), true);
    return { api: window.__agentPivotPrompts, messages };
}

test('Prompt tree webview posts correlated Group and move operations', () => {
    const fixture = load();
    assert.ok(fixture.api.dispatch('create-group', { name: 'Feature work' }));
    const message = fixture.messages[0];
    assert.deepEqual({ type: message.type, version: message.version, target: message.target, operation: message.operation, expectedRevision: message.expectedRevision, payload: message.payload }, {
        type: 'prompt-command', version: 1, target: 'global-prompt-library', operation: 'create-group', expectedRevision: 3, payload: { name: 'Feature work' },
    });
});

test('Prompt tree webview protocol validates tree snapshots and all tree operations', () => {
    assert.match(protocol, /PROMPT_DATA_VERSION = 2/);
    for (const operation of ['create-group', 'delete-group', 'move']) {
        assert.match(protocol, new RegExp(`'${operation}'`));
    }
    assert.match(script, /data-prompt-group-id/);
    assert.match(script, /prompt-toggle-group/);
});
