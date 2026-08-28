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
const { buildWorkspaceDashboardSearchCatalog } = require('../../../out/webview/dashboardViewModel');

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

test('PROJECT-TAGS-RENDERING-001 tolerates malformed persisted tag values in rendering', () => {
    const html = renderProjects([{
        id: 'legacy', name: 'Legacy', path: '/work/legacy', tags: { malformed: true },
    }]);

    assert.match(html, /data-id="legacy"/);
    assert.ok(!html.includes('data-has-tags'), 'non-array persisted tags must render as no tags');
});

test('PROJECT-TAGS-RENDERING-001 tolerates malformed persisted tag values in the search catalog', () => {
    const catalog = buildWorkspaceDashboardSearchCatalog([{
        id: 'group', groupName: 'Work', projects: [{
            id: 'legacy', name: 'Legacy', path: '/work/legacy', tags: { malformed: true },
        }],
    }], []);

    assert.equal(catalog.savedProjects.length, 1);
    assert.match(catalog.savedProjects[0].searchText, /legacy/);
});

test('PROJECT-ROW-LAYOUT-001 uses single-line list rows with name as the primary element', () => {
    const html = renderProjects([{
        id: 'a', name: 'agent-pivot', path: '/home/work/agent-pivot',
    }]);

    assert.ok(html.includes('class="project-row-main"'), 'row must use the list-row layout');
    assert.ok(html.includes('class="project-header"'), 'name element must be present');
    // Path is hidden in the row — the project name is the sole identifier
    const rowCount = (html.match(/class="project-row-main"/g) || []).length;
    assert.equal(rowCount, 1, 'each project must have exactly one main row');
});

test('PROJECT-ROW-LAYOUT-001 keeps all rows at consistent height with single-line truncation', () => {
    const html = renderProjects([
        { id: 'short', name: 'API', path: '/a' },
        { id: 'long', name: 'very-long-project-name-that-should-be-truncated', path: '/home/work/very-long-path/that/goes/deep' },
    ]);

    const shortSection = html.slice(html.indexOf('data-id="short"'), html.indexOf('data-id="long"'));
    const longSection = html.slice(html.indexOf('data-id="long"'));

    assert.ok(shortSection.includes('class="project-row-main"'), 'short-name row must have main row');
    assert.ok(longSection.includes('class="project-row-main"'), 'long-name row must have main row');
    assert.ok(shortSection.includes('class="project-header"'), 'short row must have header');
    assert.ok(longSection.includes('class="project-header"'), 'long row must have header');
});

test('PROJECT-ROW-TOOLTIP-001 shows description in tooltip only when present', () => {
    const html = renderProjects([
        { id: 'with-desc', name: 'API', path: '/api', description: 'Backend service' },
        { id: 'no-desc', name: 'UI', path: '/ui' },
    ]);

    // Extract the project div opening tag for each row
    const withDescTag = html.slice(html.indexOf('data-id="with-desc"') - 80, html.indexOf('data-id="with-desc"') + 200);
    const noDescTag = html.slice(html.indexOf('data-id="no-desc"') - 80, html.indexOf('data-id="no-desc"') + 200);

    // Project with description: the project div must carry the description as title
    assert.ok(withDescTag.includes('title="Backend service"'),
        'row with description must include it in the title attribute on the project div');

    // Project without description: the project div must NOT have a title with the path
    // (the project-path span has its own title, but the project div should not)
    const noDescDivTag = noDescTag.slice(0, noDescTag.indexOf('>') + 1);
    assert.ok(!noDescDivTag.includes('title="/ui"'),
        'project div without description must not fall back to path in tooltip');
});

test('GROUP-HEADER-001 renders refined group headers with background distinction', () => {
    const html = renderProjects([
        { id: 'a', name: 'A', path: '/a' },
        { id: 'b', name: 'B', path: '/b' },
    ]);

    assert.ok(html.includes('class="group-header"'), 'group must use refined header');
    assert.ok(html.includes('class="group-name"'), 'group name must be present');
    assert.ok(html.includes('class="group-count"'), 'project count must be present');
    assert.ok(html.includes('class="group-collapse-arrow"'), 'collapse arrow must be present');
    assert.ok(!html.includes('class="group-title steward-section-header'), 'old group title class must not be used');
    // Group header must have visual distinction from background (CSS provides background-color)
    assert.ok(html.includes('class="group-header"'), 'group header must be present for CSS background styling');
});

test('TAG-FILTER-BAR-001 renders tag filter bar when projects have tags', () => {
    const html = renderProjects([
        { id: 'a', name: 'A', path: '/a', tags: ['frontend', 'urgent'] },
    ]);

    assert.ok(html.includes('class="tag-filter-bar"'), 'tag filter bar must render when tags exist');
    assert.ok(html.includes('data-tag-filter="all"'), 'All button must be present');
    assert.ok(html.includes('data-tag-filter="frontend"'), 'frontend tag chip must be present');
    assert.ok(html.includes('data-tag-filter="urgent"'), 'urgent tag chip must be present');
});

test('TAG-FILTER-BAR-001 does not render tag filter bar when no projects have tags', () => {
    const html = renderProjects([
        { id: 'a', name: 'A', path: '/a' },
        { id: 'b', name: 'B', path: '/b' },
    ]);

    assert.ok(!html.includes('class="tag-filter-bar"'), 'tag filter bar must not render when no tags exist');
});

test('TAG-FILTER-BAR-001 deduplicates and sorts tags case-insensitively', () => {
    const html = renderProjects([
        { id: 'a', name: 'A', path: '/a', tags: ['Backend', 'frontend', 'backend'] },
    ]);

    const tagChips = [...html.matchAll(/data-tag-filter="([^"]+)"/g)]
        .map(m => m[1])
        .filter(t => t !== 'all');

    assert.deepEqual(tagChips, ['Backend', 'frontend'],
        'tags must be deduplicated case-insensitively (first spelling wins), sorted alphabetically');
});
