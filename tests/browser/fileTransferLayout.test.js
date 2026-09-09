'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const { getFileTransferContent } = require('../../out/webview/webviewFileTransferContent');
const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const dashboardScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewDashboardScripts.js'), 'utf8'
);
const dashboardBundle = fs.readFileSync(
    path.join(__dirname, '../../media/webviewDashboardBundle.js'), 'utf8'
);

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

function snapshot() {
    return {
        revisionId: 'revision:abc', lifecycle: 'active', machineConflictCandidates: {},
        catalog: {
            machines: [
                { id: 'machine:build', name: 'Build Machine', connection: { kind: 'ssh', host: 'build', user: 'dev', port: 22 } },
                { id: 'machine:deploy', name: 'Deploy Machine', connection: { kind: 'ssh', host: 'deploy', user: 'dev', port: 22 } },
            ],
            environments: [], projects: [],
            layout: { machineIds: [], environmentIdsByMachine: {}, projectIdsByEnvironment: {}, favoriteProjectIds: [] },
            conflicts: [],
        },
    };
}

async function openPage(t, width) {
    const page = await browser.newPage({ viewport: { width, height: 720 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><style>
        :root { --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-panel-border: #555; --vscode-editor-background: #1e1e1e; --vscode-sideBarSectionHeader-background: #252525; --vscode-input-border: #555; --vscode-input-foreground: #ddd; --vscode-input-background: #333; --vscode-button-foreground: #fff; --vscode-button-background: #0e639c; }
        body { margin: 0; padding: 10px; background: #1e1e1e; }
        ${styles}
    </style><main>${getFileTransferContent(snapshot())}</main>`);
    await page.evaluate(() => {
        document.querySelectorAll('[data-file-transfer-file-list]').forEach(list => {
            list.hidden = false;
            list.innerHTML = '<li class="file-transfer-file-row"><label><input type="checkbox">File  report-with-a-long-name.txt<span class="file-transfer-file-meta">1.0 MB · Today</span></label></li>';
        });
        document.querySelectorAll('[data-file-transfer-pane-toolbar] input, [data-file-transfer-pane-toolbar] select')
            .forEach(control => { control.disabled = false; });
    });
    return page;
}

test('FILE-TRANSFER-EDITOR-001 FILE-TRANSFER-UI-011 keeps sorting controls readable and keeps the direct transfer action compact', async t => {
    for (const width of [480, 280]) {
        const page = await openPage(t, width);
        const metrics = await page.evaluate(() => {
            const panel = document.querySelector('.file-transfer');
            const toolbars = Array.from(document.querySelectorAll('[data-file-transfer-pane-toolbar]'));
            return {
                panelScrollWidth: panel.scrollWidth,
                panelClientWidth: panel.clientWidth,
                transferControl: (() => {
                    const button = document.querySelector('[data-file-transfer-start-copy]');
                    const icon = button && button.querySelector('svg');
                    const buttonRect = button && button.getBoundingClientRect();
                    const iconRect = icon && icon.getBoundingClientRect();
                    return {
                        height: buttonRect && buttonRect.height,
                        iconWidth: iconRect && iconRect.width,
                        iconHeight: iconRect && iconRect.height,
                    };
                })(),
                toolbarWidths: toolbars.map(toolbar => ({
                    scrollWidth: toolbar.scrollWidth,
                    clientWidth: toolbar.clientWidth,
                    height: toolbar.getBoundingClientRect().height,
                })),
            };
        });
        assert.ok(metrics.panelScrollWidth <= metrics.panelClientWidth,
            `width ${width}: File Transfer panel has horizontal overflow`);
        for (const toolbar of metrics.toolbarWidths) {
            assert.ok(toolbar.scrollWidth <= toolbar.clientWidth,
                `width ${width}: File Transfer toolbar has horizontal overflow`);
            assert.ok(toolbar.height >= 24,
                `width ${width}: File Transfer toolbar controls are clipped`);
        }
        assert.ok(metrics.transferControl.height <= 40,
            `width ${width}: Transfer button must stay compact`);
        assert.equal(await page.locator('[data-file-transfer-review-sheet]').count(), 0,
            `width ${width}: File Transfer must not reserve a Review dialog`);
    }
});

test('FILE-TRANSFER-UI-024 keeps the endpoint bar and location headers dense without truncated breadcrumb controls', async t => {
    const page = await openPage(t, 1600);
    await page.evaluate(() => {
        document.querySelectorAll('[data-file-transfer-pane-name]').forEach((name, index) => {
            name.textContent = index === 0 ? 'home-book' : 'reddev';
        });
        document.querySelectorAll('[data-file-transfer-pane-path]').forEach(path => {
            path.innerHTML = '<button class="file-transfer-breadcrumb">hzcheng</button>'
                + '<span class="file-transfer-breadcrumb-separator">/</span>'
                + '<span class="file-transfer-breadcrumb-current">Downloads</span>';
        });
        document.querySelectorAll('[data-file-transfer-path-input]').forEach((input, index) => {
            input.disabled = false;
            input.value = index === 0 ? '/home/hzcheng/Downloads' : '/home/deploy';
        });
        document.querySelectorAll('[data-file-transfer-endpoint]').forEach((selector, index) => {
            selector.value = index === 0 ? 'managed:machine:build' : 'managed:machine:deploy';
        });
    });
    const metrics = await page.evaluate(() => ({
        workspaceHeaderHeight: document.querySelector('.file-transfer-workspace-header').getBoundingClientRect().height,
        paneHeaderHeights: Array.from(document.querySelectorAll('.file-transfer-pane-header'))
            .map(header => header.getBoundingClientRect().height),
        breadcrumbCount: document.querySelectorAll('[data-file-transfer-pane-path]').length,
        pathInputWidths: Array.from(document.querySelectorAll('[data-file-transfer-path-input]'))
            .map(input => input.getBoundingClientRect().width),
        paneWidths: Array.from(document.querySelectorAll('.file-transfer-pane'))
            .map(pane => pane.getBoundingClientRect().width),
    }));
    assert.ok(metrics.workspaceHeaderHeight <= 42,
        'the endpoint selectors must occupy one compact row');
    assert.ok(metrics.paneHeaderHeights.every(height => height <= 56),
        'each pane header must keep the endpoint and current location on one compact row');
    assert.equal(metrics.breadcrumbCount, 0,
        'the redundant history breadcrumb must not collapse into an unexplained H… control');
    metrics.pathInputWidths.forEach((width, index) => {
        assert.ok(width >= metrics.paneWidths[index] * .58,
            'the explicit Location field must retain enough width to identify the current directory');
    });
    const narrowPage = await openPage(t, 280);
    await narrowPage.evaluate(() => {
        document.querySelectorAll('[data-file-transfer-path-input]').forEach(input => {
            input.disabled = false;
            input.value = '/home/hzcheng/Downloads';
        });
    });
    const narrowMetrics = await narrowPage.evaluate(() => Array.from(document.querySelectorAll('.file-transfer-pane-header'))
        .map(header => {
            const location = header.querySelector('.file-transfer-path-input');
            const input = location.querySelector('input');
            return {
                header: header.getBoundingClientRect(),
                location: location.getBoundingClientRect(),
                input: input.getBoundingClientRect(),
            };
        }));
    narrowMetrics.forEach(metrics => {
        assert.ok(metrics.location.top > metrics.header.top,
            'on a narrow editor, Location must use its own row instead of collapsing into the endpoint title');
        assert.ok(metrics.input.width >= metrics.header.width * .65,
            'on a narrow editor, the Location input must remain readable');
    });
});

test('FILE-TRANSFER-EDITOR-001 opens a directory with one click while preserving its copy checkbox', async t => {
    const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
    t.after(() => page.close());
    await page.setContent('<!doctype html><ul data-file-transfer-file-list></ul>');
    await page.addScriptTag({ content: dashboardScript });
    await page.evaluate(() => {
        window.__fileTransferOpenedDirectories = [];
        renderLocalFileTransferEntries(
            document.querySelector('[data-file-transfer-file-list]'),
            [{ id: '0123456789abcdef0123456789abcdef', name: 'worktree', kind: 'directory' }],
            new Set(['0123456789abcdef0123456789abcdef']),
            () => {},
            directoryId => window.__fileTransferOpenedDirectories.push(directoryId),
            () => {},
            () => {},
        );
    });
    await page.locator('[data-file-transfer-entry-id] [data-file-transfer-directory-name]').click();
    assert.deepEqual(await page.evaluate(() => window.__fileTransferOpenedDirectories),
        ['0123456789abcdef0123456789abcdef']);
    assert.equal(await page.locator('[data-file-transfer-entry-id]').evaluate(row => row.classList.contains('is-selected')), true,
        'the selected source item needs a row-level selection treatment, not a checkbox-only state');
    assert.equal(await page.locator('.file-transfer-tree-spacer').textContent(), '›',
        'a folder row needs a compact navigation cue beside its selectable name');

    await page.locator('[data-file-transfer-entry-id] input').click();
    assert.deepEqual(await page.evaluate(() => window.__fileTransferOpenedDirectories),
        ['0123456789abcdef0123456789abcdef']);
});

test('FILE-TRANSFER-UI-017 enters one directory at a time, updates Path, and exposes a .. row to return', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    const initialRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: initialRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/workspace', entries: [
                { id: '11111111111111111111111111111111', name: 'src', kind: 'directory' },
                { id: '22222222222222222222222222222222', name: 'README.md', kind: 'file', size: 12 },
            ],
        },
    });
    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] [data-file-transfer-directory-name]').click();
    const openRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-open-directory'
            && message.endpoint && message.endpoint.directoryId === '11111111111111111111111111111111'
    ));
    assert.ok(openRequest, 'opening a folder must request that folder as the new current directory');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: openRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: '11111111111111111111111111111111', label: 'Build Machine',
            displayPath: '/workspace/src', entries: [
                { id: '33333333333333333333333333333333', name: 'index.ts', kind: 'file', size: 21 },
            ],
        },
    });

    assert.equal(await endpoint.inputValue(), 'managed:machine:build');
    assert.equal(await page.locator('[data-file-transfer-path-input="left"]').inputValue(), '/workspace/src');
    assert.equal(await page.locator('[data-file-transfer-entry-id="22222222222222222222222222222222"]').count(), 0,
        'the previous directory contents must not remain visible after entering a folder');
    assert.equal(await page.locator('[data-file-transfer-entry-id="33333333333333333333333333333333"]').count(), 1,
        'the list must show only entries from the current directory');
    const parent = page.locator('.file-transfer-directory-name[data-file-transfer-parent-directory="left"]');
    assert.equal(await parent.textContent(), '..');
    await parent.click();
    const parentRequest = await page.evaluate(() => window.__fileTransferMessages.filter(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'left'
    ).at(-1));
    assert.equal(parentRequest.path, '/workspace', 'the .. row must resolve the filesystem parent path');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: parentRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/workspace', entries: [
                { id: '11111111111111111111111111111111', name: 'src', kind: 'directory' },
                { id: '22222222222222222222222222222222', name: 'README.md', kind: 'file', size: 12 },
            ],
        },
    });
    assert.equal(await page.locator('[data-file-transfer-path-input="left"]').inputValue(), '/workspace');
    assert.equal(await parent.count(), 1, 'the restored directory keeps its filesystem parent row');
    const alignedNames = await page.evaluate(() => {
        const parentName = document.querySelector('.file-transfer-parent-directory.file-transfer-directory-name');
        const folderName = document.querySelector('[data-file-transfer-entry-id="11111111111111111111111111111111"] .file-transfer-directory-name');
        const fileName = document.querySelector('[data-file-transfer-entry-id="22222222222222222222222222222222"] .file-transfer-file-name');
        return {
            parent: parentName.getBoundingClientRect().left,
            folder: folderName.getBoundingClientRect().left,
            file: fileName.getBoundingClientRect().left,
        };
    });
    assert.deepEqual(alignedNames, {
        parent: alignedNames.folder,
        folder: alignedNames.folder,
        file: alignedNames.folder,
    }, 'the .. label must align with ordinary file and folder names, not with their selection controls');
    assert.equal(await page.locator('[data-file-transfer-pane-copy-state]').first().isVisible(), false,
        'the copy-source indicator must stay out of the layout until a file is selected');
});

test('FILE-TRANSFER-LOCAL-DISPLAY-001 displays This Computer home in Location while navigating with root-relative handles', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('local');
    const initialRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-select-local-root' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-local-root-selected', version: 1,
        requestId: initialRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'hzcheng',
            displayPath: '/home/hzcheng', entries: [
                { id: '11111111111111111111111111111111', name: 'Downloads', kind: 'directory' },
            ],
        },
    });
    assert.equal(await page.locator('[data-file-transfer-path-input="left"]').inputValue(), '/home/hzcheng');
    assert.equal(await page.locator('[data-file-transfer-parent-directory="left"]').count(), 0,
        'the approved home root must not offer a .. row outside its local scope');

    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] [data-file-transfer-directory-name]').click();
    const childRequest = await page.evaluate(() => window.__fileTransferMessages.filter(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'left'
    ).at(-1));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-local-root-selected', version: 1,
        requestId: childRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: '11111111111111111111111111111111', label: 'hzcheng',
            displayPath: '/home/hzcheng/Downloads', entries: [],
        },
    });
    assert.equal(await page.locator('[data-file-transfer-path-input="left"]').inputValue(), '/home/hzcheng/Downloads');
    await page.locator('button[data-file-transfer-parent-directory="left"]').click();
    const parentRequest = await page.evaluate(() => window.__fileTransferMessages.filter(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'left'
    ).at(-1));
    assert.equal(parentRequest.path, '.', 'the displayed absolute home path must be converted before it leaves the Webview');
});

test('FILE-TRANSFER-UI-017 exposes .. for the filesystem parent of an initial directory', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'], postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    const initialRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: initialRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/workspace', entries: [],
        },
    });
    const parent = page.locator('.file-transfer-directory-name[data-file-transfer-parent-directory="left"]');
    assert.equal(await parent.count(), 1,
        'an initial non-root directory must offer its filesystem parent, not only an in-session history entry');
    await parent.click();
    const parentRequest = await page.evaluate(() => window.__fileTransferMessages.filter(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'left'
    ).at(-1));
    assert.equal(parentRequest.path, '/', 'the initial .. row must navigate to the actual parent path');
});

test('FILE-TRANSFER-UI-017 keeps the current directory visible when opening a child fails', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'], postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    const initialRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: initialRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/workspace', entries: [
                { id: '11111111111111111111111111111111', name: 'private', kind: 'directory' },
            ],
        },
    });
    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] [data-file-transfer-directory-name]').click();
    const failedRequest = await page.evaluate(() => window.__fileTransferMessages.filter(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'left'
    ).at(-1));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-failed', version: 1,
        requestId: failedRequest.requestId, side: 'left', message: 'Permission denied.',
    });
    assert.equal(await page.locator('[data-file-transfer-path-input="left"]').inputValue(), '/workspace');
    assert.equal(await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"]').count(), 1,
        'a failed navigation must leave the last usable directory available for another choice');
});

test('FILE-TRANSFER-UI-017 resets the list scroll position when the current directory changes', async t => {
    const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
    t.after(() => page.close());
    await page.setContent('<!doctype html><style>ul { display:block; height:80px; overflow:auto; } li { height:20px; }</style><ul data-file-transfer-file-list></ul>');
    await page.addScriptTag({ content: dashboardScript });
    await page.evaluate(() => {
        const list = document.querySelector('[data-file-transfer-file-list]');
        const entries = Array.from({ length: 60 }, (_unused, index) => ({
            id: String(index).padStart(16, '0'), name: 'file-' + index, kind: 'file',
        }));
        renderLocalFileTransferEntries(list, entries, new Set(), () => {}, () => {}, null, null, false, 'directory:one');
        list.scrollTop = 400;
        renderLocalFileTransferEntries(list, entries, new Set(), () => {}, () => {}, null, null, false, 'directory:two');
    });
    assert.equal(await page.locator('[data-file-transfer-file-list]').evaluate(list => list.scrollTop), 0,
        'a newly opened directory must start at its first row, including .. when it is present');
});

test('FILE-TRANSFER-UI-022 offers each endpoint visited paths in a native dropdown while preserving direct path navigation', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    const initialRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: initialRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/home/hzcheng', entries: [],
        },
    });
    const input = page.locator('[data-file-transfer-path-input="left"]');
    assert.equal(await input.getAttribute('list'), 'file-transfer-path-options-left');
    const option = page.locator('#file-transfer-path-options-left option[value="/home/hzcheng"]');
    assert.equal(await option.count(), 1, 'the authenticated home must be selectable from the path dropdown');
    await page.evaluate(() => {
        const input = document.querySelector('[data-file-transfer-path-input="left"]');
        const option = document.querySelector('#file-transfer-path-options-left option');
        input.value = option.value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    assert.ok(await page.evaluate(() => window.__fileTransferMessages.some(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'left' && message.path === '/home/hzcheng'
    )), 'choosing a path suggestion must use the same validated navigation request as typed paths');
});

test('FILE-TRANSFER-UI-018 hides path-like hidden entries until Show hidden is selected, opens from an explicit folder-name control, and keeps endpoint controls visible while browsing', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><style>
        :root { --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-panel-border: #555; --vscode-editor-background: #1e1e1e; --vscode-sideBarSectionHeader-background: #252525; --vscode-input-border: #555; --vscode-input-foreground: #ddd; --vscode-input-background: #333; --vscode-button-foreground: #fff; --vscode-button-background: #0e639c; }
        body { margin: 0; padding: 10px; background: #1e1e1e; }
        ${styles}
    </style><body class="file-transfer-editor"><main class="dashboard-content file-transfer-editor-content">
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel file-transfer-editor-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </main></body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });

    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    const initialRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: initialRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/workspace', entries: [
                { id: '11111111111111111111111111111111', name: '/home/hzcheng/.config', kind: 'directory' },
            ],
        },
    });

    const folderName = page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] [data-file-transfer-directory-name]');
    assert.equal(await folderName.count(), 0,
        'an absolute SFTP entry whose final name starts with a dot must stay hidden by default');
    await page.locator('[data-file-transfer-show-hidden="left"]').check();
    assert.equal(await folderName.count(), 1,
        'Show hidden must reveal the same absolute-path entry without reloading the endpoint');
    assert.equal(await folderName.textContent(), '.config',
        'the directory list must show a folder label, not a redundant type and absolute path');
    await folderName.click();
    const expandRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-open-directory'
            && message.endpoint && message.endpoint.directoryId === '11111111111111111111111111111111'
    ));
    assert.ok(expandRequest, 'clicking a folder name must open it; a tiny disclosure is not an adequate hit target');

    await page.evaluate(() => {
        document.querySelectorAll('[data-file-transfer-file-list]').forEach(list => {
            list.hidden = false;
            list.innerHTML = Array.from({ length: 160 }, (_unused, index) =>
                '<li class="file-transfer-file-row">File ' + index + '</li>'
            ).join('');
        });
        document.querySelector('[data-file-transfer-file-list]').scrollTop = 260;
    });
    const endpointControls = await page.locator('.file-transfer-pair').evaluate(element => {
        const rect = element.getBoundingClientRect();
        const sourceTree = document.querySelector('[data-file-transfer-file-list]');
        return {
            top: rect.top,
            bottom: rect.bottom,
            viewportHeight: window.innerHeight,
            sourceTreeScrollTop: sourceTree.scrollTop,
        };
    });
    assert.ok(endpointControls.top >= 0 && endpointControls.bottom <= endpointControls.viewportHeight,
        'endpoint controls must remain visible while a long directory is scrolled');
    assert.ok(endpointControls.sourceTreeScrollTop > 0,
        'browsing a long directory must scroll the directory list rather than the File Transfer page');
});

test('FILE-TRANSFER-UI-021 keeps endpoint controls and the transfer action fixed while each directory list scrolls independently', async t => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><style>
        :root { --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-panel-border: #555; --vscode-editor-background: #1e1e1e; --vscode-sideBarSectionHeader-background: #252525; --vscode-input-border: #555; --vscode-input-foreground: #ddd; --vscode-input-background: #333; --vscode-button-foreground: #fff; --vscode-button-background: #0e639c; }
        ${styles}
    </style><body class="file-transfer-editor"><main class="dashboard-content file-transfer-editor-content"><section class="file-transfer-editor-panel">${getFileTransferContent(snapshot())}</section></main></body>`);
    await page.evaluate(() => {
        document.querySelectorAll('[data-file-transfer-file-list]').forEach((list, side) => {
            list.hidden = false;
            list.innerHTML = Array.from({ length: 180 }, (_unused, index) =>
                '<li class="file-transfer-file-row">' + (side ? 'Target' : 'Source') + ' file ' + index + '</li>'
            ).join('');
        });
    });

    const metrics = await page.evaluate(() => {
        const lists = Array.from(document.querySelectorAll('[data-file-transfer-file-list]'));
        const endpointPair = document.querySelector('.file-transfer-pair');
        const actionBar = document.querySelector('[data-file-transfer-action-bar]');
        const initialPairTop = endpointPair.getBoundingClientRect().top;
        const initialActionBottom = actionBar.getBoundingClientRect().bottom;
        lists[0].scrollTop = 320;
        return {
            documentScrolls: document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight,
            listOverflowY: lists.map(list => getComputedStyle(list).overflowY),
            listCanScroll: lists.map(list => list.scrollHeight > list.clientHeight),
            leftScrollTop: lists[0].scrollTop,
            rightScrollTop: lists[1].scrollTop,
            endpointPairStayedPut: endpointPair.getBoundingClientRect().top === initialPairTop,
            actionBarStayedPut: actionBar.getBoundingClientRect().bottom === initialActionBottom,
        };
    });

    assert.equal(metrics.documentScrolls, false,
        'the File Transfer page must not scroll as a whole');
    assert.deepEqual(metrics.listOverflowY, ['auto', 'auto'],
        'both directory lists must own their vertical scrollbars');
    assert.deepEqual(metrics.listCanScroll, [true, true],
        'both panes must give their directory lists bounded, scrollable space');
    assert.ok(metrics.leftScrollTop > 0,
        'the source directory list must scroll');
    assert.equal(metrics.rightScrollTop, 0,
        'scrolling the source tree must not move the target tree');
    assert.equal(metrics.endpointPairStayedPut, true,
        'endpoint controls must remain fixed while browsing a tree');
    assert.equal(metrics.actionBarStayedPut, true,
        'the transfer action must remain fixed while browsing a tree');
});

test('FILE-TRANSFER-UI-019 FILE-TRANSFER-UI-023 keeps the direct transfer action available and preflights it before queueing', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });

    const leftEndpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await leftEndpoint.selectOption('managed:machine:build');
    const leftRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: leftRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210', label: 'Build Machine',
            displayPath: '/workspace', entries: [
                { id: '11111111111111111111111111111111', name: 'report.txt', kind: 'file', size: 12 },
            ],
        },
    });
    const rightEndpoint = page.locator('[data-file-transfer-endpoint="right"]');
    await rightEndpoint.selectOption('managed:machine:deploy');
    const rightRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'right'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: rightRequest.requestId, side: 'right',
        root: {
            rootId: 'abcdef0123456789abcdef0123456789',
            directoryId: '1234567890abcdef1234567890abcdef', label: 'Deploy Machine',
            displayPath: '/incoming', entries: [],
        },
    });

    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] input').check();
    const startCopy = page.locator('[data-file-transfer-start-copy]');
    assert.equal(await startCopy.isEnabled(), true,
        'a ready source, target, and selection must always expose the direct transfer action');
    await startCopy.click();
    const preflightRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-preflight-copy'
    ));
    assert.deepEqual(preflightRequest.entryIds, ['11111111111111111111111111111111']);
    assert.equal(preflightRequest.source.machineId, 'machine:build');
    assert.equal(preflightRequest.destination.machineId, 'machine:deploy');
    assert.equal(await page.locator('[data-file-transfer-task-status]').textContent(), 'Checking selected items…');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-preflighted', version: 1, requestId: preflightRequest.requestId,
        result: { totalItems: 1, knownBytes: 12, unknownSizeItems: 0, existingFileNames: [], existingDirectoryNames: [] },
    });
    const copyRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-copy'
    ));
    assert.deepEqual(copyRequest.entryIds, ['11111111111111111111111111111111']);
    assert.equal(copyRequest.source.machineId, 'machine:build');
    assert.equal(copyRequest.destination.machineId, 'machine:deploy');
});

test('FILE-TRANSFER-UI-008 renders a queued task and exposes its cancellation control in the compact workspace', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const left = page.locator('[data-file-transfer-endpoint="left"]');
    await left.selectOption('managed:machine:build');
    const leftRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1, requestId: leftRequest.requestId, side: 'left',
        root: { rootId: '0123456789abcdef0123456789abcdef', directoryId: 'fedcba9876543210fedcba9876543210',
            label: 'Build Machine', displayPath: '/workspace',
            entries: [{ id: '11111111111111111111111111111111', name: 'report.txt', kind: 'file', size: 12 }] },
    });
    const right = page.locator('[data-file-transfer-endpoint="right"]');
    await right.selectOption('managed:machine:deploy');
    const rightRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'right'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1, requestId: rightRequest.requestId, side: 'right',
        root: { rootId: 'abcdef0123456789abcdef0123456789', directoryId: '1234567890abcdef1234567890abcdef',
            label: 'Deploy Machine', displayPath: '/incoming', entries: [] },
    });
    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] input').check();
    await page.locator('[data-file-transfer-start-copy]').click();
    const preflight = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-preflight-copy'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-preflighted', version: 1, requestId: preflight.requestId,
        result: { totalItems: 1, knownBytes: 12, unknownSizeItems: 0, existingFileNames: [], existingDirectoryNames: [] },
    });
    const copy = await page.evaluate(() => window.__fileTransferMessages.find(message => message.type === 'file-transfer-copy'));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-queued', version: 1, requestId: copy.requestId, position: 1,
    });
    const task = page.locator('[data-file-transfer-task-list]');
    assert.equal(await task.getByRole('button', { name: 'Cancel' }).count(), 1,
        'a queued transfer must remain visible and cancellable in the compact workspace');
});

test('FILE-TRANSFER-UI-006 refreshes endpoint choices while preserving a still-valid machine selection', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'], postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const source = page.locator('[data-file-transfer-endpoint="left"]');
    await source.selectOption('managed:machine:build');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'file-transfer-endpoint-catalog', version: 1, revisionId: 'revision-2',
        machines: [
            { id: 'machine:build', name: 'Renamed Build' },
            { id: 'machine:new', name: 'New Machine' },
        ],
    } })));
    assert.equal(await source.inputValue(), 'managed:machine:build',
        'a still-valid endpoint must not be reset during a catalog refresh');
    assert.equal(await source.locator('option[value="managed:machine:new"]').count(), 1,
        'newly available machines must appear without reopening File Transfer');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'file-transfer-endpoint-catalog', version: 1, revisionId: 'revision-3',
        machines: [
            { id: 'machine:build', name: 'Renamed Build' },
            { id: 'machine:new', name: 'New Machine' },
        ],
    } })));
    assert.equal(await page.evaluate(() => window.__fileTransferMessages.filter(message =>
        message.type === 'file-transfer-list-remote-directory' && message.machineId === 'machine:build'
    ).length), 3, 'a retained Managed Machine must be re-listed after its opaque handles become stale');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'file-transfer-endpoint-catalog', version: 1, revisionId: 'revision-4',
        machines: [{ id: 'machine:new', name: 'New Machine' }],
    } })));
    assert.equal(await source.inputValue(), '',
        'a removed endpoint must clear its stale ready state instead of remaining actionable');
});

test('FILE-TRANSFER-UI-020 FILE-TRANSFER-OBSERVABILITY-001 FILE-TRANSFER-STREAMING-001 makes the source, target, and direct transfer action explicit while showing live two-hop relay telemetry', async t => {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });

    const source = page.locator('[data-file-transfer-endpoint="left"]');
    await source.selectOption('managed:machine:build');
    const sourceRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'left'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1, requestId: sourceRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef', directoryId: 'fedcba9876543210fedcba9876543210',
            label: 'Build Machine', displayPath: '/workspace',
            entries: [{ id: '11111111111111111111111111111111', name: 'report.txt', kind: 'file', size: 12 }],
        },
    });
    const target = page.locator('[data-file-transfer-endpoint="right"]');
    await target.selectOption('managed:machine:deploy');
    const targetRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory' && message.side === 'right'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1, requestId: targetRequest.requestId, side: 'right',
        root: {
            rootId: 'abcdef0123456789abcdef0123456789', directoryId: '1234567890abcdef1234567890abcdef',
            label: 'Deploy Machine', displayPath: '/incoming',
            entries: [{ id: '22222222222222222222222222222222', name: 'destination', kind: 'directory' }],
        },
    });

    assert.match(await page.locator('[data-file-transfer-pane="left"] [data-file-transfer-pane-role]').textContent(), /Source/i);
    assert.match(await page.locator('[data-file-transfer-pane="right"] [data-file-transfer-pane-role]').textContent(), /Target folder/i);
    assert.equal(await page.locator('[data-file-transfer-pane="right"] [data-file-transfer-file-list] input[type="checkbox"]').count(), 0,
        'the target pane is a destination folder picker, not a second copy-source picker');
    await page.locator('[data-file-transfer-entry-id="22222222222222222222222222222222"] [data-file-transfer-directory-name]').click();
    const targetNavigation = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'right'
    ));
    assert.ok(targetNavigation, 'opening a Target folder must select that destination directory');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1, requestId: targetNavigation.requestId, side: 'right',
        root: {
            rootId: 'abcdef0123456789abcdef0123456789', directoryId: '22222222222222222222222222222222',
            label: 'Deploy Machine', displayPath: '/incoming/destination', entries: [],
        },
    });

    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] input').check();
    const transfer = page.locator('[data-file-transfer-start-copy]');
    assert.equal(await transfer.isEnabled(), true);
    assert.match(await transfer.textContent(), /Transfer 1 item/i);
    assert.match(await page.locator('[data-file-transfer-summary]').textContent(),
        /Build Machine.*\/workspace.*Deploy Machine.*\/incoming\/destination/i);
    await transfer.click();
    const preflightRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-preflight-copy'
    ));
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-preflighted', version: 1, requestId: preflightRequest.requestId,
        result: { totalItems: 1, knownBytes: 12, unknownSizeItems: 0, existingFileNames: [], existingDirectoryNames: [] },
    });
    const copyRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-copy'
    ));
    assert.deepEqual(copyRequest.entryIds, ['11111111111111111111111111111111']);
    assert.equal(copyRequest.source.machineId, 'machine:build');
    assert.equal(copyRequest.destination.machineId, 'machine:deploy');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-queued', version: 1, requestId: copyRequest.requestId, position: 1,
    });
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-started', version: 1, requestId: copyRequest.requestId,
    });
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-progress', version: 1, requestId: copyRequest.requestId,
        progress: { status: 'running', phase: 'downloading', completedItems: 0, skippedItems: 0, totalItems: 1, currentItemName: 'report.txt' },
    });
    assert.match(await page.locator('[data-file-transfer-task-status]').textContent(),
        /Downloading from source.*report\.txt/i,
        'the user must see the real relay stage, not a generic copying status');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-progress', version: 1, requestId: copyRequest.requestId,
        progress: {
            status: 'running', phase: 'uploading', hop: 'relay-to-target',
            completedItems: 0, skippedItems: 0, totalItems: 1, currentItemName: 'report.txt',
            transferredBytes: 536870912, totalBytes: 1073741824, bytesPerSecond: 44040192,
        },
    });
    assert.match(await page.locator('[data-file-transfer-task-status]').textContent(),
        /Uploading from relay to target.*Relay → target.*512 MiB \/ 1 GiB.*42 MiB\/s.*report\.txt/i,
        'the active transfer must expose the current relay hop, byte progress, and instantaneous speed');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-progress', version: 1, requestId: copyRequest.requestId,
        progress: {
            status: 'running', phase: 'uploading', hop: 'source-to-target',
            completedItems: 0, skippedItems: 0, totalItems: 1, currentItemName: 'report.txt',
            transferredBytes: 536870912, totalBytes: 1073741824, bytesPerSecond: 44040192,
        },
    });
    assert.match(await page.locator('[data-file-transfer-task-status]').textContent(),
        /Streaming through relay.*Source → target.*512 MiB \/ 1 GiB.*42 MiB\/s.*report\.txt/i,
        'a live relay must say that its source and target hops are streaming concurrently');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-copy-settled', version: 1, requestId: copyRequest.requestId, status: 'copied',
        value: { status: 'copied', completedItems: 1, skippedItems: 0, totalItems: 1 },
    });
    assert.ok(await page.evaluate(() => window.__fileTransferMessages.some(message =>
        message.type === 'file-transfer-open-directory' && message.side === 'right'
            && message.endpoint && message.endpoint.directoryId === '22222222222222222222222222222222'
    )), 'a successful transfer must refresh and reveal its target directory automatically');
    assert.equal(await page.locator('[data-file-transfer-review-sheet]').count(), 0,
        'the primary transfer path must not be blocked by a secondary Review dialog');
});

test('FILE-TRANSFER-UI-006 keeps the selected Managed Machine after its directory is listed', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    const request = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-list-remote-directory'
            && message.side === 'left'
    ));
    assert.ok(request, 'selecting a Managed Machine must request its directory');
    await page.evaluate(message => {
        window.dispatchEvent(new MessageEvent('message', { data: message }));
    }, {
        type: 'file-transfer-remote-directory-listed',
        version: 1,
        requestId: request.requestId,
        side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: 'fedcba9876543210fedcba9876543210',
            label: 'Build Machine',
            displayPath: '/workspace',
            entries: [],
        },
    });
    assert.equal(await endpoint.inputValue(), 'managed:machine:build');
    assert.match(await page.locator('[data-file-transfer-pane="left"] [data-file-transfer-pane-status]').textContent(),
        /0 items loaded/i);
    assert.deepEqual(await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-directory-applied'
    )), {
        type: 'file-transfer-directory-applied',
        version: 1,
        requestId: request.requestId,
        side: 'left',
    });
});

test('FILE-TRANSFER-UI-006 keeps a selected Managed Machine actionable when its directory reply is lost', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><body>
        <section id="dashboard-tab-file-transfer" class="dashboard-tab-panel">
            ${getFileTransferContent(snapshot())}
        </section>
    </body>`);
    await page.addScriptTag({ content: dashboardBundle });
    await page.evaluate(() => {
        window.__fileTransferMessages = [];
        window.__fileTransferDashboard = initDashboard({
            enabledTabs: ['file-transfer'],
            fileTransferDirectoryRequestTimeoutMs: 20,
            postMessage: message => window.__fileTransferMessages.push(message),
        });
    });
    const endpoint = page.locator('[data-file-transfer-endpoint="left"]');
    await endpoint.selectOption('managed:machine:build');
    await page.waitForTimeout(50);

    assert.equal(await endpoint.inputValue(), 'managed:machine:build');
    assert.match(await page.locator('[data-file-transfer-pane="left"] [data-file-transfer-pane-status]').textContent(),
        /did not reply.*Refresh/i);
});
