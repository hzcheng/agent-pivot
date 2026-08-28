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
const dashboardBundle = fs.readFileSync(
    path.join(__dirname, '../../media/webviewDashboardBundle.js'),
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

test('WEBVIEW-NONBLOCKING-FIRST-PAINT-001 production Dashboard announces its document generation', async t => {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    t.after(() => page.close());
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => {
        window.__agentPivotMessages = [];
        window.acquireVsCodeApi = () => ({
            postMessage(message) { window.__agentPivotMessages.push(message); },
            getState() { return {}; },
            setState() {},
        });
    });
    await page.route('https://assets.test/**', route => {
        const url = route.request().url();
        if (url.includes('webviewDashboardBundle.js')) {
            return route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                body: dashboardBundle,
            });
        }
        if (url.includes('styles.css')) {
            return route.fulfill({
                status: 200,
                contentType: 'text/css',
                body: dashboardStyles,
            });
        }
        return route.abort();
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
        [],
        'ready',
        41,
    );

    await page.route('https://dashboard.test/', route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: html,
    }));
    await page.goto('https://dashboard.test/', { waitUntil: 'load' });
    await page.waitForTimeout(100);
    const readyMessage = await page.evaluate(() =>
        window.__agentPivotMessages.find(message =>
            message.type === 'open-workspaces-renderer-ready'
        )
    );
    assert.deepEqual(readyMessage, {
        type: 'open-workspaces-renderer-ready',
        version: 1,
        documentGeneration: 41,
    }, pageErrors.join('\n'));
    assert.deepEqual(pageErrors, []);
});

test('WEBVIEW-DASHBOARD-SEARCH-001 keeps search available when project-card startup fails', async t => {
    const page = await browser.newPage({ viewport: { width: 360, height: 640 } });
    t.after(() => page.close());
    const consoleErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
        }
    });
    await page.addInitScript(() => {
        window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return {}; }, setState() {} });
    });
    await page.route('https://assets.test/**', route => {
        const url = route.request().url();
        if (url.includes('webviewDashboardBundle.js')) {
            return route.fulfill({
                status: 200,
                contentType: 'application/javascript',
                body: dashboardBundle.replace(
                    'function initProjects() {',
                    'function initProjects() { throw new Error("project startup failure");',
                ),
            });
        }
        if (url.includes('styles.css')) {
            return route.fulfill({ status: 200, contentType: 'text/css', body: dashboardStyles });
        }
        return route.abort();
    });
    const html = getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'https://assets.test',
            asWebviewUri: resource => ({
                toString: () => `https://assets.test/${path.basename(resource.fsPath)}`,
            }),
        },
        [{
            id: 'projects', groupName: 'Projects', collapsed: false,
            projects: [{
                id: 'reddev-container', name: 'reddev-container', path: '/work/reddev-container',
                description: '', favorite: false, tags: [],
            }],
        }],
        {
            config: { get: (_key, fallback) => fallback },
            relevantExtensionsInstalls: { remoteSSH: true, remoteContainers: false },
            otherStorageHasData: false,
        },
        true,
    );
    await page.route('https://dashboard.test/', route => route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: html,
    }));
    await page.goto('https://dashboard.test/', { waitUntil: 'load' });
    await page.locator('#filter').fill('reddev');

    const result = page.locator('.dashboard-search-result');
    assert.equal(await result.count(), 1);
    assert.equal(await result.locator('.dashboard-search-result-title').textContent(), 'reddev-container');
    assert.ok(consoleErrors.some(message => message.includes('Project controls failed to initialize.')));
});
