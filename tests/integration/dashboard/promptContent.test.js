'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getAiPanelContent, getPromptSurfaceContent } = require('../../../out/prompts/webviewContent');

function snapshot(overrides = {}) {
    return {
        version: 2,
        revision: 4,
        selectedPromptId: null,
        groups: [
            { id: 'general', name: 'General', kind: 'general' },
            { id: 'feature', name: 'Feature · PR flow', kind: 'custom' },
        ],
        prompts: [
            { id: 'review', name: 'Review implementation', description: 'Review a focused code change', text: 'Review the focused code change.', groupId: 'general' },
            { id: 'plan', name: 'Plan the feature', text: 'Plan\nthe feature', groupId: 'feature' },
        ],
        ...overrides,
    };
}

test('AI Prompt content exposes only Prompts and Skills tabs', () => {
    const html = getAiPanelContent(snapshot());
    assert.match(html, /id="ai-tab-prompts"[^>]*aria-selected="true"/);
    assert.match(html, /id="ai-tab-skills"[^>]*aria-selected="false"/);
    assert.doesNotMatch(html, /ai-tab-(?:mcp|hooks)/);
});

test('AI Prompt content renders a compact General-first tree and no local search field', () => {
    const html = getPromptSurfaceContent(snapshot());
    assert.match(html, /data-prompt-group-id="general"/);
    assert.match(html, /Default group for prompts not assigned to a custom group/);
    assert.match(html, /data-prompt-group-id="feature"/);
    assert.match(html, /Review implementation/);
    assert.match(html, />Use<\/button>/);
    assert.doesNotMatch(html, /type="search"/);
});

test('AI Prompt content keeps one Prompt in one rendered group', () => {
    const html = getPromptSurfaceContent(snapshot());
    assert.equal((html.match(/<li class="prompt-item" data-prompt-id="review"/g) || []).length, 1);
    assert.equal((html.match(/<li class="prompt-item" data-prompt-id="plan"/g) || []).length, 1);
});

test('AI Prompt content provides group creation, per-group Prompt creation, and safe move actions', () => {
    const html = getPromptSurfaceContent(snapshot());
    assert.match(html, /data-action="prompt-group-new"/);
    assert.match(html, /data-action="prompt-new" data-prompt-group-id="feature"/);
    assert.match(html, /data-action="prompt-move" data-prompt-id="review" data-prompt-group-id="feature"/);
    assert.match(html, /data-action="prompt-delete-group" data-prompt-group-id="feature"/);
    assert.doesNotMatch(html, /data-action="prompt-delete-group" data-prompt-group-id="general"/);
});

test('AI Prompt content escapes stored Prompt text and describes optional detail', () => {
    const html = getPromptSurfaceContent(snapshot({
        prompts: [{ id: 'unsafe', name: '<unsafe>', description: '<summary>', text: '<body>', groupId: 'general' }],
    }));
    assert.match(html, /&lt;unsafe&gt;/);
    assert.match(html, /&lt;summary&gt;/);
    assert.match(html, /&lt;body&gt;/);
    assert.match(html, /Description <span class="steward-meta">optional<\/span>/);
});
