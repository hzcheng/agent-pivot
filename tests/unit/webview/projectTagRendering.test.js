'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

function loadWebviewContent() {
    const vscode = createFakeVscode({});
    vscode.Uri = { file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }) };
    const previousLoad = Module._load;
    try {
        Module._load = (request, parent, isMain) => request === 'vscode'
            ? vscode : previousLoad.call(this, request, parent, isMain);
        return require('../../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getProjectsPanelContent, getProjectSearchText } = loadWebviewContent();

function renderProjects(projects) {
    const config = {
        get: (key, defaultValue) => defaultValue,
        displayProjectPath: false,
        searchIsActiveByDefault: false,
        showAddGroupButtonTile: false,
    };
    return getProjectsPanelContent([{
        id: 'group',
        groupName: 'Work',
        collapsed: false,
        projects,
    }], { config, otherStorageHasData: false });
}

test('PROJECT-TAGS-RENDERING-001 renders normalized tag chips on tagged project cards', () => {
    const html = renderProjects([{
        id: 'tagged',
        name: 'Tagged',
        path: '/work/tagged',
        tags: [' frontend ', '#urgent', 'FRONTEND'],
    }]);

    assert.ok(html.includes('data-has-tags'), 'tagged cards must carry the styling hook');
    assert.ok(html.includes('<span class="project-tag" title="#frontend">frontend</span>'));
    assert.ok(html.includes('<span class="project-tag" title="#urgent">urgent</span>'));
    assert.equal((html.match(/class="project-tag"/g) || []).length, 2,
        'duplicate tags must render exactly once');
});

test('PROJECT-TAGS-RENDERING-001 escapes tag content and skips untagged projects', () => {
    const html = renderProjects([{
        id: 'evil',
        name: 'Evil',
        path: '/work/evil',
        tags: ['<img src=x onerror=alert(1)>', 'quote"tag'],
    }, {
        id: 'plain',
        name: 'Plain',
        path: '/work/plain',
    }]);

    assert.ok(!html.includes('<img src=x'), 'tag markup must be escaped');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    const plainCard = html.slice(html.indexOf('data-id="plain"'));
    assert.ok(!plainCard.includes('project-tags'), 'untagged cards must not render the tag row');
    assert.ok(!html.slice(html.indexOf('data-id="plain"'), html.indexOf('data-id="plain"') + 400)
        .includes('data-has-tags'));
});

test('PROJECT-TAGS-RENDERING-001 includes tags in the card search text', () => {
    const searchText = getProjectSearchText({
        name: 'API',
        description: 'Service',
        path: '/work/api',
        tags: ['Frontend', 'urgent'],
    });

    assert.ok(searchText.includes('frontend'));
    assert.ok(searchText.includes('urgent'));
});
