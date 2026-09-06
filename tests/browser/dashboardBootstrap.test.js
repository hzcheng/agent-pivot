'use strict';

/**
 * Runs the real Webview bootstrap in a browser.
 *
 * Every other browser test strips the script bundle out of the generated
 * document and asserts layout only, and the machine-projects suite hand-calls
 * `mount()` before clicking. So nothing exercises the path that actually makes
 * the Project tab interactive: real generated HTML, real bundle, real
 * `initDashboard` wiring, real click, real posted message. That gap lets the
 * whole tab go inert with the suite green.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const Module = require('node:module');
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
        return require('../../out/webview/webviewContent');
    } finally {
        Module._load = previousLoad;
    }
}

const { getStewardContent } = loadWebviewContent();
const {
    buildManagedRemoteProjectsViewModel,
} = require('../../out/projects/managedRemote/viewModel');
const {
    renderManagedRemoteProjectsPanel,
} = require('../../out/webview/webviewManagedRemoteProjectsContent');
const {
    createEmptyManagedRemoteCatalog,
    materializeManagedRemoteCatalog,
} = require('../../out/projects/managedRemote/merge');

const bundle = fs.readFileSync(
    path.join(__dirname, '../../media/webviewDashboardBundle.js'), 'utf8',
);
const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser?.close(); });

function emptySnapshot() {
    return {
        revisionId: null,
        lifecycle: 'disabled',
        catalog: materializeManagedRemoteCatalog(createEmptyManagedRemoteCatalog('actor')),
        machineConflictCandidates: {},
    };
}

/** The real document, with the external bundle inlined so it actually runs. */
function document_(snapshot) {
    return getStewardContent(
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
        false, [], 'ready', 1, undefined, undefined,
        snapshot,
    )
        .replace(/<meta[^>]*Content-Security-Policy[^>]*>/, '')
        .replace(/<link[^>]*rel="stylesheet"[^>]*>/, '')
        .replace('</head>', `<style>${styles}</style></head>`)
        .replace('class="dashboard-styles-pending"', '');
}

async function openDashboard(t, snapshot = emptySnapshot()) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    t.after(() => page.close());
    page.setDefaultTimeout(10000);
    const consoleErrors = [];
    page.on('console', event => {
        if (event.type() === 'error') { consoleErrors.push(event.text()); }
    });
    page.on('pageerror', error => consoleErrors.push(String(error)));
    await page.addInitScript(() => {
        window.__posted = [];
        window.acquireVsCodeApi = () => ({
            postMessage: message => { window.__posted.push(message); },
            getState: () => undefined,
            setState: () => undefined,
        });
    });
    // Serve the document and its bundle over a route so the real <script src>
    // ordering is preserved: the bundle must be evaluated before the inline
    // bootstrap that consumes it.
    const html = document_(snapshot);
    await page.route('**/*', route => {
        const url = route.request().url();
        if (url.endsWith('/index.html')) {
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        }
        if (url.includes('webviewDashboardBundle.js')) {
            return route.fulfill({
                contentType: 'text/javascript; charset=utf-8', body: bundle,
            });
        }
        return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    });
    await page.goto('https://assets.test/index.html', { waitUntil: 'load' });
    return { page, consoleErrors };
}

/**
 * Complete the real Projects panel handshake: the Webview asks for the panel
 * and only accepts a reply carrying the request id it issued.
 */
async function deliverProjectsPanel(page, snapshot) {
    await page.click('[data-dashboard-tab="projects"]');
    await page.waitForFunction(() => window.__posted
        .some(item => item?.type === 'request-projects-panel'));
    const requestId = await page.evaluate(() => window.__posted
        .filter(item => item?.type === 'request-projects-panel').at(-1).requestId);
    const html = renderManagedRemoteProjectsPanel(
        buildManagedRemoteProjectsViewModel(snapshot),
    );
    await page.evaluate(({ panelHtml, id }) => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'projects-panel-content', version: 1, requestId: id, html: panelHtml,
            },
        }));
    }, { panelHtml: html, id: requestId });
}

test('WEBVIEW-DASHBOARD-BOOTSTRAP-001 boots the real bundle without a script error', async t => {
    const { consoleErrors } = await openDashboard(t);
    assert.deepEqual(consoleErrors, [],
        `the Webview bootstrap must not throw: ${consoleErrors.join(' | ')}`);
});

test('WEBVIEW-DASHBOARD-BOOTSTRAP-001 binds the Managed Remote toolbar after a panel update', async t => {
    const { page, consoleErrors } = await openDashboard(t);
    await deliverProjectsPanel(page, emptySnapshot());

    const button = page.locator('[data-action="show-add-machine-form"]');
    assert.equal(await button.count(), 1, 'the Add Machine control must render');

    // The real proof: opening and submitting the inline form has to reach the
    // extension. Without mount() the whole tab is inert.
    await button.click();
    await page.locator('[data-managed-machine-form] input[name="name"]').fill('Build');
    await page.locator('[data-managed-machine-form] input[name="host"]').fill('build.example.com');
    await page.locator('[data-managed-machine-form] input[name="user"]').fill('dev');
    await page.locator('[data-managed-machine-form]').evaluate(form => form.requestSubmit());
    const posted = await page.evaluate(() => window.__posted);
    const action = posted.filter(item => item?.type === 'managed-remote-action').at(-1);

    assert.ok(action,
        'submitting Add Machine must post a managed-remote-action; '
        + `posted instead: ${JSON.stringify(posted)} | errors: ${consoleErrors.join(' | ')}`);
    assert.equal(action.operation, 'addMachine');
    assert.equal(action.version, 1);
    // An empty catalog has no revision yet; sending anything else strands the
    // very first action a new user takes.
    assert.equal(action.expectedRevisionId, null);
    assert.deepEqual(action.input, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 22,
    });
});
