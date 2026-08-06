'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const { createFakeVscode } = require('../helpers/fakeVscode');

function loadWebviewContent() {
    const vscode = createFakeVscode({});
    vscode.Uri = {
        file: value => ({ fsPath: value, path: value, toString: () => `file://${value}` }),
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve('../../out/webview/webviewContent')];
        return require('../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getStewardContent } = loadWebviewContent();
const dashboardStyles = fs.readFileSync(
    path.join(__dirname, '../../media/styles.css'),
    'utf8'
);

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

test('WEBVIEW-STYLESHEET-FIRST-PAINT-001 keeps the real Dashboard out of layout until its stylesheet is ready', async t => {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    t.after(() => page.close());
    await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return {}; }, setState() {} });
    });
    const html = getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'https://assets.test',
            asWebviewUri: resource => ({
                toString: () => `https://assets.test/${path.basename(resource.fsPath)}`,
            }),
        },
        [],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: true, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
    )
        .replace(/(<link[^>]*rel="stylesheet"[^>]*) href="[^"]*"([^>]*>)/, '$1$2')
        .replace(/<script src="[^"]*webviewDashboardBundle\.js[^"]*"><\/script>/, '');

    await page.setContent(html, { waitUntil: 'load' });

    const loadingSurface = page.locator('[data-dashboard-style-loading]');
    assert.equal(await loadingSurface.count(), 1,
        'the generated document must contain one stylesheet loading surface');
    assert.ok(await loadingSurface.boundingBox(),
        'a bounded loading surface must cover the stylesheet wait');
    assert.equal(await page.locator('.settings-button').boundingBox(), null,
        'the real Dashboard and its inline SVGs must not enter layout before CSS is ready');

    await page.addStyleTag({ content: dashboardStyles });
    await page.locator('link[rel="stylesheet"]').evaluate(element => {
        element.dispatchEvent(new Event('load'));
    });
    assert.equal(await loadingSurface.boundingBox(), null);
    const settingsBox = await page.locator('.settings-button').boundingBox();
    assert.ok(settingsBox && settingsBox.width <= 32 && settingsBox.height <= 32,
        `the styled settings icon must stay bounded: ${JSON.stringify(settingsBox)}`);
});
