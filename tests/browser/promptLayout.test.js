'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const {
    getAiPanelContent,
    getPromptSurfaceContent,
} = require('../../out/prompts/webviewContent');

const styles = fs.readFileSync(path.join(__dirname, '../../media/styles.css'), 'utf8');
const promptScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/webviewPromptScripts.js'),
    'utf8'
);
const longName = `Prompt-${'name'.repeat(42)}`;
const longBody = `Preview-${'body'.repeat(52)}`;

function snapshotAt(revision) {
    return {
        version: 1,
        revision,
        selectedPromptId: null,
        prompts: [{
            id: 'prompt-a',
            name: longName,
            text: longBody,
        }],
    };
}

function renderDashboardShell() {
    const vscode = {
        Uri: {
            file(value) {
                return {
                    fsPath: value,
                    path: value,
                    toString() {
                        return `file://${value}`;
                    },
                };
            },
        },
    };
    const contentPath = require.resolve('../../out/webview/webviewContent');
    const previousLoad = Module._load;
    let getStewardContent;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        ({ getStewardContent } = require(contentPath));
    } finally {
        Module._load = previousLoad;
    }
    const html = getStewardContent(
        { extensionPath: '/extension' },
        {
            cspSource: 'test',
            asWebviewUri: resource => resource,
        },
        [],
        {
            config: {
                get(_key, fallback) {
                    return fallback;
                },
                displayProjectPath: true,
                searchIsActiveByDefault: false,
                showAddGroupButtonTile: false,
            },
            relevantExtensionsInstalls: {
                remoteSSH: false,
                remoteContainers: false,
            },
            otherStorageHasData: false,
            todoSearchItems: [],
        },
        true,
    );
    return html
        .replace(/<link\b[^>]*>/gi, '')
        .replace(/<script\b[\s\S]*?<\/script>/gi, '')
        .replace('</head>', `<style>${styles}</style></head>`);
}

async function openPromptPage(browser, snapshot) {
    const page = await browser.newPage({ viewport: { width: 320, height: 420 } });
    await page.setContent(`<!doctype html>
        <html>
            <head><style>${styles}</style></head>
            <body class="steward-sidebar">
                <main id="ai-host">${getAiPanelContent(snapshot)}</main>
                <div style="height: 1200px" aria-hidden="true"></div>
            </body>
        </html>`);
    await page.evaluate(() => {
        window.__promptMessages = [];
        window.vscode = {
            postMessage(message) {
                window.__promptMessages.push(message);
            },
        };
    });
    await page.addScriptTag({ content: promptScript });
    assert.equal(await page.evaluate(initialSnapshot =>
        window.__projectStewardPrompts.mount(document.getElementById('ai-host'), {
            authoritySequence: 1,
            snapshot: initialSnapshot,
        }), snapshot
    ), true);
    return page;
}

async function captureFocusAndViewport(page) {
    return page.evaluate(() => {
        const active = document.activeElement;
        const form = active && active.closest
            ? active.closest('[data-prompt-form]')
            : null;
        return {
            action: active && active.getAttribute
                ? active.getAttribute('data-action')
                : null,
            fieldName: active && active.getAttribute
                ? active.getAttribute('name')
                : null,
            formAction: active && active.getAttribute
                ? active.getAttribute('data-prompt-form-action')
                : null,
            formKind: form ? form.getAttribute('data-prompt-form') : null,
            promptId: form
                ? form.getAttribute('data-prompt-id')
                : active && active.getAttribute
                    ? active.getAttribute('data-prompt-id')
                    : null,
            scrollY: Math.round(window.scrollY),
        };
    });
}

async function applyPostedCommandResult(page, snapshot) {
    const request = await page.evaluate(() => window.__promptMessages[0]);
    assert.ok(request);
    assert.equal(await page.evaluate(({ request, snapshot, html }) =>
        window.__projectStewardPrompts.applyCommandResult({
            type: 'prompt-command-result',
            version: request.version,
            authoritySequence: 2,
            requestId: request.requestId,
            target: request.target,
            operation: request.operation,
            success: true,
            snapshot,
            html,
        }), {
        request,
        snapshot,
        html: getPromptSurfaceContent(snapshot),
    }), true);
}

async function assertNoHorizontalOverflow(page, width, label) {
    const layout = await page.evaluate(() => {
        const viewportWidth = document.documentElement.clientWidth;
        const surface = document.querySelector('[data-prompt-surface]');
        const overflowingElements = Array.from(document.querySelectorAll(
            '[data-ai-panel], [data-prompt-surface], [data-prompt-surface] *'
        )).filter(element => {
            if (element.hidden || getComputedStyle(element).display === 'none') return false;
            const bounds = element.getBoundingClientRect();
            return bounds.left < -0.5 || bounds.right > viewportWidth + 0.5;
        }).map(element => ({
            tag: element.tagName,
            className: element.className,
            left: element.getBoundingClientRect().left,
            right: element.getBoundingClientRect().right,
        }));
        return {
            documentClientWidth: viewportWidth,
            documentScrollWidth: document.documentElement.scrollWidth,
            surfaceClientWidth: surface.clientWidth,
            surfaceScrollWidth: surface.scrollWidth,
            overflowingElements,
        };
    });
    assert.ok(
        layout.documentScrollWidth <= layout.documentClientWidth,
        `${label} document overflows at ${width}px: ${JSON.stringify(layout)}`
    );
    assert.ok(
        layout.surfaceScrollWidth <= layout.surfaceClientWidth,
        `${label} Prompt surface overflows at ${width}px: ${JSON.stringify(layout)}`
    );
    assert.deepEqual(
        layout.overflowingElements,
        [],
        `${label} elements overflow at ${width}px`
    );
}

async function assertReachable(page, selector, width) {
    const controls = await page.locator(selector).evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect();
        const centerX = bounds.left + bounds.width / 2;
        const centerY = bounds.top + bounds.height / 2;
        const hit = document.elementFromPoint(centerX, centerY);
        return {
            label: element.getAttribute('aria-label') || element.textContent.trim(),
            visible: bounds.width > 0
                && bounds.height > 0
                && bounds.left >= 0
                && bounds.right <= document.documentElement.clientWidth
                && bounds.top >= 0
                && bounds.bottom <= document.documentElement.clientHeight
                && Boolean(hit && (hit === element || element.contains(hit))),
        };
    }));
    assert.ok(controls.length > 0, `missing ${selector} at ${width}px`);
    assert.ok(
        controls.every(control => control.visible),
        `${selector} must remain visible and reachable at ${width}px: ${JSON.stringify(controls)}`
    );
}

async function waitForPromptActions(page) {
    await page.waitForFunction(() => {
        const actions = document.querySelector('.prompt-management-actions');
        if (!actions) return false;
        const styles = getComputedStyle(actions);
        return styles.opacity === '1' && styles.pointerEvents === 'auto';
    });
}

async function revealPromptActions(page) {
    await page.locator('.prompt-item').hover();
    await waitForPromptActions(page);
}

test('WEBVIEW-AI-PROMPT-INTERACTION-001 keeps Prompt controls and text usable in narrow sidebars', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());

    for (const width of [240, 280, 320, 420]) {
        await t.test(`${width}px`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 1000 } });
            t.after(() => page.close());
            const initialSnapshot = snapshotAt(1);

            await page.setContent(`<!doctype html>
                <html>
                    <head><style>${styles}</style></head>
                    <body class="steward-sidebar">
                        <main id="ai-host">${getAiPanelContent(initialSnapshot)}</main>
                    </body>
                </html>`);
            await page.evaluate(() => {
                window.vscode = { postMessage() {} };
            });
            await page.addScriptTag({ content: promptScript });
            assert.equal(await page.evaluate(snapshot =>
                window.__projectStewardPrompts.mount(document.getElementById('ai-host'), {
                    authoritySequence: 1,
                    snapshot,
                }), initialSnapshot
            ), true);

            await assertNoHorizontalOverflow(page, width, 'initial');
            await assertReachable(page, '[data-action="prompt-new"]', width);
            await assertReachable(page, '[data-action="prompt-insert-terminal"]', width);

            assert.equal(await page.locator('.prompt-management-actions').evaluate(element =>
                getComputedStyle(element).opacity
            ), '0');
            assert.equal(await page.locator('.prompt-management-actions').evaluate(element =>
                getComputedStyle(element).pointerEvents
            ), 'none');

            const boundedText = await page.evaluate(() => {
                const measure = selector => {
                    const element = document.querySelector(selector);
                    const styles = getComputedStyle(element);
                    return {
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                        height: element.getBoundingClientRect().height,
                        lineHeight: parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.2,
                        overflowWrap: styles.overflowWrap,
                        textOverflow: styles.textOverflow,
                        whiteSpace: styles.whiteSpace,
                    };
                };
                return {
                    name: measure('.prompt-name'),
                    preview: measure('.prompt-preview'),
                };
            });
            assert.ok(
                boundedText.name.height <= boundedText.name.lineHeight * 1.2,
                `name must remain one line at ${width}px`
            );
            assert.equal(boundedText.name.textOverflow, 'ellipsis');
            assert.equal(boundedText.name.whiteSpace, 'nowrap');
            assert.ok(
                boundedText.preview.height <= boundedText.preview.lineHeight * 2.1,
                `preview must remain within two lines at ${width}px`
            );

            await revealPromptActions(page);
            assert.equal(await page.locator('.prompt-management-actions').evaluate(element =>
                getComputedStyle(element).opacity
            ), '1');
            await assertReachable(page, '[data-action="prompt-select-default"]', width);
            await assertReachable(page, '[data-action="prompt-edit"]', width);
            await assertReachable(page, '[data-action="prompt-delete"]', width);
            const hoverLayout = await page.evaluate(() => {
                const name = document.querySelector('.prompt-name').getBoundingClientRect();
                const actions = document.querySelector('.prompt-management-actions').getBoundingClientRect();
                return {
                    nameRight: name.right,
                    actionsLeft: actions.left,
                };
            });
            assert.ok(
                hoverLayout.nameRight <= hoverLayout.actionsLeft,
                `Prompt name must not overlap management actions at ${width}px: ${JSON.stringify(hoverLayout)}`
            );

            await page.locator('[data-action="prompt-edit"]').focus();
            await waitForPromptActions(page);
            assert.equal(await page.locator('.prompt-management-actions').evaluate(element =>
                getComputedStyle(element).opacity
            ), '1');

            await page.locator('[data-action="prompt-new"]').click();
            const textarea = page.locator('[data-prompt-form="create"] textarea');
            await textarea.fill('A usable narrow Prompt body');
            const textareaLayout = await textarea.evaluate(element => {
                const bounds = element.getBoundingClientRect();
                return {
                    left: bounds.left,
                    right: bounds.right,
                    width: bounds.width,
                    resize: getComputedStyle(element).resize,
                    value: element.value,
                };
            });
            assert.ok(textareaLayout.width >= 120, `textarea is too narrow at ${width}px`);
            assert.ok(textareaLayout.left >= 0 && textareaLayout.right <= width);
            assert.equal(textareaLayout.resize, 'vertical');
            assert.equal(textareaLayout.value, 'A usable narrow Prompt body');
            await assertReachable(page, '.prompt-create-form .prompt-form-actions button', width);
            await assertNoHorizontalOverflow(page, width, 'open create form');
            await page.locator('[data-action="prompt-cancel-create"]').click();

            await page.locator('[data-action="prompt-edit"]').focus();
            const nextSnapshot = snapshotAt(2);
            assert.equal(await page.evaluate(({ snapshot, html }) =>
                window.__projectStewardPrompts.applyRefresh({
                    type: 'prompt-panel-updated',
                    version: 1,
                    authoritySequence: 2,
                    target: 'global-prompt-library',
                    snapshot,
                    html,
                }), {
                snapshot: nextSnapshot,
                html: getPromptSurfaceContent(nextSnapshot),
            }), true);
            const restoredFocus = await page.evaluate(() => ({
                action: document.activeElement.getAttribute('data-action'),
                promptId: document.activeElement.getAttribute('data-prompt-id'),
            }));
            assert.deepEqual(restoredFocus, {
                action: 'prompt-edit',
                promptId: 'prompt-a',
            });
            await assertReachable(page, '[data-action="prompt-edit"]', width);
            await assertNoHorizontalOverflow(page, width, 'authoritative replacement');
        });
    }
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 restores form and New Prompt focus with the real viewport in Chromium', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());

    for (const scenario of [
        {
            name: 'create textarea after failed result',
            setup: async page => {
                await page.locator('[data-action="prompt-new"]').click();
                await page.locator('[data-prompt-form="create"] [name="name"]').fill('Local create');
                await page.locator('[data-prompt-form="create"] [name="text"]').fill('Local body');
                await page.locator('[data-prompt-form="create"] [name="text"]').focus();
            },
            replace: async (page, snapshot) => {
                await page.locator('[data-prompt-form="create"]').evaluate(form => {
                    form.dispatchEvent(new Event('submit', {
                        bubbles: true,
                        cancelable: true,
                    }));
                });
                const request = await page.evaluate(() => window.__promptMessages[0]);
                assert.ok(request);
                assert.equal(await page.evaluate(({ request, snapshot, html }) =>
                    window.__projectStewardPrompts.applyCommandResult({
                        type: 'prompt-command-result',
                        version: request.version,
                        authoritySequence: 2,
                        requestId: request.requestId,
                        target: request.target,
                        operation: request.operation,
                        success: false,
                        errorCode: 'storage',
                        snapshot,
                        html,
                    }), {
                    request,
                    snapshot,
                    html: getPromptSurfaceContent(snapshot),
                }), true);
            },
            expected: {
                action: null,
                fieldName: 'text',
                formAction: null,
                formKind: 'create',
                promptId: null,
            },
        },
        {
            name: 'create submit after failed result',
            setup: async page => {
                await page.locator('[data-action="prompt-new"]').click();
                await page.locator('[data-prompt-form="create"] [name="name"]').fill('Local create');
                await page.locator('[data-prompt-form="create"] [name="text"]').fill('Local body');
                await page.locator('[data-prompt-form="create"] [type="submit"]').focus();
            },
            replace: async (page, snapshot) => {
                await page.locator('[data-prompt-form="create"]').evaluate(form => {
                    form.dispatchEvent(new Event('submit', {
                        bubbles: true,
                        cancelable: true,
                    }));
                });
                const request = await page.evaluate(() => window.__promptMessages[0]);
                assert.ok(request);
                assert.equal(await page.evaluate(({ request, snapshot, html }) =>
                    window.__projectStewardPrompts.applyCommandResult({
                        type: 'prompt-command-result',
                        version: request.version,
                        authoritySequence: 2,
                        requestId: request.requestId,
                        target: request.target,
                        operation: request.operation,
                        success: false,
                        errorCode: 'storage',
                        snapshot,
                        html,
                    }), {
                    request,
                    snapshot,
                    html: getPromptSurfaceContent(snapshot),
                }), true);
            },
            expected: {
                action: null,
                fieldName: null,
                formAction: 'submit',
                formKind: 'create',
                promptId: null,
            },
        },
        {
            name: 'edit name after external refresh',
            setup: async page => {
                await revealPromptActions(page);
                await page.locator('[data-action="prompt-edit"]').click();
                await page.locator('[data-prompt-form="edit"] [name="name"]').focus();
            },
            replace: async page => {
                const snapshot = snapshotAt(2);
                assert.equal(await page.evaluate(({ snapshot, html }) =>
                    window.__projectStewardPrompts.applyRefresh({
                        type: 'prompt-panel-updated',
                        version: 1,
                        authoritySequence: 2,
                        target: 'global-prompt-library',
                        snapshot,
                        html,
                    }), {
                    snapshot,
                    html: getPromptSurfaceContent(snapshot),
                }), true);
            },
            expected: {
                action: null,
                fieldName: 'name',
                formAction: null,
                formKind: 'edit',
                promptId: 'prompt-a',
            },
        },
        {
            name: 'edit cancel after external refresh',
            setup: async page => {
                await revealPromptActions(page);
                await page.locator('[data-action="prompt-edit"]').click();
                await page.locator('[data-action="prompt-cancel-edit"]').focus();
            },
            replace: async page => {
                const snapshot = snapshotAt(2);
                assert.equal(await page.evaluate(({ snapshot, html }) =>
                    window.__projectStewardPrompts.applyRefresh({
                        type: 'prompt-panel-updated',
                        version: 1,
                        authoritySequence: 2,
                        target: 'global-prompt-library',
                        snapshot,
                        html,
                    }), {
                    snapshot,
                    html: getPromptSurfaceContent(snapshot),
                }), true);
            },
            expected: {
                action: 'prompt-cancel-edit',
                fieldName: null,
                formAction: 'cancel',
                formKind: 'edit',
                promptId: 'prompt-a',
            },
        },
        {
            name: 'New Prompt after external refresh',
            setup: async page => {
                await page.locator('[data-action="prompt-new"]').focus();
            },
            replace: async page => {
                const snapshot = snapshotAt(2);
                assert.equal(await page.evaluate(({ snapshot, html }) =>
                    window.__projectStewardPrompts.applyRefresh({
                        type: 'prompt-panel-updated',
                        version: 1,
                        authoritySequence: 2,
                        target: 'global-prompt-library',
                        snapshot,
                        html,
                    }), {
                    snapshot,
                    html: getPromptSurfaceContent(snapshot),
                }), true);
            },
            expected: {
                action: 'prompt-new',
                fieldName: null,
                formAction: null,
                formKind: null,
                promptId: null,
            },
        },
    ]) {
        await t.test(scenario.name, async () => {
            const snapshot = snapshotAt(1);
            const page = await openPromptPage(browser, snapshot);
            try {
                await scenario.setup(page);
                const beforeScrollY = await page.evaluate(() => {
                    window.scrollTo(0, 167);
                    return Math.round(window.scrollY);
                });
                assert.ok(beforeScrollY > 0);
                await scenario.replace(page, snapshot);
                assert.deepEqual(await captureFocusAndViewport(page), {
                    ...scenario.expected,
                    scrollY: beforeScrollY,
                });
            } finally {
                await page.close();
            }
        });
    }
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 moves successful Prompt form focus to stable controls in Chromium', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());

    for (const scenario of [
        {
            name: 'create success returns to New Prompt',
            setup: async page => {
                await page.locator('[data-action="prompt-new"]').click();
                await page.locator('[data-prompt-form="create"] [name="name"]').fill('Created');
                await page.locator('[data-prompt-form="create"] [name="text"]').fill('Created body');
                await page.locator('[data-prompt-form="create"] [type="submit"]').focus();
                await page.locator('[data-prompt-form="create"]').evaluate(form => {
                    form.dispatchEvent(new Event('submit', {
                        bubbles: true,
                        cancelable: true,
                    }));
                });
            },
            savedSnapshot: snapshot => ({
                ...snapshotAt(2),
                prompts: snapshot.prompts.concat({
                    id: 'prompt-created',
                    name: 'Created',
                    text: 'Created body',
                }),
            }),
            expected: {
                action: 'prompt-new',
                fieldName: null,
                formAction: null,
                formKind: null,
                promptId: null,
            },
        },
        {
            name: 'update success returns to the updated Edit action',
            setup: async page => {
                await revealPromptActions(page);
                await page.locator('[data-action="prompt-edit"][data-prompt-id="prompt-a"]').click();
                await page.locator('[data-prompt-form="edit"] [name="name"]').fill('Updated');
                await page.locator('[data-prompt-form="edit"] [type="submit"]').focus();
                await page.locator('[data-prompt-form="edit"]').evaluate(form => {
                    form.dispatchEvent(new Event('submit', {
                        bubbles: true,
                        cancelable: true,
                    }));
                });
            },
            savedSnapshot: () => ({
                ...snapshotAt(2),
                prompts: [{
                    id: 'prompt-a',
                    name: 'Updated',
                    text: longBody,
                }],
            }),
            expected: {
                action: 'prompt-edit',
                fieldName: null,
                formAction: null,
                formKind: null,
                promptId: 'prompt-a',
            },
        },
    ]) {
        await t.test(scenario.name, async () => {
            const snapshot = snapshotAt(1);
            const page = await openPromptPage(browser, snapshot);
            try {
                await scenario.setup(page);
                const beforeScrollY = await page.evaluate(() => {
                    window.scrollTo(0, 143);
                    return Math.round(window.scrollY);
                });
                assert.ok(beforeScrollY > 0);
                await applyPostedCommandResult(page, scenario.savedSnapshot(snapshot));
                assert.deepEqual(await captureFocusAndViewport(page), {
                    ...scenario.expected,
                    scrollY: beforeScrollY,
                });
            } finally {
                await page.close();
            }
        });
    }
});

test('WEBVIEW-AI-PROMPT-INTERACTION-001 keeps the complete four-tab Dashboard shell on one row', async t => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    t.after(() => browser.close());
    const dashboardHtml = renderDashboardShell();
    let fullWidthFontSize;

    for (const width of [600, 480, 460, 320, 280, 240]) {
        await t.test(`${width}px`, async () => {
            const page = await browser.newPage({ viewport: { width, height: 700 } });
            try {
                await page.setContent(dashboardHtml);
                const layout = await page.evaluate(() => {
                    const viewportWidth = document.documentElement.clientWidth;
                    const boundsOf = element => {
                        const bounds = element.getBoundingClientRect();
                        return {
                            left: bounds.left,
                            right: bounds.right,
                            top: bounds.top,
                            bottom: bounds.bottom,
                            width: bounds.width,
                            height: bounds.height,
                        };
                    };
                    const tabs = Array.from(document.querySelectorAll('[data-dashboard-tab]'));
                    const tabDetails = tabs.map(tab => {
                        const icon = tab.querySelector('.dashboard-tab-icon');
                        const label = tab.querySelector('.dashboard-tab-label');
                        const svg = icon ? icon.querySelector('svg') : null;
                        const svgBounds = svg ? svg.getBoundingClientRect() : null;
                        const artworkBounds = svg ? svg.getBBox() : null;
                        const viewBox = svg ? svg.viewBox.baseVal : null;
                        const artworkWidth = svg && viewBox.width
                            ? artworkBounds.width / viewBox.width * svgBounds.width
                            : 0;
                        const artworkHeight = svg && viewBox.height
                            ? artworkBounds.height / viewBox.height * svgBounds.height
                            : 0;
                        return {
                            ariaLabel: tab.getAttribute('aria-label'),
                            title: tab.getAttribute('title'),
                            iconDisplay: icon ? getComputedStyle(icon).display : null,
                            iconWidth: icon ? icon.getBoundingClientRect().width : 0,
                            iconHeight: icon ? icon.getBoundingClientRect().height : 0,
                            artworkArea: artworkWidth * artworkHeight,
                            labelDisplay: label ? getComputedStyle(label).display : null,
                            fontSize: getComputedStyle(tab).fontSize,
                        };
                    });
                    const rowTops = [];
                    const rowCounts = [];
                    tabs.forEach(tab => {
                        const top = tab.getBoundingClientRect().top;
                        let row = rowTops.findIndex(candidate => Math.abs(candidate - top) < 1);
                        if (row < 0) {
                            rowTops.push(top);
                            rowCounts.push(0);
                            row = rowCounts.length - 1;
                        }
                        rowCounts[row] += 1;
                    });
                    const controls = Array.from(document.querySelectorAll(
                        '#filter, .toggle-all-groups-button, .settings-button, [data-dashboard-tab]'
                    )).map(element => ({
                        label: element.getAttribute('aria-label')
                            || element.textContent.trim(),
                        bounds: boundsOf(element),
                        clientWidth: element.clientWidth,
                        scrollWidth: element.scrollWidth,
                    }));
                    return {
                        documentClientWidth: viewportWidth,
                        documentScrollWidth: document.documentElement.scrollWidth,
                        labels: tabs.map(tab => tab.textContent.trim()),
                        tabDetails,
                        rowCounts,
                        tabList: boundsOf(document.querySelector('.dashboard-tab-list')),
                        filterWrapper: boundsOf(document.querySelector('.filter-wrapper')),
                        controls,
                    };
                });

                assert.deepEqual(layout.labels, ['OPEN', 'PROJECTS', 'TODO', 'AI']);
                assert.deepEqual(
                    layout.tabDetails.map(tab => tab.ariaLabel),
                    ['Open', 'Projects', 'Todo', 'AI']
                );
                assert.deepEqual(
                    layout.tabDetails.map(tab => tab.title),
                    ['Open', 'Projects', 'Todo', 'AI']
                );
                assert.ok(
                    layout.tabDetails.every(tab =>
                        tab.iconDisplay !== 'none'
                        && tab.iconWidth === 19
                        && tab.iconHeight === 19),
                    `Dashboard tab icons must remain 19px at ${width}px: ${JSON.stringify(layout)}`
                );
                const artworkAreas = layout.tabDetails.map(tab => tab.artworkArea);
                assert.ok(
                    Math.max(...artworkAreas) / Math.min(...artworkAreas) <= 1.03,
                    `Dashboard tab artwork must have consistent optical area at ${width}px: `
                    + JSON.stringify(layout)
                );
                if (fullWidthFontSize === undefined) {
                    fullWidthFontSize = layout.tabDetails[0].fontSize;
                }
                assert.ok(
                    layout.tabDetails.every(tab => tab.fontSize === fullWidthFontSize),
                    `Dashboard tab text must not shrink at ${width}px: ${JSON.stringify(layout)}`
                );
                assert.ok(
                    layout.tabDetails.every(tab =>
                        width <= 460
                            ? tab.labelDisplay === 'none'
                            : tab.labelDisplay !== 'none'),
                    `Dashboard tab labels have the wrong visibility at ${width}px: ${JSON.stringify(layout)}`
                );
                assert.ok(
                    layout.documentScrollWidth <= layout.documentClientWidth,
                    `Dashboard document overflows at ${width}px: ${JSON.stringify(layout)}`
                );
                for (const [shellName, shell] of [
                    ['filter wrapper', layout.filterWrapper],
                    ['tab list', layout.tabList],
                ]) {
                    assert.ok(
                        shell.width > 0
                            && shell.left >= -0.5
                            && shell.right <= width + 0.5,
                        `${shellName} must fit at ${width}px: ${JSON.stringify(shell)}`
                    );
                }
                for (const control of layout.controls) {
                    assert.ok(
                        control.bounds.width > 0
                            && control.bounds.height > 0
                            && control.bounds.left >= -0.5
                            && control.bounds.right <= width + 0.5,
                        `${control.label} must fit at ${width}px: ${JSON.stringify(control)}`
                    );
                    assert.ok(
                        control.scrollWidth <= control.clientWidth,
                        `${control.label} clips at ${width}px: ${JSON.stringify(control)}`
                    );
                }
                assert.deepEqual(layout.rowCounts, [4]);
            } finally {
                await page.close();
            }
        });
    }
});
