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

test('FILE-TRANSFER-EDITOR-001 expands a directory with one click while preserving its copy checkbox', async t => {
    const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
    t.after(() => page.close());
    await page.setContent('<!doctype html><ul data-file-transfer-file-list></ul>');
    await page.addScriptTag({ content: dashboardScript });
    await page.evaluate(() => {
        window.__fileTransferOpenedDirectories = [];
        renderLocalFileTransferEntries(
            document.querySelector('[data-file-transfer-file-list]'),
            [{ id: '0123456789abcdef0123456789abcdef', name: 'worktree', kind: 'directory' }],
            new Set(),
            () => {},
            directoryId => window.__fileTransferOpenedDirectories.push(directoryId),
            () => {},
            () => {},
        );
    });
    await page.locator('[data-file-transfer-entry-id] .file-transfer-tree-toggle').click();
    assert.deepEqual(await page.evaluate(() => window.__fileTransferOpenedDirectories),
        ['0123456789abcdef0123456789abcdef']);

    await page.locator('[data-file-transfer-entry-id] input').click();
    assert.deepEqual(await page.evaluate(() => window.__fileTransferOpenedDirectories),
        ['0123456789abcdef0123456789abcdef']);
});

test('FILE-TRANSFER-UI-017 expands a folder inline without replacing its endpoint tree', async t => {
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
    await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"] .file-transfer-tree-toggle').click();
    const expandRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-open-directory'
            && message.endpoint && message.endpoint.directoryId === '11111111111111111111111111111111'
    ));
    assert.ok(expandRequest, 'expanding a tree folder must request only that folder');
    await page.evaluate(message => window.dispatchEvent(new MessageEvent('message', { data: message })), {
        type: 'file-transfer-remote-directory-listed', version: 1,
        requestId: expandRequest.requestId, side: 'left',
        root: {
            rootId: '0123456789abcdef0123456789abcdef',
            directoryId: '11111111111111111111111111111111', label: 'Build Machine',
            displayPath: '/workspace/src', entries: [
                { id: '33333333333333333333333333333333', name: 'index.ts', kind: 'file', size: 21 },
            ],
        },
    });

    assert.equal(await endpoint.inputValue(), 'managed:machine:build');
    assert.equal(await page.locator('[data-file-transfer-path-input="left"]').inputValue(), '/workspace');
    assert.equal(await page.locator('[data-file-transfer-entry-id="11111111111111111111111111111111"]')
        .getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-file-transfer-entry-id="33333333333333333333333333333333"]')
        .getAttribute('aria-level'), '2');
    assert.equal(await page.locator('[data-file-transfer-pane-copy-state]').first().isVisible(), false,
        'the copy-source indicator must stay out of the layout until a file is selected');
});

test('FILE-TRANSFER-UI-018 hides path-like hidden entries until Show hidden is selected, expands from an explicit folder-name control, and keeps endpoint controls visible while browsing', async t => {
    const page = await browser.newPage({ viewport: { width: 720, height: 520 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html><style>
        :root { --vscode-foreground: #ddd; --vscode-descriptionForeground: #aaa; --vscode-panel-border: #555; --vscode-editor-background: #1e1e1e; --vscode-sideBarSectionHeader-background: #252525; --vscode-input-border: #555; --vscode-input-foreground: #ddd; --vscode-input-background: #333; --vscode-button-foreground: #fff; --vscode-button-background: #0e639c; }
        body { margin: 0; padding: 10px; background: #1e1e1e; }
        ${styles}
    </style><body>
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
        'the tree must show a folder label, not a redundant type and absolute path');
    await folderName.click();
    const expandRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-open-directory'
            && message.endpoint && message.endpoint.directoryId === '11111111111111111111111111111111'
    ));
    assert.ok(expandRequest, 'clicking a folder name must expand it; the tiny disclosure alone is not an adequate hit target');

    await page.evaluate(() => {
        document.querySelectorAll('[data-file-transfer-file-list]').forEach(list => {
            list.hidden = false;
            list.innerHTML = Array.from({ length: 160 }, (_unused, index) =>
                '<li class="file-transfer-file-row">File ' + index + '</li>'
            ).join('');
        });
        window.scrollTo(0, 260);
    });
    const endpointControls = await page.locator('.file-transfer-pair').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
    });
    assert.ok(endpointControls.top >= 0 && endpointControls.bottom <= endpointControls.viewportHeight,
        'endpoint controls must remain visible while a long directory is scrolled');
});

test('FILE-TRANSFER-UI-019 keeps the direct transfer action available once source and target directories are ready', async t => {
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
    const copyRequest = await page.evaluate(() => window.__fileTransferMessages.find(message =>
        message.type === 'file-transfer-copy'
    ));
    assert.deepEqual(copyRequest.entryIds, ['11111111111111111111111111111111']);
    assert.equal(copyRequest.source.machineId, 'machine:build');
    assert.equal(copyRequest.destination.machineId, 'machine:deploy');
});

test('FILE-TRANSFER-UI-020 makes the source, target, readiness, and direct transfer action explicit', async t => {
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

    assert.match(await page.locator('[data-file-transfer-readiness]').textContent(),
        /UI Bridge responding[\s\S]*Source directory ready[\s\S]*Target directory ready/i);
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
        /0 items loaded in this Managed Machine directory/i);
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
