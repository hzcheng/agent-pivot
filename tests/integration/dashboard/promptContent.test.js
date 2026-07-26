'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    getAiPanelContent,
    getPromptSurfaceContent,
} = require('../../../out/prompts/webviewContent');

function snapshot(overrides = {}) {
    return {
        version: 1,
        revision: 4,
        selectedPromptId: null,
        prompts: [],
        ...overrides,
    };
}

test('AI Prompt content renders four accessible subtabs with PROMPTS selected', () => {
    const html = getAiPanelContent(snapshot());

    assert.match(html, /<div class="ai-panel" data-ai-panel>/);
    assert.match(html, /role="tablist" aria-label="AI configuration"/);
    for (const [name, id] of [
        ['PROMPTS', 'prompts'],
        ['SKILLS', 'skills'],
        ['MCP', 'mcp'],
        ['HOOKS', 'hooks'],
    ]) {
        assert.match(html, new RegExp(
            `<button[^>]*role="tab"[^>]*id="ai-tab-${id}"[^>]*aria-controls="ai-panel-${id}"[^>]*>${name}</button>`
        ));
        assert.match(html, new RegExp(
            `<section[^>]*role="tabpanel"[^>]*id="ai-panel-${id}"[^>]*aria-labelledby="ai-tab-${id}"`
        ));
    }

    assert.match(html, /id="ai-tab-prompts"[^>]*aria-selected="true"[^>]*tabindex="0"/);
    assert.match(html, /id="ai-tab-skills"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    assert.match(html, /id="ai-tab-mcp"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    assert.match(html, /id="ai-tab-hooks"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
    assert.doesNotMatch(html, /id="ai-panel-prompts"[^>]* hidden/);
    assert.match(html, /id="ai-panel-skills"[^>]* hidden/);
    assert.match(html, /id="ai-panel-mcp"[^>]* hidden/);
    assert.match(html, /id="ai-panel-hooks"[^>]* hidden/);
});

test('AI Prompt content renders the authoritative management shell and empty state', () => {
    const html = getPromptSurfaceContent(snapshot({ revision: 7 }));

    assert.match(html, /data-prompt-surface/);
    assert.match(html, /data-prompt-revision="7"/);
    assert.match(html, /<button[^>]*data-action="prompt-new"[^>]*>New Prompt<\/button>/);
    assert.match(html, /<form[^>]*data-prompt-form="create"[^>]* hidden>/);
    assert.match(html, /<label[^>]*for="prompt-create-name"[^>]*>Prompt name<\/label>/);
    assert.match(html, /<input[^>]*id="prompt-create-name"[^>]*name="name"/);
    assert.match(html, /<label[^>]*for="prompt-create-text"[^>]*>Prompt text<\/label>/);
    assert.match(html, /<textarea[^>]*id="prompt-create-text"[^>]*name="text"/);
    assert.match(html, /<ol[^>]*data-prompt-list/);
    assert.match(html, /data-prompt-empty/);
    assert.match(html, /No AI Prompts are configured/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /role="status"/);
});

test('AI Prompt content escapes setting-originated IDs, names, and bodies', () => {
    const hostileId = `prompt-"<&'`;
    const hostileName = `Name <script> & "quote" 'single'`;
    const hostileBody = `Body </textarea><img src=x onerror="alert(1)"> & 'private'`;
    const html = getPromptSurfaceContent(snapshot({
        selectedPromptId: hostileId,
        prompts: [{ id: hostileId, name: hostileName, text: hostileBody }],
    }));

    assert.doesNotMatch(html, /<script>|<\/textarea><img|onerror="alert/);
    assert.doesNotMatch(html, new RegExp(hostileId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(html, /data-prompt-id="prompt-&quot;&lt;&amp;&#39;"/);
    assert.match(html, /Name &lt;script&gt; &amp; &quot;quote&quot; &#39;single&#39;/);
    assert.match(html, /Body &lt;\/textarea&gt;&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; &amp; &#39;private&#39;/);
});

test('AI Prompt content renders bounded plain-text previews and full editable values', () => {
    const body = `First line ${'x'.repeat(240)}\nsecond line private tail`;
    const html = getPromptSurfaceContent(snapshot({
        prompts: [{ id: 'prompt-a', name: 'Long', text: body }],
    }));
    const preview = html.match(/<p class="prompt-preview"[^>]*>([^<]*)<\/p>/);

    assert.ok(preview);
    assert.ok(preview[1].length <= 161);
    assert.match(preview[1], /…$/);
    assert.doesNotMatch(preview[1], /second line private tail/);
    assert.doesNotMatch(html, /<p class="prompt-preview"[^>]*\stitle=/);
    assert.match(html, /<textarea[^>]*name="text"[^>]*>First line /);
    assert.match(html, /second line private tail<\/textarea>/);
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 AI Prompt content bounds CR and CRLF previews to the first line', async t => {
    for (const [name, separator] of [
        ['bare CR', '\r'],
        ['CRLF', '\r\n'],
    ]) {
        await t.test(name, () => {
            const body = `First line${separator}private ${name} tail`;
            const html = getPromptSurfaceContent(snapshot({
                prompts: [{ id: `prompt-${name}`, name, text: body }],
            }));
            const preview = html.match(/<p class="prompt-preview"[^>]*>([^<]*)<\/p>/);

            assert.ok(preview);
            assert.equal(preview[1], 'First line');
            assert.ok(preview[1].length <= 160);
        });
    }
});

test('AI Prompt content renders ordered items with accessible independent actions', () => {
    const html = getPromptSurfaceContent(snapshot({
        selectedPromptId: 'prompt-b',
        prompts: [
            { id: 'prompt-a', name: 'Alpha', text: 'First body' },
            { id: 'prompt-b', name: 'Bravo', text: 'Second body' },
        ],
    }));

    assert.ok(html.indexOf('data-prompt-id="prompt-a"') < html.indexOf('data-prompt-id="prompt-b"'));
    assert.equal((html.match(/data-drag-prompt-id=/g) || []).length, 2);
    assert.equal((html.match(/draggable="true"/g) || []).length, 2);
    assert.equal((html.match(/data-action="prompt-insert-terminal"/g) || []).length, 2);
    assert.equal((html.match(/data-action="prompt-copy"/g) || []).length, 2);
    assert.equal((html.match(/class="prompt-management-actions"/g) || []).length, 2);
    assert.match(
        html,
        /<div class="prompt-management-actions">\s*<button[^>]*data-action="prompt-insert-terminal"[\s\S]*?data-action="prompt-copy"[\s\S]*?data-action="prompt-select-default"[\s\S]*?data-action="prompt-edit"[\s\S]*?data-action="prompt-delete"/
    );
    assert.doesNotMatch(html, /<li[^>]*draggable="true"/);
    assert.match(html, /<li[^>]*data-prompt-id="prompt-b"[^>]*data-prompt-default="true"/);
    assert.doesNotMatch(html, /<li[^>]*data-prompt-id="prompt-a"[^>]*data-prompt-default/);
    assert.match(html, /class="prompt-default-marker"[^>]*aria-hidden="true"/);
    assert.match(html, /data-action="prompt-insert-terminal" data-prompt-id="prompt-a"[^>]*title="Insert Alpha into the active terminal"[^>]*aria-label="Insert Alpha into the active terminal"/);
    assert.match(html, /data-action="prompt-copy" data-prompt-id="prompt-a"[^>]*title="Copy Alpha"[^>]*aria-label="Copy Alpha"/);
    assert.match(html, /data-action="prompt-select-default" data-prompt-id="prompt-a"[^>]*aria-pressed="false"/);
    assert.match(html, /data-action="prompt-select-default" data-prompt-id="prompt-b"[^>]*aria-pressed="true"/);
    assert.match(html, /aria-label="Make Alpha the default Prompt"/);
    assert.match(html, /aria-label="Clear Bravo as the default Prompt"/);
    assert.match(html, /data-action="prompt-edit" data-prompt-id="prompt-a"[^>]*aria-label="Edit Alpha"/);
    assert.match(html, /data-action="prompt-delete" data-prompt-id="prompt-a"[^>]*aria-label="Delete Alpha"/);
    assert.match(html, /data-drag-prompt-id="prompt-a"[^>]*aria-label="Drag Alpha to reorder"/);
    assert.doesNotMatch(html, />Make default<|>Default<|>Edit<|>Delete</);
    assert.match(html, /<form[^>]*data-prompt-form="edit"[^>]*data-prompt-id="prompt-a"[^>]* hidden>/);
    assert.match(html, /<label[^>]*for="prompt-edit-name-0"[^>]*>Prompt name<\/label>/);
    assert.match(html, /<label[^>]*for="prompt-edit-text-0"[^>]*>Prompt text<\/label>/);
});

test('AI Prompt content renders invalid and future data as distinct read-only states', () => {
    const invalid = getPromptSurfaceContent(snapshot({ readOnlyReason: 'invalid-data' }));
    const future = getPromptSurfaceContent(snapshot({ readOnlyReason: 'unsupported-version' }));

    for (const html of [invalid, future]) {
        assert.match(html, /data-prompt-read-only="true"/);
        assert.match(html, /role="alert"/);
        assert.match(html, /data-action="prompt-new"[^>]* disabled/);
        assert.doesNotMatch(html, /data-prompt-form="create"/);
    }
    assert.match(invalid, /saved Prompt data is invalid/i);
    assert.match(future, /newer version of Project Steward/i);
});

test('AI Prompt content keeps Prompt bodies out of Coming Soon panels', () => {
    const body = 'private body marker 7e670530';
    const html = getAiPanelContent(snapshot({
        prompts: [{ id: 'prompt-a', name: 'Private', text: body }],
    }));

    assert.match(html, new RegExp(body));
    for (const panel of ['skills', 'mcp', 'hooks']) {
        const match = html.match(new RegExp(
            `<section[^>]*id="ai-panel-${panel}"[\\s\\S]*?<\\/section>`
        ));
        assert.ok(match);
        assert.match(match[0], /Coming Soon/);
        assert.doesNotMatch(match[0], new RegExp(body));
        assert.doesNotMatch(match[0], /data-prompt-/);
    }
});
