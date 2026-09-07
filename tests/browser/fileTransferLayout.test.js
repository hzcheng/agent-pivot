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

test('FILE-TRANSFER-EDITOR-001 FILE-TRANSFER-UI-011 keeps sorting controls readable and keeps the inactive review sheet out of layout', async t => {
    for (const width of [480, 280]) {
        const page = await openPage(t, width);
        const metrics = await page.evaluate(() => {
            const panel = document.querySelector('.file-transfer');
            const toolbars = Array.from(document.querySelectorAll('[data-file-transfer-pane-toolbar]'));
            return {
                panelScrollWidth: panel.scrollWidth,
                panelClientWidth: panel.clientWidth,
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
        assert.equal(await page.locator('[data-file-transfer-review-sheet]').isVisible(), false,
            `width ${width}: File Transfer review must remain hidden until Review copy is selected`);
    }
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
            new Set(),
            () => {},
            directoryId => window.__fileTransferOpenedDirectories.push(directoryId),
            () => {},
            () => {},
        );
    });
    await page.locator('[data-file-transfer-entry-id]').click();
    assert.deepEqual(await page.evaluate(() => window.__fileTransferOpenedDirectories),
        ['0123456789abcdef0123456789abcdef']);

    await page.locator('[data-file-transfer-entry-id] input').click();
    assert.deepEqual(await page.evaluate(() => window.__fileTransferOpenedDirectories),
        ['0123456789abcdef0123456789abcdef']);
});
