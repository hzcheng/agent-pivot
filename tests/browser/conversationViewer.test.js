'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');

const purifyScript = fs.readFileSync(
    path.join(__dirname, '../../node_modules/dompurify/dist/purify.min.js'),
    'utf8'
);
const mermaidScript = fs.readFileSync(
    path.join(__dirname, '../../node_modules/mermaid/dist/mermaid.min.js'),
    'utf8'
);
const viewerScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationViewerScripts.js'),
    'utf8'
);
const readingAnchorScript = fs.readFileSync(
    path.join(
        __dirname,
        '../../src/webview/conversationReadingAnchorScripts.js'
    ),
    'utf8'
);
const conversationMermaidScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationMermaidScripts.js'),
    'utf8'
);
const conversationOutlineScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationOutlineScripts.js'),
    'utf8'
);
const conversationTelemetryScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationTelemetryScripts.js'),
    'utf8'
);
const conversationCommentsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationCommentsScripts.js'),
    'utf8'
);
const conversationSidebarScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationSidebarScripts.js'),
    'utf8'
);
const conversationReconcileScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationReconcileScripts.js'),
    'utf8'
);
const viewerCss = fs.readFileSync(
    path.join(__dirname, '../../media/conversationViewer.css'),
    'utf8'
);
const telemetryCss = fs.readFileSync(
    path.join(__dirname, '../../media/conversationTelemetry.css'),
    'utf8'
);
const conversationPerformanceBudgets = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../.ci/conversation-performance.json'),
    'utf8'
));
const viewerThemeFixtures = Object.freeze([
    Object.freeze({
        name: 'dark',
        css: `
            :root {
                --vscode-editor-foreground: #d4d4d4;
                --vscode-editor-background: #1e1e1e;
                --vscode-font-family: sans-serif;
                --vscode-font-size: 13px;
                --vscode-panel-border: #454545;
                --vscode-button-background: #0e639c;
                --vscode-button-foreground: #ffffff;
                --vscode-button-border: transparent;
                --vscode-input-background: #252b35;
                --vscode-input-border: #405677;
                --vscode-descriptionForeground: #a0a0a0;
                --vscode-focusBorder: #007fd4;
                --vscode-textCodeBlock-background: #181818;
                --vscode-editor-font-family: monospace;
                --vscode-textLink-foreground: #3794ff;
            }
        `,
        tokens: Object.freeze({
            editorForeground: 'rgb(212, 212, 212)',
            buttonBackground: 'rgb(14, 99, 156)',
            buttonForeground: 'rgb(255, 255, 255)',
            inputBackground: 'rgb(37, 43, 53)',
            descriptionForeground: 'rgb(160, 160, 160)',
        }),
    }),
    Object.freeze({
        name: 'light',
        css: `
            :root {
                --vscode-editor-foreground: #1f1f1f;
                --vscode-editor-background: #ffffff;
                --vscode-font-family: sans-serif;
                --vscode-font-size: 13px;
                --vscode-panel-border: #c8c8c8;
                --vscode-button-background: #005fb8;
                --vscode-button-foreground: #ffffff;
                --vscode-button-border: transparent;
                --vscode-input-background: #f3f6fa;
                --vscode-input-border: #6b7a90;
                --vscode-descriptionForeground: #616161;
                --vscode-focusBorder: #0067c0;
                --vscode-textCodeBlock-background: #f6f6f6;
                --vscode-editor-font-family: monospace;
                --vscode-textLink-foreground: #006ab1;
            }
        `,
        tokens: Object.freeze({
            editorForeground: 'rgb(31, 31, 31)',
            buttonBackground: 'rgb(0, 95, 184)',
            buttonForeground: 'rgb(255, 255, 255)',
            inputBackground: 'rgb(243, 246, 250)',
            descriptionForeground: 'rgb(97, 97, 97)',
        }),
    }),
]);

const hostileConversationPage = Object.freeze({
    type: 'conversation-viewer-page',
    version: 1,
    requestId: 1,
    subscriptionGeneration: 1,
    updateKind: 'initial',
    html: `<article data-message-id="message-hostile" data-interaction-id="input-4"
        data-unexpected="private" aria-label="private">
        <section onclick="window.__clicked = true" data-unexpected="private">
            <script>window.__executed = true</script>
            <a href="javascript:alert(1)">javascript</a>
            <a href="data:text/html,unsafe">data</a>
            <a href="file:///tmp/private">file</a>
            <a href="command:workbench.action.reloadWindow">command</a>
            <a href="http://example.test/insecure">http</a>
            <a href="https://example.test/safe">safe</a>
        </section>
    </article>`,
    outline: [{
        interactionId: 'input-4',
        userPreview: 'Hostile input',
        responseState: 'complete',
    }],
    selectedInteractionId: 'input-4',
    selectedInput: 4,
    totalInputs: 12,
    partial: false,
    atLatest: false,
    previousCursor: 'previous',
    nextCursor: 'next',
    stale: false,
});

let browser;

test.before(async () => {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
});

test.after(async () => {
    await browser.close();
});

async function openViewerPage(t, options = {}) {
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
    t.after(() => page.close());
    await page.setContent(`<!doctype html>
        <html>
            <body data-auto-scroll-threshold="8"
                data-subscription-generation="1"
                data-conversation-target='{"projectId":"project-1","provider":"codex","sessionId":"session-telemetry"}'>
                <header>
                    <span data-conversation-position>Input 0 of 0</span>
                    <button type="button" data-action="previous">Previous</button>
                    <button type="button" data-action="next">Next</button>
                    <button type="button" data-action="latest">Latest</button>
                    <button type="button" data-action="close">Close</button>
                </header>
                <section data-conversation-telemetry hidden>
                    <div data-telemetry-model hidden>
                        <span>Model</span>
                        <strong data-telemetry-model-value></strong>
                    </div>
                    <div data-telemetry-context hidden>
                        <span>Context</span>
                        <progress data-telemetry-context-progress
                            max="1" value="0"></progress>
                        <span data-telemetry-context-value></span>
                    </div>
                    <div data-telemetry-limits></div>
                </section>
                <div data-conversation-status aria-live="polite"></div>
                <div data-conversation-scroll tabindex="0"
                    style="height: 160px; overflow-y: auto">
                    <div data-conversation-messages></div>
                </div>
                <button type="button" data-new-response hidden>New response content</button>
            </body>
        </html>`);
    await page.evaluate(() => {
        window.__postedMessages = [];
        window.vscode = {
            postMessage(message) {
                window.__postedMessages.push(message);
            },
        };
    });
    if (options.trackResources) {
        await page.evaluate(() => {
            const metrics = {
                addEventListenerCalls: 0,
                removeEventListenerCalls: 0,
                createdObjectUrls: 0,
                revokedObjectUrls: 0,
            };
            const addEventListener = EventTarget.prototype.addEventListener;
            const removeEventListener =
                EventTarget.prototype.removeEventListener;
            const createObjectURL = URL.createObjectURL.bind(URL);
            const revokeObjectURL = URL.revokeObjectURL.bind(URL);
            EventTarget.prototype.addEventListener = function (...args) {
                metrics.addEventListenerCalls += 1;
                return addEventListener.apply(this, args);
            };
            EventTarget.prototype.removeEventListener = function (...args) {
                metrics.removeEventListenerCalls += 1;
                return removeEventListener.apply(this, args);
            };
            URL.createObjectURL = function (blob) {
                metrics.createdObjectUrls += 1;
                return createObjectURL(blob);
            };
            URL.revokeObjectURL = function (url) {
                metrics.revokedObjectUrls += 1;
                return revokeObjectURL(url);
            };
            window.__conversationResourceMetrics = metrics;
        });
    }
    await page.addScriptTag({ content: purifyScript });
    if (options.controlledMermaid) {
        await page.evaluate(() => {
            window.__mermaidRenders = [];
            window.mermaid = {
                initialize() {},
                render(id, source) {
                    return new Promise(resolve => {
                        window.__mermaidRenders.push({ id, source, resolve });
                    });
                },
            };
        });
    } else if (options.includeMermaid) {
        await page.addScriptTag({ content: mermaidScript });
    }
    await page.addScriptTag({ content: readingAnchorScript });
    await page.addScriptTag({ content: conversationMermaidScript });
    await page.addScriptTag({ content: conversationOutlineScript });
    await page.addScriptTag({ content: conversationTelemetryScript });
    await page.addScriptTag({ content: conversationCommentsScript });
    await page.addScriptTag({ content: conversationSidebarScript });
    await page.addScriptTag({ content: conversationReconcileScript });
    await page.addScriptTag({ content: viewerScript });
    await page.locator('script').evaluateAll(elements =>
        elements.forEach(element => element.remove()));
    return page;
}

async function postedMessages(page) {
    return page.evaluate(() => window.__postedMessages);
}

async function sendPage(page, payload) {
    await page.evaluate(message => window.dispatchEvent(
        new MessageEvent('message', { data: message })
    ), payload);
}

test('CONVERSATION-TELEMETRY-001 CONVERSATION-TELEMETRY-CONTROLLER-001 renders correlated model, context, and weekly quota updates in place', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-telemetry',
            model: 'gpt-5.6-sol',
            context: {
                usedTokens: 32_000,
                maxTokens: 128_000,
            },
            rateLimits: [{
                id: 'codex:secondary',
                label: 'Week',
                usedPercent: 40,
                windowDurationMins: 10_080,
                resetsAt: 2_000_000_000,
            }],
        },
    });

    assert.equal(
        await page.locator('[data-conversation-telemetry]').isVisible(),
        true
    );
    assert.equal(
        await page.locator('[data-telemetry-model-value]').textContent(),
        'gpt-5.6-sol'
    );
    assert.equal(
        await page.locator('[data-telemetry-context-value]').textContent(),
        '25% · 32.0k / 128k'
    );
    assert.match(
        await page.locator('[data-telemetry-limits]').textContent(),
        /Week.*60% left/
    );
    assert.equal(
        await page.locator('[data-telemetry-context-progress]')
            .getAttribute('max'),
        '128000'
    );

    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 0,
        subscriptionGeneration: 1,
        telemetry: null,
    });
    assert.equal(
        await page.locator('[data-conversation-telemetry]').isVisible(),
        true
    );
});

test('CONVERSATION-READING-FOCUS-001 keeps the reading viewport stable when telemetry appears asynchronously', async t => {
    const page = await openViewerPage(t);
    await page.addStyleTag({ content: `${viewerCss}\n${telemetryCss}` });
    await sendPage(page, {
        ...hostileConversationPage,
        html: messageHtml('telemetry-anchor', 12),
        updateKind: 'initial',
    });
    const anchor = page.locator('[data-message-id="telemetry-anchor-6"]');
    await anchor.evaluate(element => element.scrollIntoView({
        block: 'center',
    }));
    const anchorTopBefore = await anchor.evaluate(
        element => element.getBoundingClientRect().top
    );

    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-telemetry',
            model: 'gpt-5.6-sol',
            context: {
                usedTokens: 32_000,
                maxTokens: 128_000,
            },
            rateLimits: [{
                id: 'codex:secondary',
                label: 'Week',
                usedPercent: 40,
                windowDurationMins: 10_080,
                resetsAt: 2_000_000_000,
            }],
        },
    });
    const anchorTopAfter = await anchor.evaluate(
        element => element.getBoundingClientRect().top
    );

    assert.ok(
        Math.abs(anchorTopAfter - anchorTopBefore) <= 1,
        `telemetry moved the reading anchor from ${anchorTopBefore} to `
            + anchorTopAfter
    );

    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 1,
        telemetry: null,
    });
    const anchorTopAfterHide = await anchor.evaluate(
        element => element.getBoundingClientRect().top
    );
    assert.ok(
        Math.abs(anchorTopAfterHide - anchorTopBefore) <= 1,
        `hiding telemetry moved the reading anchor from ${anchorTopBefore}`
            + ` to ${anchorTopAfterHide}`
    );
});

function messageHtml(prefix, count, start = 0) {
    return Array.from({ length: count }, (_item, index) => {
        const id = `${prefix}-${start + index}`;
        return `<article data-message-id="${id}" data-interaction-id="${id}">
            <section><p>${id}</p></section>
        </article>`;
    }).join('');
}

function interactionHtml(prefix, count, responseLines, start = 0) {
    return Array.from({ length: count }, (_item, index) => {
        const interactionId = `${prefix}-${start + index}`;
        const response = Array.from(
            { length: responseLines },
            (_line, line) => `<p>${interactionId} response line ${line}</p>`
        ).join('');
        return `<article data-message-id="${interactionId}-user"
            data-interaction-id="${interactionId}">
            <section><p>${interactionId} prompt</p></section>
        </article>
        <article data-message-id="${interactionId}-assistant"
            data-interaction-id="${interactionId}">
            <section>${response}</section>
        </article>`;
    }).join('');
}

async function measureConversationEnd(page, lastMessageId) {
    return page.evaluate(messageId => {
        const scroll = document.querySelector('[data-conversation-scroll]');
        const last = document.querySelector(
            `[data-message-id="${messageId}"]`
        );
        const selected = document.querySelector(
            '.conversation-selected-interaction'
        );
        const bounds = scroll.getBoundingClientRect();
        const selectedBounds = selected
            ? selected.getBoundingClientRect()
            : null;
        return {
            hiddenBelow: Math.round(
                last.getBoundingClientRect().bottom - bounds.bottom
            ),
            distanceFromEnd: Math.round(
                scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop
            ),
            selectedVisible: !!selectedBounds
                && selectedBounds.bottom > bounds.top
                && selectedBounds.top < bounds.bottom,
        };
    }, lastMessageId);
}

function fakeHostUri(value) {
    return {
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    };
}

function loadHostConversationViewer() {
    const fakeVscode = {
        ViewColumn: { Active: 1, Beside: 2 },
        Uri: { parse: value => fakeHostUri(value) },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../out/aiSessions/conversation/viewer')
            .ConversationViewer;
    } finally {
        Module._load = previousLoad;
    }
}

async function renderHostViewerDocument(options = {}) {
    const ConversationViewer = loadHostConversationViewer();
    const interactionIds = options.interactionIds
        || ['input-1', 'input-2', 'input-3'];
    const interactionId = options.interactionId || 'input-2';
    const listeners = { message: new Set(), dispose: new Set(), view: new Set() };
    const panel = {
        visible: true,
        title: '',
        webview: {
            html: '',
            cspSource: 'https://viewer.test',
            onDidReceiveMessage(listener) {
                listeners.message.add(listener);
                return { dispose: () => listeners.message.delete(listener) };
            },
            postMessage() {
                return Promise.resolve(true);
            },
            asWebviewUri(uri) {
                return fakeHostUri(
                    `https://viewer.test/${path.basename(uri.fsPath)}`
                );
            },
        },
        reveal() {},
        onDidDispose(listener) {
            listeners.dispose.add(listener);
            return { dispose: () => listeners.dispose.delete(listener) };
        },
        onDidChangeViewState(listener) {
            listeners.view.add(listener);
            return { dispose: () => listeners.view.delete(listener) };
        },
        dispose() {
            Array.from(listeners.dispose).forEach(listener => listener());
        },
    };
    const viewer = new ConversationViewer({
        createPanel: () => panel,
        readOutline: async () => ({
            provider: 'codex',
            sessionId: 'session-host-document',
            sourceRevision: 'r1',
            interactions: interactionIds.map(id => ({
                id,
                userPreview: options.userPreviews?.[id] || id,
                userGraphemeCount: id.length,
                responseState: options.responseStates?.[id] || 'complete',
            })),
            totalInteractions: interactionIds.length,
            partial: false,
        }),
        readPage: async () => ({
            provider: 'codex',
            sessionId: 'session-host-document',
            sourceRevision: 'r1',
            anchorInteractionId: interactionId,
            messages: [{
                id: `${interactionId}:user`,
                interactionId,
                role: 'user',
                markdown: options.markdown
                    || '[safe](https://example.test/safe)',
            }],
            interactionStates: [{
                interactionId,
                responseState: 'complete',
            }],
            previousCursor: 'before-input-2',
            nextCursor: 'after-input-2',
            isStart: false,
            isEnd: false,
            ...options.pageOverrides,
        }),
        watch: () => ({ dispose() {} }),
        restoreFocus: () => {},
        openExternal: async () => true,
        mediaUri: fileName =>
            fakeHostUri(`file:///extension/media/${fileName}`),
        submitPrompt: options.submitPrompt || (async () => {}),
        bookmarkStore: options.bookmarkStore,
    });
    await viewer.open({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        interactionId,
        expectedRevision: 'r1',
        displayName: 'Host document',
        duplicateDisplayName: false,
    });
    return panel.webview.html;
}

async function openHostViewerDocument(t, options = {}) {
    const page = await browser.newPage({
        viewport: options.viewport || { width: 700, height: 500 },
    });
    t.after(() => page.close());
    const html = await renderHostViewerDocument(options);
    await page.route('https://viewer.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/purify.min.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: purifyScript,
            });
            return;
        }
        if (pathname === '/conversationViewerScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: viewerScript,
            });
            return;
        }
        if (pathname === '/conversationReadingAnchorScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: readingAnchorScript,
            });
            return;
        }
        if (pathname === '/conversationMermaidScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationMermaidScript,
            });
            return;
        }
        if (pathname === '/conversationOutlineScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationOutlineScript,
            });
            return;
        }
        if (pathname === '/conversationTelemetryScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationTelemetryScript,
            });
            return;
        }
        if (pathname === '/conversationCommentsScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationCommentsScript,
            });
            return;
        }
        if (pathname === '/conversationSidebarScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationSidebarScript,
            });
            return;
        }
        if (pathname === '/conversationReconcileScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationReconcileScript,
            });
            return;
        }
        if (pathname === '/mermaid.min.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: mermaidScript,
            });
            return;
        }
        if (pathname === '/conversationViewer.css') {
            await route.fulfill({
                contentType: 'text/css',
                body: options?.includeStyles
                    ? `${options.themeFixture.css}\n${viewerCss}`
                    : '',
            });
            return;
        }
        await route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.addInitScript(initialWebviewState => {
        window.__acquireCount = 0;
        window.__postedMessages = [];
        window.__webviewState = initialWebviewState || {};
        window.acquireVsCodeApi = () => {
            window.__acquireCount += 1;
            return {
                postMessage(message) {
                    window.__postedMessages.push(message);
                },
                getState() {
                    return window.__webviewState;
                },
                setState(next) {
                    window.__webviewState = next;
                },
            };
        };
    }, options.initialWebviewState);
    await page.goto('https://viewer.test/');
    return { page };
}

function decodeInitialPublication(html) {
    const match = html.match(/data-initial-page="([^"]+)"/);
    assert.ok(match, 'Host document must contain an initial publication');
    return JSON.parse(match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&'));
}

async function realHostAppendPublications() {
    const ConversationViewer = loadHostConversationViewer();
    const postedMessages = [];
    const messageListeners = new Set();
    const disposeListeners = new Set();
    const viewStateListeners = new Set();
    const panel = {
        visible: true,
        title: '',
        webview: {
            html: '',
            cspSource: 'fixture-csp',
            onDidReceiveMessage(listener) {
                messageListeners.add(listener);
                return { dispose: () => messageListeners.delete(listener) };
            },
            postMessage(message) {
                postedMessages.push(message);
                return Promise.resolve(true);
            },
            asWebviewUri(uri) {
                return uri;
            },
        },
        reveal() {},
        onDidDispose(listener) {
            disposeListeners.add(listener);
            return { dispose: () => disposeListeners.delete(listener) };
        },
        onDidChangeViewState(listener) {
            viewStateListeners.add(listener);
            return { dispose: () => viewStateListeners.delete(listener) };
        },
        dispose() {
            Array.from(disposeListeners).forEach(listener => listener());
        },
    };
    let revision = 1;
    let onChange;
    const firstIds = Array.from(
        { length: 20 },
        (_item, index) => `host-input-${index + 1}`
    );
    const secondIds = Array.from(
        { length: 20 },
        (_item, index) => `host-input-${index + 2}`
    );
    const viewer = new ConversationViewer({
        createPanel: () => panel,
        readOutline: async () => ({
            provider: 'codex',
            sessionId: 'session-host',
            sourceRevision: `r${revision}`,
            interactions: (
                revision === 1 ? firstIds : firstIds.concat('host-input-21')
            ).map(id => ({
                id,
                userPreview: id,
                userGraphemeCount: id.length,
                responseState: 'complete',
            })),
            totalInteractions: revision === 1 ? 20 : 21,
            partial: false,
        }),
        readPage: async request => {
            const interactionIds = revision === 1 ? firstIds : secondIds;
            return {
                provider: 'codex',
                sessionId: 'session-host',
                sourceRevision: request.expectedRevision,
                anchorInteractionId: request.anchorInteractionId,
                messages: interactionIds.map(id => ({
                    id: `${id}:user`,
                    interactionId: id,
                    role: 'user',
                    markdown: `content-${id}`,
                })),
                interactionStates: interactionIds.map(id => ({
                    interactionId: id,
                    responseState: 'complete',
                })),
                previousCursor: revision === 1 ? undefined : 'r2-before',
                nextCursor: undefined,
                isStart: revision === 1,
                isEnd: true,
            };
        },
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        restoreFocus() {},
        openExternal: async () => true,
        mediaUri: fileName => fakeHostUri(`file:///media/${fileName}`),
        submitPrompt: async () => {},
    });

    await viewer.open({
        projectId: 'project-host',
        provider: 'codex',
        sessionId: 'session-host',
        interactionId: 'host-input-20',
        expectedRevision: 'r1',
        displayName: 'Host conversation',
        duplicateDisplayName: false,
    });
    const initial = decodeInitialPublication(panel.webview.html);
    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    const refresh = postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    viewer.dispose();
    return { initial, refresh };
}

function assertMessageFillsReadingArea(message, name, messagesBounds) {
    const tolerance = 1;
    assert.ok(
        Math.abs(message.left - messagesBounds.left) <= tolerance,
        `${name} message must fill the reading area's left edge`
    );
    assert.ok(
        Math.abs(message.right - messagesBounds.right) <= tolerance,
        `${name} message must fill the reading area's right edge`
    );
}

function assertConversationEmphasisTheme(styles, fixture) {
    assert.equal(
        styles.userBodyColor,
        fixture.tokens.editorForeground,
        `User body must use the ${fixture.name} editor foreground`
    );
    assert.equal(
        styles.assistantBodyColor,
        fixture.tokens.editorForeground,
        `Assistant body must use the ${fixture.name} editor foreground`
    );
    assert.equal(
        styles.assistantRoleColor,
        fixture.tokens.descriptionForeground,
        `Assistant role must use the ${fixture.name} muted description foreground`
    );
    assert.equal(
        styles.userRoleColor,
        fixture.tokens.buttonForeground,
        `User pill foreground must use the ${fixture.name} button foreground`
    );
    assert.equal(
        styles.userRoleBackground,
        fixture.tokens.buttonBackground,
        `User pill background must use the ${fixture.name} button background`
    );
    assert.equal(
        styles.userBackground,
        fixture.tokens.inputBackground,
        `User surface must use the ${fixture.name} input background`
    );
    assertMessageFillsReadingArea(
        styles.userBounds,
        'User',
        styles.messagesBounds
    );
    assertMessageFillsReadingArea(
        styles.assistantBounds,
        'Assistant',
        styles.messagesBounds
    );
    for (const [name, textAlign] of [
        ['User', styles.userTextAlign],
        ['Assistant', styles.assistantTextAlign],
    ]) {
        assert.ok(
            textAlign !== 'right' && textAlign !== 'end',
            `${name} message must not be right/end aligned`
        );
    }
}

function assertConversationEmphasisForcedColors(styles) {
    assert.deepEqual(styles.userPerimeterWidths, {
        top: 1,
        right: 1,
        bottom: 1,
        left: 4,
    });
    assert.deepEqual(styles.userRoleBorderWidths, {
        top: 1,
        right: 1,
        bottom: 1,
        left: 1,
    });
    assert.deepEqual(styles.userRoleBorderStyles, {
        top: 'solid',
        right: 'solid',
        bottom: 'solid',
        left: 'solid',
    });
    assert.notEqual(
        styles.userRoleColor,
        styles.userRoleBackground,
        'forced-colors User pill foreground and background must remain distinct'
    );
    assert.equal(styles.assistantSeparatorWidth, 1);
}

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 acquires one real document API and posts every control action', async t => {
    const { page } = await openHostViewerDocument(t);

    assert.equal(await page.evaluate(() => window.__acquireCount), 1);
    await page.getByRole('button', { name: 'Previous' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Latest' }).click();
    await page.locator('a[href="https://example.test/safe"]').click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    assert.deepEqual(await postedMessages(page), [
        { type: 'conversation-viewer-previous', version: 1 },
        { type: 'conversation-viewer-next', version: 1 },
        { type: 'conversation-viewer-latest', version: 1 },
        {
            type: 'conversation-viewer-open-link',
            version: 1,
            href: 'https://example.test/safe',
        },
        { type: 'conversation-viewer-closed', version: 1 },
    ]);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 keeps disabled real document navigation controls inert', async t => {
    const { page } = await openHostViewerDocument(t, {
        interactionIds: ['input-only'],
        interactionId: 'input-only',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    const navigation = ['Previous', 'Next', 'Latest'].map(name =>
        page.getByRole('button', { name })
    );

    assert.equal(await page.evaluate(() => window.__acquireCount), 1);
    for (const button of navigation) {
        assert.equal(await button.isDisabled(), true);
    }
    assert.deepEqual(await postedMessages(page), []);

    for (const button of navigation) {
        await button.evaluate(element => element.click());
    }
    assert.deepEqual(await postedMessages(page), []);
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 filters the current Session outline and posts exact pointer and keyboard navigation', async t => {
    const interactionIds = ['input-1', 'input-2', 'input-3', 'input-4'];
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 1050, height: 620 },
        interactionIds,
        interactionId: 'input-2',
        userPreviews: {
            'input-1': 'Plan the release',
            'input-2': 'Fix conversation navigation',
            'input-3': 'Deploy the extension',
            'input-4': '<script>unsafe</script> remains text',
        },
        responseStates: {
            'input-3': 'inProgress',
            'input-4': 'interrupted',
        },
    });
    const sidebar = page.locator('[data-conversation-sidebar]');
    const outline = page.locator('[data-conversation-outline]');
    const comments = page.locator('[data-conversation-comments]');
    const outlineToggle = page.locator('[data-action="toggle-outline"]');
    const commentsToggle = page.locator('[data-action="toggle-comments"]');

    assert.equal(await sidebar.isVisible(), true);
    assert.equal(await outline.isVisible(), true);
    assert.equal(await comments.isHidden(), true);
    assert.equal(await outlineToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-outline-interaction-id]').count(), 4);
    assert.equal(
        await page.locator(
            '[data-outline-interaction-id="input-2"]'
        ).getAttribute('aria-current'),
        'location'
    );
    assert.match(await outline.innerText(), /<script>unsafe<\/script>/);
    assert.equal(await outline.locator('script').count(), 0);

    await page.locator('[data-outline-search]').fill('deploy');
    assert.equal(
        await page.locator('[data-outline-interaction-id]:visible').count(),
        1
    );
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState),
        {
            conversationSidebar: {
                open: true,
                width: 240,
                view: 'outline',
                query: 'deploy',
            },
        }
    );
    await page.locator('[data-outline-search]').fill('');

    const selected = page.locator(
        '[data-outline-interaction-id="input-2"]'
    );
    await selected.focus();
    await selected.press('ArrowDown');
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute(
                'data-outline-interaction-id'
            )),
        'input-3'
    );
    await page.keyboard.press('Enter');
    let requests = await postedMessages(page);
    assert.deepEqual(requests.at(-1), {
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-3',
    });

    await page.locator(
        '[data-outline-interaction-id="input-4"]'
    ).click();
    requests = await postedMessages(page);
    assert.deepEqual(requests.at(-1), {
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-4',
    });

    const outlineTab = page.locator('[data-sidebar-tab="outline"]');
    await outlineTab.focus();
    await outlineTab.press('ArrowRight');
    assert.equal(await outline.isHidden(), true);
    assert.equal(await comments.isVisible(), true);
    assert.equal(await commentsToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await sidebar.isVisible(), true);
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute('data-sidebar-tab')
        ),
        'comments'
    );
    await page.keyboard.press('Escape');
    assert.equal(await sidebar.isHidden(), true);
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute('data-action')
        ),
        'toggle-comments'
    );
    await outlineToggle.click();
    assert.equal(await outline.isVisible(), true);
    assert.equal(await comments.isHidden(), true);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 settles stars authoritatively, filters favorites, and preserves input order', async t => {
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 1050, height: 620 },
        interactionIds,
        interactionId: 'input-2',
        bookmarkStore: {
            async load() {
                return { revision: 3, interactionIds: ['input-3'] };
            },
            async save() {},
        },
    });
    const orderedIds = () => page.locator(
        '[data-outline-interaction-id]'
    ).evaluateAll(elements => elements.map(element =>
        element.getAttribute('data-outline-interaction-id')
    ));
    const inputOneStar = page.locator(
        '[data-outline-bookmark-id="input-1"]'
    );

    assert.deepEqual(await orderedIds(), interactionIds);
    const leftGeometry = await page.evaluate(() => {
        const outline = document.querySelector('[data-conversation-outline]');
        const star = document.querySelector(
            '[data-outline-bookmark-id="input-1"]'
        );
        const preview = document.querySelector(
            '[data-outline-interaction-id="input-1"]'
        )?.querySelector('.conversation-outline-preview');
        return {
            starInset: star.getBoundingClientRect().left
                - outline.getBoundingClientRect().left,
            previewInset: preview.getBoundingClientRect().left
                - outline.getBoundingClientRect().left,
        };
    });
    assert.ok(
        leftGeometry.previewInset <= 48,
        `outline text should stay compact, got ${leftGeometry.previewInset}px`
    );
    assert.ok(
        leftGeometry.starInset <= 6,
        `bookmark star should hug the left edge, got ${leftGeometry.starInset}px`
    );
    assert.equal(await inputOneStar.getAttribute('aria-pressed'), 'false');
    assert.equal(
        await page.locator(
            '[data-outline-bookmark-id="input-3"]'
        ).getAttribute('aria-pressed'),
        'true'
    );

    await inputOneStar.click();
    assert.equal(
        await inputOneStar.getAttribute('aria-pressed'),
        'false',
        'the star must not update optimistically'
    );
    let requests = await postedMessages(page);
    const requestId = requests.at(-1).requestId;
    assert.match(requestId, /^conversation-bookmark:[a-z0-9]+:1$/);
    assert.deepEqual(requests.at(-1), {
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        operation: 'set',
        expectedRevision: 3,
        payload: {
            interactionId: 'input-1',
            bookmarked: true,
        },
    });
    assert.equal(
        requests.some(message =>
            message.type === 'conversation-viewer-select-interaction'),
        false,
        'clicking a star must not navigate'
    );

    await page.evaluate(settlementRequestId => window.postMessage({
        type: 'conversation-viewer-bookmarks-result',
        version: 1,
        requestId: settlementRequestId,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        operation: 'set',
        success: true,
        revision: 4,
        interactionIds: ['input-3', 'input-1'],
    }, '*'), requestId);
    await page.waitForFunction(() =>
        document.querySelector(
            '[data-outline-bookmark-id="input-1"]'
        )?.getAttribute('aria-pressed') === 'true'
    );
    assert.equal(await inputOneStar.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(await orderedIds(), interactionIds);

    await page.locator('[data-outline-bookmarks-only]').click();
    assert.equal(
        await page.locator('[data-outline-interaction-id]:visible').count(),
        2
    );
    assert.deepEqual(
        await page.locator(
            '[data-outline-interaction-id]:visible'
        ).evaluateAll(elements => elements.map(element =>
            element.getAttribute('data-outline-interaction-id')
        )),
        ['input-1', 'input-3']
    );
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 CONVERSATION-COMMENTS-LAYOUT-001 shares one resizable and responsive Outline or Comments panel', async t => {
    const options = {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 1100, height: 600 },
        interactionIds: ['input-layout'],
        interactionId: 'input-layout',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    };
    const { page } = await openHostViewerDocument(t, options);
    const outlineToggle = page.locator('[data-action="toggle-outline"]');
    const commentsToggle = page.locator('[data-action="toggle-comments"]');
    const panel = page.locator('[data-conversation-sidebar]');
    const comments = page.locator('[data-conversation-comments]');
    const resizer = page.locator('[data-comments-resizer]');

    assert.equal(await outlineToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await commentsToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await comments.isHidden(), true);
    assert.equal(await resizer.getAttribute('aria-valuenow'), '240');

    await resizer.press('ArrowLeft');
    await resizer.press('ArrowLeft');
    assert.equal(await resizer.getAttribute('aria-valuenow'), '272');
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState),
        {
            conversationSidebar: {
                open: true,
                width: 272,
                view: 'outline',
                query: '',
            },
        }
    );

    await outlineToggle.click();
    assert.equal(await outlineToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.isHidden(), true);
    assert.equal(await resizer.isHidden(), true);
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState),
        {
            conversationSidebar: {
                open: false,
                width: 272,
                view: 'outline',
                query: '',
            },
        }
    );

    const restored = await openHostViewerDocument(t, {
        ...options,
        initialWebviewState: {
            conversationCommentsPanel: { open: false, width: 312 },
        },
    });
    const restoredToggle = restored.page.locator(
        '[data-action="toggle-comments"]'
    );
    assert.equal(await restoredToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(
        await restored.page.locator('[data-conversation-sidebar]').isHidden(),
        true
    );
    await restoredToggle.click();
    assert.equal(
        await restored.page.locator('[data-conversation-comments]').isVisible(),
        true
    );
    assert.equal(
        await restored.page.locator('[data-comments-resizer]')
            .getAttribute('aria-valuenow'),
        '312'
    );

    const narrow = await openHostViewerDocument(t, {
        ...options,
        viewport: { width: 700, height: 600 },
        initialWebviewState: {
            conversationSidebar: {
                open: true, width: 240, view: 'comments', query: '',
            },
        },
    });
    assert.deepEqual(
        await narrow.page.evaluate(() => {
            const workspace = document.querySelector(
                '.conversation-workspace'
            ).getBoundingClientRect();
            const conversation = document.querySelector(
                '[data-conversation-scroll]'
            ).getBoundingClientRect();
            const sidebar = document.querySelector(
                '[data-conversation-sidebar]'
            ).getBoundingClientRect();
            return {
                sidebarRightAligned:
                    Math.abs(sidebar.right - workspace.right) < 1,
                sidebarOverConversation:
                    sidebar.left < conversation.right,
                conversationUsesWorkspace:
                    Math.abs(conversation.right - workspace.right) < 1,
            };
        }),
        {
            sidebarRightAligned: true,
            sidebarOverConversation: true,
            conversationUsesWorkspace: true,
        }
    );
    assert.equal(
        await narrow.page.locator('[data-comments-resizer]').isVisible(),
        true
    );

    const extraNarrow = await openHostViewerDocument(t, {
        ...options,
        viewport: { width: 180, height: 600 },
        initialWebviewState: {
            conversationSidebar: {
                open: true, width: 240, view: 'comments', query: '',
            },
        },
    });
    assert.deepEqual(
        await extraNarrow.page.evaluate(() => {
            const comments = document.querySelector(
                '[data-conversation-sidebar]'
            ).getBoundingClientRect();
            return {
                leftVisible: comments.left >= 0,
                rightVisible: comments.right <= window.innerWidth,
            };
        }),
        {
            leftVisible: true,
            rightVisible: true,
        }
    );
});

test('CONVERSATION-COMMENTS-DOM-STABILITY-001 keeps the Conversation DOM intact across 100 panel toggles and resizes', async t => {
    const interactionId = 'input-panel-stability';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 1100, height: 600 },
        interactionIds: [interactionId],
        interactionId,
        markdown: '[Stable reading link](https://example.com/stable)',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    const baseline = await page.evaluate(() => {
        const root = document.querySelector('[data-conversation-messages]');
        window.__panelStableConversationRoot = root;
        window.__panelStableConversationNodes = Array.from(
            root.querySelectorAll('*')
        );
        window.__panelStableMutations = 0;
        const observer = new MutationObserver(records => {
            window.__panelStableMutations += records.filter(record =>
                record.type === 'childList'
            ).length;
        });
        observer.observe(root, { childList: true, subtree: true });
        window.__panelStableObserver = observer;
        return { nodeCount: window.__panelStableConversationNodes.length };
    });

    await page.evaluate(() => {
        const outlineToggle = document.querySelector(
            '[data-action="toggle-outline"]'
        );
        const commentsToggle = document.querySelector(
            '[data-action="toggle-comments"]'
        );
        const resizer = document.querySelector('[data-comments-resizer]');
        for (let index = 0; index < 100; index += 1) {
            commentsToggle.click();
            resizer.dispatchEvent(new KeyboardEvent('keydown', {
                key: index % 2 === 0 ? 'ArrowLeft' : 'ArrowRight',
                bubbles: true,
            }));
            outlineToggle.click();
        }
    });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    assert.deepEqual(await page.evaluate(() => {
        const root = document.querySelector('[data-conversation-messages]');
        const nodes = Array.from(root.querySelectorAll('*'));
        window.__panelStableObserver.disconnect();
        return {
            sameRoot: root === window.__panelStableConversationRoot,
            sameNodes: nodes.length
                === window.__panelStableConversationNodes.length
                && nodes.every((node, index) =>
                    node === window.__panelStableConversationNodes[index]),
            nodeCount: nodes.length,
            mutations: window.__panelStableMutations,
        };
    }), {
        sameRoot: true,
        sameNodes: true,
        nodeCount: baseline.nodeCount,
        mutations: 0,
    });
});

test('CONVERSATION-COMMENTS-UI-001 adds a session-wide note without selecting conversation text', async t => {
    const interactionId = 'input-session-note';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationSidebar: {
                open: true,
                width: 240,
                view: 'comments',
                query: '',
            },
        },
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });

    const newNote = page.locator('[data-comment-action="new"]');
    assert.equal(await newNote.isVisible(), true);
    await newNote.click();
    assert.equal(
        await page.locator('[data-comment-selection]').textContent(),
        'Session note'
    );
    await page.locator('[data-comment-input]').fill(
        'Remember the rollout constraint.'
    );
    await page.locator('[data-comment-input]').press('Control+Enter');
    const request = (await postedMessages(page)).at(-1);
    assert.equal(request.type, 'conversation-viewer-comment-mutation');
    assert.equal(request.operation, 'add');
    assert.deepEqual(request.payload, {
        scope: 'session',
        comment: 'Remember the rollout constraint.',
    });

    const comment = {
        id: 'session-note-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Remember the rollout constraint.',
        status: 'open',
    };
    await page.evaluate(({ request, comment }) => {
        window.dispatchEvent(new MessageEvent('message', {
            data: {
                type: 'conversation-viewer-comments-result',
                version: 1,
                requestId: request.requestId,
                subscriptionGeneration: request.subscriptionGeneration,
                projectId: request.projectId,
                provider: request.provider,
                sessionId: request.sessionId,
                operation: request.operation,
                success: true,
                revision: 1,
                comments: [comment],
            },
        }));
    }, { request, comment });

    const card = page.locator('[data-comment-id="session-note-1"]');
    assert.equal(await card.getAttribute('data-comment-scope'), 'session');
    assert.equal(
        await card.locator('.conversation-comment-scope').textContent(),
        'Session note'
    );
    assert.equal(
        await card.locator('[data-comment-action="locate"]').count(),
        0
    );
    assert.equal(await card.locator('blockquote').count(), 0);
});

test('CONVERSATION-COMMENTS-UI-001 CONVERSATION-COMMENTS-REVIEW-001 CONVERSATION-COMMENTS-BULK-001 CONVERSATION-COMMENTS-LAYOUT-001 reviews contained cards and Host-owned comment batches', async t => {
    const interactionId = 'input-comments';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 600 },
        initialWebviewState: {
            conversationCommentsPanel: { open: true, width: 192 },
        },
        interactionIds: [interactionId],
        interactionId,
        markdown: 'Alpha beta gamma beta delta.',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });

    async function selectText(text, occurrence = 0) {
        const selectionState = await page.locator('.conversation-markdown').evaluate((element, selectionTarget) => {
            const node = element.querySelector('p').firstChild;
            let start = -1;
            let searchFrom = 0;
            for (let index = 0; index <= selectionTarget.occurrence; index += 1) {
                start = node.nodeValue.indexOf(
                    selectionTarget.text,
                    searchFrom
                );
                searchFrom = start + selectionTarget.text.length;
            }
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + selectionTarget.text.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
            return {
                selected: selection.toString(),
                initialCommentsConsumed:
                    !document.body.hasAttribute('data-initial-comments'),
                targetConsumed:
                    !document.body.hasAttribute('data-conversation-target'),
            };
        }, { text, occurrence });
        await page.waitForTimeout(20);
        const capturedState = await page.evaluate(() => {
            const selection = window.getSelection();
            const range = selection && selection.rangeCount
                ? selection.getRangeAt(0)
                : null;
            const startElement = range && (range.startContainer.nodeType === Node.ELEMENT_NODE
                ? range.startContainer
                : range.startContainer.parentElement);
            const endElement = range && (range.endContainer.nodeType === Node.ELEMENT_NODE
                ? range.endContainer
                : range.endContainer.parentElement);
            const selector =
                '[data-conversation-message-id],[data-message-id]';
            const startMessage = startElement?.closest?.(selector);
            const endMessage = endElement?.closest?.(selector);
            return {
                selected: selection?.toString(),
                sameMessage: !!startMessage && startMessage === endMessage,
                hasMarkdown: !!startElement?.closest?.('.conversation-markdown'),
                article: startElement?.closest?.('article')?.outerHTML,
                inMessages: !!startMessage
                    && document.querySelector('[data-conversation-messages]')
                        .contains(startMessage),
                addHidden: document.querySelector('[data-add-comment]').hidden,
            };
        });
        assert.equal(
            await page.locator('[data-add-comment]').isVisible(),
            true,
            JSON.stringify({ selectionState, capturedState })
        );
        await page.locator('[data-add-comment]').click();
    }

    async function settle(request, revision, comments) {
        await page.evaluate(({ request, revision, comments }) => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'conversation-viewer-comments-result',
                    version: 1,
                    requestId: request.requestId,
                    subscriptionGeneration: request.subscriptionGeneration,
                    projectId: request.projectId,
                    provider: request.provider,
                    sessionId: request.sessionId,
                    operation: request.operation,
                    success: true,
                    revision,
                    comments,
                },
            }));
        }, { request, revision, comments });
    }

    async function settleLocate(request, success = true) {
        await page.evaluate(({ request, success }) => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'conversation-viewer-locate-comment-result',
                    version: 1,
                    requestId: request.requestId,
                    subscriptionGeneration: request.subscriptionGeneration,
                    projectId: request.projectId,
                    provider: request.provider,
                    sessionId: request.sessionId,
                    commentId: request.commentId,
                    success,
                    ...(success ? {} : { error: 'stale' }),
                },
            }));
        }, { request, success });
    }

    const comments = [];
    await selectText('beta', 1);
    await page.locator('[data-comment-input]').fill('Explain beta.');
    assert.equal(
        await page.locator('[data-comment-input]').getAttribute(
            'aria-keyshortcuts'
        ),
        'Control+Enter Meta+Enter'
    );
    await page.locator('[data-comment-input]').press('Control+Enter');
    let requests = await postedMessages(page);
    const first = requests.at(-1);
    assert.equal(first.type, 'conversation-viewer-comment-mutation');
    assert.equal(first.operation, 'add');
    assert.equal(first.expectedRevision, 0);
    assert.equal(first.projectId, 'project-a');
    assert.equal(first.sessionId, 'session-host-document');
    comments.push({
        id: 'comment-1',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'beta',
        prefix: 'Alpha beta gamma ',
        suffix: ' delta.',
        comment: 'Explain beta.',
        status: 'open',
    });
    await settle(first, 1, comments);
    assert.deepEqual(
        await page.evaluate(() => {
            const highlight = window.CSS?.highlights?.get(
                'conversation-comments'
            );
            return highlight
                ? Array.from(highlight).map(range => ({
                    text: range.toString(),
                    startOffset: range.startOffset,
                }))
                : [];
        }),
        [{ text: 'beta', startOffset: 17 }]
    );

    await selectText('gamma');
    await page.locator('[data-comment-input]').fill('Change gamma.');
    await page.locator('[data-comment-input]').press('Meta+Enter');
    requests = await postedMessages(page);
    const second = requests.at(-1);
    assert.equal(second.expectedRevision, 1);
    comments.push({
        id: 'comment-2',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'gamma',
        prefix: 'Alpha beta ',
        suffix: ' beta delta.',
        comment: 'Change gamma.',
        status: 'open',
    });
    await settle(second, 2, comments);

    assert.equal(await page.locator('[data-comment-id]').count(), 2);
    assert.equal(await page.locator('[data-comment-count]').textContent(), '2');
    assert.equal(
        await page.locator('[data-action="toggle-comments"]').textContent(),
        'Comments (2 open)'
    );
    const commentToolbar = page.locator('[data-comments-toolbar]');
    assert.equal(await commentToolbar.count(), 1);
    assert.equal(
        await commentToolbar.locator('[data-comment-action]').count(),
        4
    );
    const commentToolbarHeight = await commentToolbar.evaluate(element =>
        element.getBoundingClientRect().height
    );
    assert.ok(
        commentToolbarHeight <= 64,
        `comment toolbar height ${commentToolbarHeight}px must remain compact`
    );
    assert.deepEqual(
        await page.locator('[data-comment-id]').evaluateAll(cards =>
            cards.map(card => {
                const bounds = card.getBoundingClientRect();
                const controls = Array.from(card.querySelectorAll('button'));
                return {
                    cardContained: card.scrollWidth <= card.clientWidth,
                    controlsContained: controls.every(control => {
                        const controlBounds = control.getBoundingClientRect();
                        return controlBounds.left >= bounds.left
                            && controlBounds.right <= bounds.right;
                    }),
                    actionsWrap: getComputedStyle(
                        card.querySelector('.conversation-comment-actions')
                    ).flexWrap,
                };
            })
        ),
        [{
            cardContained: true,
            controlsContained: true,
            actionsWrap: 'wrap',
        }, {
            cardContained: true,
            controlsContained: true,
            actionsWrap: 'wrap',
        }]
    );

    await selectText('delta');
    assert.deepEqual(
        await page.evaluate(() => {
            const composer = document.querySelector(
                '[data-comment-composer]'
            );
            const actions = composer.querySelector(
                '.conversation-comment-actions'
            );
            const firstCard = document.querySelector('[data-comment-id]');
            const composerBounds = composer.getBoundingClientRect();
            const actionsBounds = actions.getBoundingClientRect();
            const firstCardBounds = firstCard.getBoundingClientRect();
            return {
                contentUnclipped:
                    composer.scrollHeight <= composer.clientHeight,
                actionsContained:
                    actionsBounds.top >= composerBounds.top
                    && actionsBounds.bottom <= composerBounds.bottom,
                clearOfFirstCard:
                    composerBounds.bottom <= firstCardBounds.top,
            };
        }),
        {
            contentUnclipped: true,
            actionsContained: true,
            clearOfFirstCard: true,
        }
    );
    await page.locator('[data-comment-action="cancel-add"]').click();

    await page.setViewportSize({ width: 180, height: 600 });
    assert.deepEqual(
        await page.locator('[data-comment-id]').evaluateAll(cards =>
            cards.map(card => {
                const bounds = card.getBoundingClientRect();
                return {
                    leftVisible: bounds.left >= 0,
                    rightVisible: bounds.right <= window.innerWidth,
                    contentContained: card.scrollWidth <= card.clientWidth,
                };
            })
        ),
        [{
            leftVisible: true,
            rightVisible: true,
            contentContained: true,
        }, {
            leftVisible: true,
            rightVisible: true,
            contentContained: true,
        }]
    );
    await page.setViewportSize({ width: 850, height: 600 });

    await sendPage(page, {
        type: 'conversation-viewer-page',
        version: 1,
        requestId: 100,
        subscriptionGeneration: 1,
        updateKind: 'navigation',
        html: `<article data-conversation-message-id="other%3Auser"
            data-interaction-id="other">
            <section class="conversation-markdown"><p>Other input.</p></section>
        </article>`,
        outline: [{
            interactionId: 'other',
            userPreview: 'Other input',
            responseState: 'complete',
        }],
        selectedInteractionId: 'other',
        selectedInput: 2,
        totalInputs: 2,
        partial: false,
        atLatest: true,
        stale: false,
    });
    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="locate"]').click();
    requests = await postedMessages(page);
    const locate = requests.at(-1);
    assert.equal(locate.type, 'conversation-viewer-locate-comment');
    assert.equal(locate.commentId, 'comment-1');
    assert.equal(locate.projectId, 'project-a');
    assert.equal(
        await page.locator('[data-conversation-comments]').getAttribute(
            'aria-busy'
        ),
        'true'
    );
    assert.equal(
        await page.locator('[data-comment-action="send"]').isDisabled(),
        true
    );

    await sendPage(page, {
        type: 'conversation-viewer-page',
        version: 1,
        requestId: 101,
        subscriptionGeneration: 1,
        updateKind: 'navigation',
        html: `<article data-conversation-message-id="${
            encodeURIComponent(`${interactionId}:user`)
        }"
            data-interaction-id="${interactionId}">
            <section class="conversation-markdown">
                <p>Alpha beta gamma beta delta.</p>
            </section>
        </article>`,
        outline: [{
            interactionId,
            userPreview: 'Alpha beta gamma beta delta.',
            responseState: 'complete',
        }],
        selectedInteractionId: interactionId,
        selectedInput: 1,
        totalInputs: 2,
        partial: false,
        atLatest: false,
        stale: false,
    });
    assert.match(
        await page.locator('[data-conversation-messages]').innerHTML(),
        /Alpha beta gamma beta delta\./
    );
    await settleLocate(locate);
    assert.equal(
        await page.locator(`[data-interaction-id="${interactionId}"]`)
            .evaluate(element => document.activeElement === element),
        true
    );
    assert.equal(
        await page.locator('[data-conversation-comments]').getAttribute(
            'aria-busy'
        ),
        'false'
    );

    await page.locator('[data-comment-action="send"]').click();
    requests = await postedMessages(page);
    const send = requests.at(-1);
    assert.equal(send.type, 'conversation-viewer-send-comments');
    assert.equal(send.operation, 'sendComments');
    assert.equal(send.expectedRevision, 2);
    assert.deepEqual(send.payload, {});
    comments.forEach(comment => {
        comment.status = 'sent';
    });
    await settle(send, 3, comments);

    assert.equal(await page.locator('[data-comment-id]').count(), 2);
    assert.deepEqual(
        await page.locator('[data-comment-status-label]').allTextContents(),
        ['Added', 'Added']
    );
    assert.equal(
        await page.locator('[data-comment-action="send"]').isDisabled(),
        true
    );
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'Comments added to session input. Review and press Enter to send.'
    );

    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="resolve"]').click();
    requests = await postedMessages(page);
    const resolve = requests.at(-1);
    assert.equal(resolve.operation, 'resolve');
    comments[0].status = 'resolved';
    await settle(resolve, 4, comments);
    assert.equal(
        await page.locator('[data-comment-id="comment-1"]')
            .getAttribute('data-comment-status'),
        'resolved'
    );

    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="reopen"]').click();
    requests = await postedMessages(page);
    const reopen = requests.at(-1);
    assert.equal(reopen.operation, 'reopen');
    comments[0].status = 'open';
    await settle(reopen, 5, comments);
    assert.equal(
        await page.locator('[data-action="toggle-comments"]').textContent(),
        'Comments (1 open)'
    );
    assert.equal(
        await page.locator('[data-comment-action="send"]').isEnabled(),
        true
    );

    await page.locator('[data-comment-action="clearSent"]').click();
    requests = await postedMessages(page);
    const clearSent = requests.at(-1);
    assert.equal(clearSent.operation, 'clearSent');
    assert.equal(clearSent.expectedRevision, 5);
    assert.deepEqual(clearSent.payload, {});
    comments.splice(1, 1);
    await settle(clearSent, 6, comments);
    assert.deepEqual(
        await page.locator('[data-comment-status-label]').allTextContents(),
        ['Open']
    );

    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="resolve"]').click();
    requests = await postedMessages(page);
    const resolveRemaining = requests.at(-1);
    comments[0].status = 'resolved';
    await settle(resolveRemaining, 7, comments);

    await page.locator('[data-comment-action="clearResolved"]').click();
    requests = await postedMessages(page);
    const clearResolved = requests.at(-1);
    assert.equal(clearResolved.operation, 'clearResolved');
    assert.equal(clearResolved.expectedRevision, 7);
    comments.splice(0);
    await settle(clearResolved, 8, comments);
    assert.equal(await page.locator('[data-comment-id]').count(), 0);

    await selectText('gamma');
    await page.locator('[data-comment-input]').fill('Check gamma again.');
    await page.locator('[data-comment-input]').press('Control+Enter');
    requests = await postedMessages(page);
    const third = requests.at(-1);
    comments.push({
        id: 'comment-3',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'gamma',
        prefix: 'Alpha beta ',
        suffix: ' beta delta.',
        comment: 'Check gamma again.',
        status: 'open',
    });
    await settle(third, 9, comments);

    const messageCountBeforeConfirmation = (await postedMessages(page)).length;
    await page.locator('[data-comment-action="clearAll"]').click();
    assert.equal(
        (await postedMessages(page)).length,
        messageCountBeforeConfirmation
    );
    assert.equal(
        await page.locator('[data-comment-action="clearAll"]').textContent(),
        'Confirm clear all'
    );
    await page.locator('[data-comment-action="clearAll"]').click();
    requests = await postedMessages(page);
    const clearAll = requests.at(-1);
    assert.equal(clearAll.operation, 'clearAll');
    assert.equal(clearAll.expectedRevision, 9);
    assert.deepEqual(clearAll.payload, {});
    comments.splice(0);
    await settle(clearAll, 10, comments);
    assert.equal(await page.locator('[data-comment-id]').count(), 0);
    assert.equal(
        await page.locator('[data-comment-action="clearAll"]').isDisabled(),
        true
    );
});

test('CONVERSATION-VIEWER-USER-EMPHASIS-001 makes User a full-width Prompt block and keeps Assistant quiet', async t => {
    const interactionId = 'input-emphasis';
    for (const fixture of viewerThemeFixtures) {
        const { page } = await openHostViewerDocument(t, {
            includeStyles: true,
            themeFixture: fixture,
            interactionIds: [interactionId],
            interactionId,
            pageOverrides: {
                messages: [{
                    id: `${interactionId}:user`,
                    interactionId,
                    role: 'user',
                    markdown: 'Diagnose the loading failure.',
                }, {
                    id: `${interactionId}:assistant`,
                    interactionId,
                    role: 'assistant',
                    markdown: 'I will inspect the refresh lifecycle.',
                }],
                previousCursor: undefined,
                nextCursor: undefined,
                isStart: true,
                isEnd: true,
            },
        });
        const user = page.locator('.conversation-message-user');
        const assistant = page.locator('.conversation-message-assistant');
        const styles = await user.evaluate((element) => {
            const assistantElement = document.querySelector(
                '.conversation-message-assistant'
            );
            const messagesElement = document.querySelector(
                '.conversation-messages'
            );
            const userRole = element.querySelector('.conversation-role');
            const assistantRole = assistantElement.querySelector(
                '.conversation-role'
            );
            const userBody = element.querySelector('.conversation-markdown');
            const assistantBody = assistantElement.querySelector(
                '.conversation-markdown'
            );
            const userStyle = getComputedStyle(element);
            const assistantStyle = getComputedStyle(assistantElement);
            const userRoleStyle = getComputedStyle(userRole);
            const assistantRoleStyle = getComputedStyle(assistantRole);
            const messagesBounds = messagesElement.getBoundingClientRect();
            const userBounds = element.getBoundingClientRect();
            const assistantBounds = assistantElement.getBoundingClientRect();
            return {
                userBackground: userStyle.backgroundColor,
                userBorderTop: Number.parseFloat(userStyle.borderTopWidth),
                userBorderLeft: Number.parseFloat(userStyle.borderLeftWidth),
                userRadius: Number.parseFloat(userStyle.borderTopLeftRadius),
                userRoleDisplay: userRoleStyle.display,
                userRoleColor: userRoleStyle.color,
                userRoleBackground: userRoleStyle.backgroundColor,
                userRoleRadius: Number.parseFloat(
                    userRoleStyle.borderTopLeftRadius
                ),
                userBodyColor: getComputedStyle(userBody).color,
                userTextAlign: getComputedStyle(userBody).textAlign,
                assistantBackground: assistantStyle.backgroundColor,
                assistantBorderLeft: Number.parseFloat(
                    assistantStyle.borderLeftWidth
                ),
                assistantBorderBottom: Number.parseFloat(
                    assistantStyle.borderBottomWidth
                ),
                assistantBodyColor: getComputedStyle(assistantBody).color,
                assistantRoleColor: assistantRoleStyle.color,
                assistantTextAlign: getComputedStyle(assistantBody).textAlign,
                messagesBounds: {
                    left: messagesBounds.left,
                    right: messagesBounds.right,
                },
                userBounds: { left: userBounds.left, right: userBounds.right },
                assistantBounds: {
                    left: assistantBounds.left,
                    right: assistantBounds.right,
                },
            };
        });

        assert.notEqual(
            styles.userBackground,
            'rgba(0, 0, 0, 0)',
            'User prompt must have its own filled surface'
        );
        assert.equal(styles.userBorderTop, 1);
        assert.equal(styles.userBorderLeft, 4);
        assert.ok(styles.userRadius >= 4);
        assert.equal(styles.userRoleDisplay, 'inline-flex');
        assert.ok(styles.userRoleRadius >= 100);
        assert.equal(styles.assistantBackground, 'rgba(0, 0, 0, 0)');
        assert.equal(styles.assistantBorderLeft, 0);
        assert.equal(styles.assistantBorderBottom, 1);
        assertConversationEmphasisTheme(styles, fixture);

        assert.throws(
            () => assertConversationEmphasisTheme({
                ...styles,
                userBounds: {
                    ...styles.userBounds,
                    left: styles.userBounds.left + 24,
                },
            }, fixture),
            /User message must fill the reading area's left edge/
        );
        assert.throws(
            () => assertConversationEmphasisTheme({
                ...styles,
                assistantRoleColor: fixture.tokens.editorForeground,
            }, fixture),
            /Assistant role must use the .* muted description foreground/
        );

        if (fixture.name === 'dark') {
            await user.evaluate(element => {
                element.classList.add('conversation-selected-interaction');
                element.tabIndex = -1;
                element.focus();
            });
            const indicators = await user.evaluate(element => {
                const style = getComputedStyle(element);
                return {
                    boxShadow: style.boxShadow,
                    outlineWidth: Number.parseFloat(style.outlineWidth),
                };
            });
            assert.notEqual(indicators.boxShadow, 'none');
            assert.equal(indicators.outlineWidth, 1);

            await page.emulateMedia({ forcedColors: 'active' });
            const forcedColors = await user.evaluate(element => {
                const assistantElement = document.querySelector(
                    '.conversation-message-assistant'
                );
                const role = element.querySelector('.conversation-role');
                const userStyle = getComputedStyle(element);
                const roleStyle = getComputedStyle(role);
                const assistantStyle = getComputedStyle(assistantElement);
                return {
                    userPerimeterWidths: {
                        top: Number.parseFloat(userStyle.borderTopWidth),
                        right: Number.parseFloat(userStyle.borderRightWidth),
                        bottom: Number.parseFloat(userStyle.borderBottomWidth),
                        left: Number.parseFloat(userStyle.borderLeftWidth),
                    },
                    userRoleBorderWidths: {
                        top: Number.parseFloat(roleStyle.borderTopWidth),
                        right: Number.parseFloat(roleStyle.borderRightWidth),
                        bottom: Number.parseFloat(roleStyle.borderBottomWidth),
                        left: Number.parseFloat(roleStyle.borderLeftWidth),
                    },
                    userRoleBorderStyles: {
                        top: roleStyle.borderTopStyle,
                        right: roleStyle.borderRightStyle,
                        bottom: roleStyle.borderBottomStyle,
                        left: roleStyle.borderLeftStyle,
                    },
                    userRoleColor: roleStyle.color,
                    userRoleBackground: roleStyle.backgroundColor,
                    assistantSeparatorWidth: Number.parseFloat(
                        assistantStyle.borderBottomWidth
                    ),
                };
            });
            assertConversationEmphasisForcedColors(forcedColors);
        }
    }
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 sanitizes hostile HTML and posts exact version-1 navigation', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, hostileConversationPage);

    await assert.doesNotReject(page.evaluate(() => window.__executed));
    assert.equal(await page.evaluate(() => window.__executed), undefined);
    await assert.doesNotReject(page.evaluate(() => window.__clicked));
    assert.equal(await page.evaluate(() => window.__clicked), undefined);
    assert.equal(await page.locator('script').count(), 0);
    assert.equal(await page.locator('[onclick]').count(), 0);
    assert.equal(await page.locator('[data-unexpected]').count(), 0);
    assert.equal(await page.locator('[aria-label="private"]').count(), 0);
    assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
    assert.equal(await page.locator('a[href^="data:"]').count(), 0);
    assert.equal(await page.locator('a[href^="file:"]').count(), 0);
    assert.equal(await page.locator('a[href^="command:"]').count(), 0);
    assert.equal(await page.locator('a[href^="http:"]').count(), 0);
    assert.equal(
        await page.locator('a[href="https://example.test/safe"]').count(),
        1
    );
    assert.equal(
        await page.locator('.conversation-selected-interaction').count(),
        1
    );

    await page.getByRole('button', { name: 'Previous' }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-previous',
        version: 1,
    });
    await page.getByRole('button', { name: 'Next' }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-next',
        version: 1,
    });
    await page.getByRole('button', { name: 'Latest' }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-latest',
        version: 1,
    });

    await page.locator('a[href="https://example.test/safe"]').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-open-link',
        version: 1,
        href: 'https://example.test/safe',
    });

    await page.keyboard.press('Escape');
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-closed',
        version: 1,
    });
    await page.getByRole('button', { name: 'Close' }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-closed',
        version: 1,
    });
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 preserves ordered numbering across loose multi-paragraph list items', async t => {
    const { page } = await openHostViewerDocument(t, {
        markdown: [
            '1. Conversation modularization',
            '',
            'Split the current large modules by responsibility:',
            '',
            '- CommentController',
            '- OutlineController',
            '',
            'Move behavior without changing the UI or protocol.',
            '',
            '2. Upgrade product regression gates',
            '',
            'Add required PR checks.',
            '',
            '3. Add user-visible performance budgets',
            '',
            'Measure refresh and rendering.',
            '',
            '4. Establish pre-release product journeys',
            '',
            'Treat critical paths as release blockers.',
        ].join('\n'),
    });

    const orderedLists = await page.locator(
        '.conversation-markdown > ol'
    ).evaluateAll(elements => elements.map(list => ({
        start: list.start,
        text: list.textContent.trim(),
    })));

    assert.deepEqual(
        orderedLists.map(list => list.start),
        [1, 2, 3, 4]
    );
    assert.deepEqual(
        orderedLists.map(list => list.text),
        [
            'Conversation modularization',
            'Upgrade product regression gates',
            'Add user-visible performance budgets',
            'Establish pre-release product journeys',
        ]
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 CONVERSATION-VIEWER-RICH-MARKDOWN-001 preserves visible Mermaid node labels while retaining safe fallbacks', async t => {
    const page = await openViewerPage(t, { includeMermaid: true });
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="rich" data-interaction-id="input-4">
            <section class="conversation-markdown">
                <img src="https://example.test/icon.svg" alt="status icon"
                    title="Status">
                <img src="data:image/svg+xml,unsafe" alt="unsafe icon">
                <table><thead><tr><th>State</th></tr></thead>
                    <tbody><tr><td>Ready</td></tr></tbody></table>
                <pre><code class="language-mermaid">flowchart LR
                    A[Request] --&gt; B[Rendered]</code></pre>
            </section>
        </article>`,
    });

    const remoteImage = page.locator('img[alt="status icon"]');
    assert.equal(await remoteImage.count(), 1);
    assert.equal(
        await remoteImage.getAttribute('src'),
        'https://example.test/icon.svg'
    );
    assert.equal(await remoteImage.getAttribute('loading'), 'lazy');
    assert.equal(await remoteImage.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(await page.locator('img[alt="unsafe icon"][src]').count(), 0);
    assert.equal(await page.locator('table th').textContent(), 'State');
    assert.equal(await page.locator('table td').textContent(), 'Ready');

    const diagram = page.locator('.conversation-mermaid-image');
    await diagram.waitFor();
    assert.match(await diagram.getAttribute('src'), /^blob:/);
    assert.match(
        await diagram.getAttribute('alt'),
        /^Mermaid diagram: flowchart LR/
    );
    await page.waitForFunction(() => {
        const image = document.querySelector('.conversation-mermaid-image');
        return image && image.complete && image.naturalWidth > 0;
    });
    const normalizedSvg = await diagram.evaluate(async image =>
        (await fetch(image.src)).text()
    );
    assert.doesNotMatch(normalizedSvg, /<foreignObject/i);
    assert.match(normalizedSvg, />Request</);
    assert.match(normalizedSvg, />Rendered</);
    assert.equal(
        await page.locator('pre > code.language-mermaid').count(),
        0
    );

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        html: `<article data-message-id="invalid" data-interaction-id="input-4">
            <section class="conversation-markdown">
                <pre><code class="language-mermaid">not a diagram</code></pre>
            </section>
        </article>`,
    });
    await page.locator('.conversation-mermaid-error-label').waitFor();
    assert.equal(
        await page.locator('.conversation-mermaid-error-label').textContent(),
        'Mermaid diagram could not be rendered.'
    );
    assert.equal(
        await page.locator('pre > code.language-mermaid').textContent(),
        'not a diagram'
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 preserves structured text indentation and horizontal scrolling', async t => {
    const page = await openViewerPage(t);
    await page.setViewportSize({ width: 360, height: 500 });
    await page.addStyleTag({ content: viewerCss });
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="structured-text"
            data-interaction-id="input-4">
            <section class="conversation-markdown">
                <pre><code class="language-text">[Existing, extend] RedDBToHiveTransformConfig.ColumnMapping
  sourceKind: PRIMARY_KEY | REGULAR
  familyId: int32?          // PK 为空
  columnId: int32
  startupFamilyName: string?
  startupColumnName: string
  outputName: string
  sourceType: RedDBDataType
  targetType: STRING | INTEGER | BIGINT | FLOAT | DOUBLE | BOOLEAN
  nullable: bool
  typedDefault: TypedValue?
  ordinal: uint32</code></pre>
            </section>
        </article>`,
    });

    const presentation = await page.locator('pre').evaluate(pre => {
        const code = pre.querySelector('code');
        const indent = code.querySelector('.conversation-code-indent');
        const preStyle = getComputedStyle(pre);
        const codeStyle = getComputedStyle(code);
        return {
            text: code.textContent,
            indentation: indent.getBoundingClientRect().width,
            preWhiteSpace: preStyle.whiteSpace,
            preOverflowWrap: preStyle.overflowWrap,
            preWordBreak: preStyle.wordBreak,
            codeDisplay: codeStyle.display,
            codeOverflowWrap: codeStyle.overflowWrap,
            codeLineHeight: Number.parseFloat(codeStyle.lineHeight),
            clientWidth: pre.clientWidth,
            scrollWidth: pre.scrollWidth,
        };
    });

    assert.match(presentation.text, /\n  sourceKind: PRIMARY_KEY/);
    assert.ok(presentation.indentation > 0, 'leading spaces must remain visible');
    assert.equal(presentation.preWhiteSpace, 'pre');
    assert.equal(presentation.preOverflowWrap, 'normal');
    assert.equal(presentation.preWordBreak, 'normal');
    assert.equal(presentation.codeDisplay, 'block');
    assert.equal(presentation.codeOverflowWrap, 'normal');
    assert.ok(presentation.codeLineHeight >= 18);
    assert.ok(
        presentation.scrollWidth > presentation.clientWidth,
        'long structured lines must scroll instead of flattening their layout'
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 makes protobuf indentation visibly distinct without changing its source', async t => {
    const page = await openViewerPage(t);
    await page.addStyleTag({ content: viewerCss });
    const protobuf = `syntax = "proto3";

package reddb.protocol.datanode.dts;

service DtsService {
  rpc OpenFullSync(OpenFullSyncRequest) returns (OpenFullSyncResponse);
  rpc ScanFullSync(ScanFullSyncRequest) returns (ScanFullSyncResponse);
  rpc CloseFullSync(CloseFullSyncRequest) returns (CloseFullSyncResponse);
}`;
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="protobuf"
            data-interaction-id="input-4">
            <section class="conversation-markdown">
                <pre><code class="language-protobuf">${protobuf}</code></pre>
            </section>
        </article>`,
    });

    const code = page.locator('pre > code.language-protobuf');
    assert.equal(await code.textContent(), protobuf);
    const guides = code.locator('.conversation-code-indent');
    assert.equal(await guides.count(), 3);
    const presentation = await guides.evaluateAll(elements =>
        elements.map(element => ({
            text: element.textContent,
            width: element.getBoundingClientRect().width,
            characterWidth: (() => {
                const range = new Range();
                range.setStart(element.nextSibling, 0);
                range.setEnd(element.nextSibling, 1);
                return range.getBoundingClientRect().width;
            })(),
            guide: getComputedStyle(element, '::before').backgroundImage,
        }))
    );
    presentation.forEach(indent => {
        assert.equal(indent.text, '  ');
        assert.ok(
            indent.width >= indent.characterWidth * 3.75,
            'one source indentation level must have a clear four-column offset'
        );
        assert.notEqual(indent.guide, 'none');
    });
});

test('CONVERSATION-VIEWER-RICH-MARKDOWN-002 lazy-loads Mermaid in the nonce-only Host document', async t => {
    const { page } = await openHostViewerDocument(t, {
        markdown: [
            '```mermaid',
            'flowchart LR',
            '    Source --> Viewer',
            '```',
        ].join('\n'),
    });

    const diagram = page.locator('.conversation-mermaid-image');
    await diagram.waitFor();
    await page.waitForFunction(() => {
        const image = document.querySelector('.conversation-mermaid-image');
        return image && image.complete && image.naturalWidth > 0;
    });
    assert.equal(
        await page.locator('script[src$="/mermaid.min.js"]').count(),
        1
    );
    assert.match(await diagram.getAttribute('src'), /^blob:/);
});

test('CONVERSATION-READING-FOCUS-001 reserves Mermaid dimensions before Blob image decoding can shift layout', async t => {
    const page = await openViewerPage(t, { includeMermaid: true });
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="dimensioned"
            data-interaction-id="input-4">
            <section class="conversation-markdown">
                <pre><code class="language-mermaid">flowchart TB
                    A[One] --&gt; B[Two]
                    B --&gt; C[Three]
                    C --&gt; D[Four]
                    D --&gt; E[Five]</code></pre>
            </section>
        </article>`,
    });
    const diagram = page.locator('.conversation-mermaid-image');
    await diagram.waitFor();

    assert.ok(Number(await diagram.getAttribute('width')) > 0);
    assert.ok(Number(await diagram.getAttribute('height')) > 0);
});

test('CONVERSATION-READING-FOCUS-001 keeps the reading anchor stable after each Mermaid diagram finishes', async t => {
    const page = await openViewerPage(t, { controlledMermaid: true });
    await page.addStyleTag({ content: viewerCss });
    const diagram = label => `<article data-message-id="diagram-${label}"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <pre><code class="language-mermaid">flowchart TB
                A[${label}] --&gt; B[Rendered later]</code></pre>
        </section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        html: diagram('first') + diagram('second')
            + messageHtml('delayed-tail', 12),
        selectedInput: 12,
        totalInputs: 12,
        updateKind: 'initial',
    });
    await page.waitForFunction(
        () => window.__mermaidRenders.length === 1,
        undefined,
        { timeout: 3_000 }
    );
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.style.overflowAnchor = 'none';
    });
    const anchor = page.locator('[data-message-id="delayed-tail-6"]');
    await anchor.scrollIntoViewIfNeeded();
    const anchorTopBefore = await anchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });
    const scrollTopBefore = await scroll.evaluate(element => element.scrollTop);
    await page.evaluate(() => {
        window.__mermaidRenders[0].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 1600">
                <rect width="600" height="1600" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.waitForFunction(
        () => window.__mermaidRenders.length === 2,
        undefined,
        { timeout: 3_000 }
    );

    const anchorTopAfterFirstDiagram = await anchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });
    const scrollTopAfter = await scroll.evaluate(element => element.scrollTop);
    assert.ok(
        Math.abs(anchorTopAfterFirstDiagram - anchorTopBefore) <= 1,
        `reading anchor moved from ${anchorTopBefore} to `
            + anchorTopAfterFirstDiagram + ` (scrollTop ${scrollTopBefore}`
            + ` -> ${scrollTopAfter})`
    );
    await page.evaluate(() => {
        window.__mermaidRenders[1].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 800">
                <rect width="600" height="800" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.locator('.conversation-mermaid-image').nth(1).waitFor({
        timeout: 3_000,
    });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const anchorTopAfterAllDiagrams = await anchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });
    assert.ok(
        Math.abs(anchorTopAfterAllDiagrams - anchorTopBefore) <= 1,
        `reading anchor moved after the final diagram from ${anchorTopBefore}`
            + ` to ${anchorTopAfterAllDiagrams}`
    );
});

test('CONVERSATION-READING-FOCUS-001 does not restart an in-flight Mermaid render on live refresh', async t => {
    const page = await openViewerPage(t, { controlledMermaid: true });
    const diagramMessage = text => `<article data-message-id="in-flight"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <pre><code class="language-mermaid">flowchart TB
                A[Slow diagram] --&gt; B[One render only]</code></pre>
            <p>${text}</p>
        </section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        html: diagramMessage('First response chunk'),
        updateKind: 'initial',
    });
    await page.waitForFunction(() => window.__mermaidRenders.length === 1);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        html: diagramMessage('First response chunk plus streamed text'),
        updateKind: 'refresh',
    });
    await page.waitForTimeout(50);
    assert.equal(
        await page.evaluate(() => window.__mermaidRenders.length),
        1
    );

    await page.evaluate(() => {
        window.__mermaidRenders[0].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 800">
                <rect width="600" height="800" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.locator('.conversation-mermaid-image').waitFor();
});

test('CONVERSATION-READING-FOCUS-001 keeps an intra-message paragraph stable while earlier Mermaid diagrams finish', async t => {
    const page = await openViewerPage(t, { controlledMermaid: true });
    await page.addStyleTag({ content: viewerCss });
    const diagram = label => `<pre><code class="language-mermaid">flowchart TB
        A[${label}] --&gt; B[Rendered later]</code></pre>`;
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="multi-diagram"
            data-interaction-id="input-4">
            <section class="conversation-markdown">
                <p>Assistant introduction</p>
                ${diagram('first')}
                <p>Text between the diagrams</p>
                ${diagram('second')}
                <p>Assistant conclusion</p>
            </section>
        </article>` + messageHtml('intra-message-tail', 8),
        updateKind: 'initial',
    });
    await page.waitForFunction(() => window.__mermaidRenders.length === 1);
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.style.overflowAnchor = 'none';
    });
    const anchor = page.getByText('Text between the diagrams', {
        exact: true,
    });
    await anchor.evaluate(element => element.scrollIntoView({
        block: 'center',
    }));
    const anchorTopBefore = await anchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });
    const intraScrollTopBefore = await scroll.evaluate(
        element => element.scrollTop
    );

    await page.evaluate(() => {
        window.__mermaidRenders[0].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 1600">
                <rect width="600" height="1600" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.waitForFunction(() => window.__mermaidRenders.length === 2);
    const anchorTopAfterFirstDiagram = await anchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });
    const intraScrollTopAfter = await scroll.evaluate(
        element => element.scrollTop
    );

    await page.evaluate(() => {
        window.__mermaidRenders[1].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 800">
                <rect width="600" height="800" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.locator('.conversation-mermaid-image').nth(1).waitFor();
    assert.ok(
        Math.abs(anchorTopAfterFirstDiagram - anchorTopBefore) <= 1,
        `intra-message anchor moved from ${anchorTopBefore} to `
            + anchorTopAfterFirstDiagram + ` (scrollTop `
            + `${intraScrollTopBefore} -> ${intraScrollTopAfter})`
    );
});

test('CONVERSATION-READING-FOCUS-001 preserves an unchanged rendered Mermaid diagram across live refreshes', async t => {
    const page = await openViewerPage(t, { includeMermaid: true });
    const diagramMessage = `<article data-message-id="diagram"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <pre><code class="language-mermaid">flowchart TB
                A[Large diagram] --&gt; B[Stable node]
                B --&gt; C[Reading anchor]</code></pre>
        </section>
    </article>`;
    const baseHtml = diagramMessage + messageHtml('after-diagram', 12);
    await sendPage(page, {
        ...hostileConversationPage,
        html: baseHtml,
        selectedInput: 12,
        totalInputs: 12,
        updateKind: 'initial',
    });
    const diagram = page.locator('.conversation-mermaid-image');
    await diagram.waitFor();
    await page.waitForFunction(() => {
        const image = document.querySelector('.conversation-mermaid-image');
        return image && image.complete && image.naturalWidth > 0;
    });
    const originalSource = await diagram.getAttribute('src');
    await diagram.evaluate(image => {
        image.dataset.refreshIdentity = 'preserved';
    });
    const focusedMessage = page.locator(
        '[data-message-id="after-diagram-6"]'
    );
    await focusedMessage.evaluate(element => {
        element.tabIndex = -1;
        element.focus();
    });
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.scrollTop = element.scrollHeight / 2;
    });
    const scrollBefore = await scroll.evaluate(element => element.scrollTop);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'refresh',
        html: baseHtml + messageHtml('after-diagram-new', 1),
        selectedInput: 12,
        totalInputs: 13,
    });
    await page.locator('.conversation-mermaid-image').waitFor();

    assert.equal(
        await page.locator('.conversation-mermaid-image')
            .getAttribute('data-refresh-identity'),
        'preserved'
    );
    assert.equal(
        await page.locator('.conversation-mermaid-image').getAttribute('src'),
        originalSource
    );
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute('data-message-id')),
        'after-diagram-6'
    );
    assert.equal(
        await scroll.evaluate(element => element.scrollTop),
        scrollBefore
    );
});

test('CONVERSATION-READING-FOCUS-001 preserves an unchanged Mermaid block while its Assistant message streams more text', async t => {
    const page = await openViewerPage(t, { includeMermaid: true });
    const streamingMessage = text => `<article data-message-id="streaming"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <pre><code class="language-mermaid">flowchart TB
                A[Stable diagram] --&gt; B[Must not redraw]</code></pre>
            <p>${text}</p>
        </section>
    </article>`;
    const trailingMessages = messageHtml('streaming-tail', 12);
    await sendPage(page, {
        ...hostileConversationPage,
        html: streamingMessage('First response chunk') + trailingMessages,
        selectedInput: 12,
        totalInputs: 12,
        updateKind: 'initial',
    });
    const diagram = page.locator('.conversation-mermaid-image');
    await diagram.waitFor();
    await page.waitForFunction(() => {
        const image = document.querySelector('.conversation-mermaid-image');
        return image && image.complete && image.naturalWidth > 0;
    });
    const originalSource = await diagram.getAttribute('src');
    await diagram.evaluate(image => {
        image.dataset.streamingIdentity = 'preserved';
    });
    const focusedMessage = page.locator(
        '[data-message-id="streaming-tail-6"]'
    );
    await focusedMessage.evaluate(element => {
        element.tabIndex = -1;
        element.focus();
    });
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.scrollTop = element.scrollHeight / 2;
    });
    const scrollBefore = await scroll.evaluate(element => element.scrollTop);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'refresh',
        html: streamingMessage('First response chunk and more streamed text')
            + trailingMessages,
        selectedInput: 12,
        totalInputs: 12,
    });
    await page.locator('.conversation-mermaid-image').waitFor();

    assert.equal(
        await page.locator('.conversation-mermaid-image')
            .getAttribute('data-streaming-identity'),
        'preserved'
    );
    assert.equal(
        await page.locator('.conversation-mermaid-image').getAttribute('src'),
        originalSource
    );
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute('data-message-id')),
        'streaming-tail-6'
    );
    assert.equal(
        await scroll.evaluate(element => element.scrollTop),
        scrollBefore
    );
    assert.match(
        await page.locator('[data-message-id="streaming"]').textContent(),
        /more streamed text/
    );
});

test('CONVERSATION-READING-FOCUS-001 leaves an identical refresh DOM and descendant focus untouched', async t => {
    const page = await openViewerPage(t);
    const html = `<article data-message-id="stable-refresh"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <p><a href="https://example.com/stable">Stable reading link</a></p>
        </section>
    </article>` + messageHtml('stable-refresh-tail', 50);
    await sendPage(page, {
        ...hostileConversationPage,
        html,
        selectedInput: 25,
        totalInputs: 25,
        updateKind: 'initial',
    });
    const link = page.getByRole('link', { name: 'Stable reading link' });
    await link.focus();
    await page.evaluate(() => {
        window.__conversationMessageMutations = 0;
        window.__conversationMessageObserver = new MutationObserver(records => {
            window.__conversationMessageMutations += records.filter(record =>
                record.type === 'childList'
            ).length;
        });
        window.__conversationMessageObserver.observe(
            document.querySelector('[data-conversation-messages]'),
            { childList: true, subtree: true }
        );
    });

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        html,
        selectedInput: 25,
        totalInputs: 25,
        updateKind: 'refresh',
    });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    assert.equal(await page.evaluate(
        () => window.__conversationMessageMutations
    ), 0);
    assert.equal(
        await page.evaluate(() => document.activeElement?.textContent),
        'Stable reading link'
    );
});

test('CONVERSATION-REFRESH-PERFORMANCE-001 keeps DOM, Blob URLs, and listeners constant across 100 identical refreshes', async t => {
    const page = await openViewerPage(t, {
        controlledMermaid: true,
        trackResources: true,
    });
    const html = `<article data-message-id="stable-performance"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <p><a href="https://example.com/stable-performance">
                Stable performance anchor
            </a></p>
            <pre><code class="language-mermaid">flowchart LR
                A[Stable] --&gt; B[No redraw]</code></pre>
        </section>
    </article>` + messageHtml('stable-performance-tail', 25);
    await sendPage(page, {
        ...hostileConversationPage,
        html,
        selectedInput: 25,
        totalInputs: 25,
        updateKind: 'initial',
    });
    await page.waitForFunction(() => window.__mermaidRenders.length === 1);
    await page.evaluate(() => {
        window.__mermaidRenders[0].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 400">
                <rect width="600" height="400" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.locator('.conversation-mermaid-image').waitFor();
    const link = page.getByRole('link', {
        name: 'Stable performance anchor',
    });
    await link.focus();
    const baseline = await page.evaluate(() => {
        const root = document.querySelector('[data-conversation-messages]');
        window.__stableConversationRoot = root;
        window.__stableConversationNodes = Array.from(
            root.querySelectorAll('*')
        );
        return {
            nodeCount: root.querySelectorAll('*').length,
            metrics: { ...window.__conversationResourceMetrics },
        };
    });

    await page.evaluate(({ payload, refreshHtml }) => {
        for (let index = 0; index < 100; index += 1) {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    ...payload,
                    requestId: index + 2,
                    html: refreshHtml,
                    selectedInput: 25,
                    totalInputs: 25,
                    updateKind: 'refresh',
                },
            }));
        }
    }, {
        payload: hostileConversationPage,
        refreshHtml: html,
    });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    assert.deepEqual(
        await page.evaluate(() => {
            const root = document.querySelector(
                '[data-conversation-messages]'
            );
            const nodes = Array.from(root.querySelectorAll('*'));
            return {
                sameRoot: root === window.__stableConversationRoot,
                sameNodes: nodes.length
                    === window.__stableConversationNodes.length
                    && nodes.every((node, index) =>
                        node === window.__stableConversationNodes[index]),
                nodeCount: nodes.length,
                metrics: { ...window.__conversationResourceMetrics },
                focusedText: document.activeElement?.textContent.trim(),
            };
        }),
        {
            sameRoot: true,
            sameNodes: true,
            nodeCount: baseline.nodeCount,
            metrics: baseline.metrics,
            focusedText: 'Stable performance anchor',
        }
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 bounds initial and incremental Webview publication work', async t => {
    const page = await openViewerPage(t);
    const largeMessageHtml = (count, startIndex = 0) => Array.from(
        { length: count },
        (_item, offset) => {
            const index = startIndex + offset;
            return `<article
            class="conversation-message conversation-message-assistant"
            data-message-id="large-${index}"
            data-interaction-id="input-${index}">
            <section class="conversation-markdown"><p>
                Large response ${index} ${'x'.repeat(2_000)}
            </p></section>
        </article>`;
        }
    ).join('');
    const initialHtml = largeMessageHtml(100);
    const measurePublication = payload => page.evaluate(message => {
        const startedAt = performance.now();
        window.dispatchEvent(new MessageEvent('message', { data: message }));
        document.querySelector('[data-conversation-messages]').offsetHeight;
        return performance.now() - startedAt;
    }, payload);
    const initialMs = await measurePublication({
        ...hostileConversationPage,
        html: initialHtml,
        selectedInput: 100,
        totalInputs: 2_000,
        updateKind: 'initial',
    });
    assert.ok(
        initialMs <= conversationPerformanceBudgets.webviewInitialPublicationMs,
        `initial Webview publication ${initialMs}ms exceeds `
            + `${conversationPerformanceBudgets.webviewInitialPublicationMs}ms`
    );

    const incrementalMs = await measurePublication({
        ...hostileConversationPage,
        requestId: 2,
        html: initialHtml + largeMessageHtml(1, 100),
        selectedInput: 100,
        totalInputs: 2_000,
        updateKind: 'refresh',
    });
    assert.ok(
        incrementalMs
            <= conversationPerformanceBudgets.webviewIncrementalRefreshMs,
        `incremental Webview publication ${incrementalMs}ms exceeds `
            + `${conversationPerformanceBudgets.webviewIncrementalRefreshMs}ms`
    );
    assert.equal(
        await page.locator('[data-conversation-messages] > article').count(),
        101
    );
});

test('CONVERSATION-READING-FOCUS-001 never restores a stale refresh anchor after the reader scrolls during Mermaid rendering', async t => {
    const page = await openViewerPage(t, { controlledMermaid: true });
    await page.addStyleTag({ content: viewerCss });
    const initialHead = `<article data-message-id="changing-head"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <p>Response before the diagram arrives.</p>
        </section>
    </article>`;
    const refreshedHead = `<article data-message-id="changing-head"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            <p>Response before the diagram arrives.</p>
            <pre><code class="language-mermaid">flowchart TB
                A[Delayed diagram] --&gt; B[Must respect later reading]</code></pre>
        </section>
    </article>`;
    const tail = messageHtml('reader-tail', 24);
    await sendPage(page, {
        ...hostileConversationPage,
        html: initialHead + tail,
        selectedInput: 12,
        totalInputs: 12,
        updateKind: 'initial',
    });
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.style.overflowAnchor = 'none';
    });
    const refreshAnchor = page.locator('[data-message-id="reader-tail-4"]');
    await refreshAnchor.evaluate(element => element.scrollIntoView({
        block: 'center',
    }));

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        html: refreshedHead + tail,
        selectedInput: 12,
        totalInputs: 12,
        updateKind: 'refresh',
    });
    await page.waitForFunction(() => window.__mermaidRenders.length === 1);
    const readerAnchor = page.locator('[data-message-id="reader-tail-18"]');
    await readerAnchor.evaluate(element => element.scrollIntoView({
        block: 'center',
    }));
    const readerTopBefore = await readerAnchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });

    await page.evaluate(() => {
        window.__mermaidRenders[0].resolve({
            svg: `<svg xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 600 1800">
                <rect width="600" height="1800" fill="#246"></rect>
            </svg>`,
        });
    });
    await page.locator('.conversation-mermaid-image').waitFor();
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    const readerTopAfter = await readerAnchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });

    assert.ok(
        Math.abs(readerTopAfter - readerTopBefore) <= 1,
        `reader-selected anchor moved from ${readerTopBefore} to `
            + readerTopAfter
    );
});

test('CONVERSATION-READING-FOCUS-001 preserves the visible block inside a changed Assistant message', async t => {
    const page = await openViewerPage(t);
    await page.addStyleTag({ content: viewerCss });
    const response = suffix => `<article data-message-id="changing-response"
        data-interaction-id="input-4">
        <section class="conversation-markdown">
            ${Array.from({ length: 18 }, (_, index) =>
                `<p>Response block ${index + 1}`
                    + `${index === 0 ? suffix : ''}</p>`
            ).join('')}
        </section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        html: response(''),
        updateKind: 'initial',
    });
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.style.overflowAnchor = 'none';
    });
    const anchor = page.getByText('Response block 12', { exact: true });
    await anchor.evaluate(element => element.scrollIntoView({
        block: 'center',
    }));
    const anchorTopBefore = await anchor.evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        html: response(' with newly streamed text'),
        updateKind: 'refresh',
    });
    const anchorTopAfter = await page.getByText(
        'Response block 12',
        { exact: true }
    ).evaluate(element => {
        const scrollElement = document.querySelector(
            '[data-conversation-scroll]'
        );
        return element.getBoundingClientRect().top
            - scrollElement.getBoundingClientRect().top;
    });

    assert.ok(
        Math.abs(anchorTopAfter - anchorTopBefore) <= 1,
        `intra-message reading block moved from ${anchorTopBefore} to `
            + anchorTopAfter
    );
});

test('CONVERSATION-VIEWER-BROWSER-NAVIGATION-001 preserves historical scroll and focuses the first appended message', async t => {
    const page = await openViewerPage(t);
    const originalHtml = messageHtml('message', 12);
    await sendPage(page, {
        ...hostileConversationPage,
        html: originalHtml,
    });
    assert.equal(await page.getByRole('button', {
        name: 'New response content',
    }).isHidden(), true);
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => { element.scrollTop = 90; });
    const historicalScroll = await scroll.evaluate(element => element.scrollTop);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'refresh',
        html: originalHtml + messageHtml('message', 1, 12),
        totalInputs: 13,
    });

    assert.equal(
        await page.locator('[data-conversation-position]').textContent(),
        'Input 4 of 13'
    );
    assert.equal(
        await scroll.evaluate(element => element.scrollTop),
        historicalScroll
    );
    const newResponse = page.getByRole('button', {
        name: 'New response content',
    });
    assert.equal(await newResponse.isVisible(), true);
    await newResponse.click();
    assert.equal(await page.evaluate(() =>
        document.activeElement
            && document.activeElement.getAttribute('data-message-id')
    ), 'message-12');
    assert.equal(await newResponse.isHidden(), true);
});

test('CONVERSATION-VIEWER-BROWSER-NAVIGATION-002 anchors and focuses the Host-selected interaction', async t => {
    const page = await openViewerPage(t);
    const html = messageHtml('selected', 6);
    await sendPage(page, {
        ...hostileConversationPage,
        html,
        outline: Array.from({ length: 6 }, (_, index) => ({
            interactionId: `selected-${index}`,
            userPreview: `Selected input ${index + 1}`,
            responseState: 'complete',
        })),
        selectedInteractionId: 'selected-3',
    });
    assert.equal(await page.locator(
        '[data-interaction-id="selected-3"].conversation-selected-interaction'
    ).count(), 1);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'navigation',
        html,
        outline: Array.from({ length: 6 }, (_, index) => ({
            interactionId: `selected-${index}`,
            userPreview: `Selected input ${index + 1}`,
            responseState: 'complete',
        })),
        selectedInteractionId: 'selected-2',
        selectedInput: 3,
    });
    assert.equal(await page.evaluate(() =>
        document.activeElement
            && document.activeElement.getAttribute('data-interaction-id')
    ), 'selected-2');
});

test('CONVERSATION-OPEN-LATEST-001 reveals the newest line when the viewer opens at the latest interaction inside a short viewport', async t => {
    const page = await openViewerPage(t);
    const outline = Array.from({ length: 5 }, (_item, index) => ({
        interactionId: `latest-${index}`,
        userPreview: `Latest input ${index + 1}`,
        responseState: 'complete',
    }));
    await sendPage(page, {
        ...hostileConversationPage,
        html: interactionHtml('latest', 4, 3)
            + interactionHtml('latest', 4, 40, 4),
        outline,
        selectedInteractionId: 'latest-4',
        selectedInput: 5,
        totalInputs: 5,
        atLatest: true,
        nextCursor: undefined,
    });

    const opened = await measureConversationEnd(page, 'latest-4-assistant');
    assert.ok(
        opened.hiddenBelow <= 0,
        `newest line stayed ${opened.hiddenBelow}px below the viewport`
    );
    assert.equal(opened.distanceFromEnd, 0);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'navigation',
        html: interactionHtml('latest', 4, 3)
            + interactionHtml('latest', 4, 40, 4),
        outline,
        selectedInteractionId: 'latest-1',
        selectedInput: 2,
        totalInputs: 5,
        atLatest: false,
    });

    const navigated = await measureConversationEnd(page, 'latest-4-assistant');
    assert.ok(
        navigated.distanceFromEnd > 0,
        'navigating away from the latest input must not jump to the end'
    );
    assert.ok(
        navigated.selectedVisible,
        'navigation must keep the selected interaction inside the viewport'
    );
});

test('CONVERSATION-OPEN-LATEST-001 keeps the newest line visible when the editor area shrinks and leaves a scrolled-up reader in place', async t => {
    const page = await openViewerPage(t);
    const outline = Array.from({ length: 5 }, (_item, index) => ({
        interactionId: `shrink-${index}`,
        userPreview: `Shrink input ${index + 1}`,
        responseState: 'complete',
    }));
    await sendPage(page, {
        ...hostileConversationPage,
        html: interactionHtml('shrink', 4, 3)
            + interactionHtml('shrink', 4, 40, 4),
        outline,
        selectedInteractionId: 'shrink-4',
        selectedInput: 5,
        totalInputs: 5,
        atLatest: true,
        nextCursor: undefined,
    });
    const scroll = page.locator('[data-conversation-scroll]');
    const shrink = async height => {
        await scroll.evaluate((element, value) => {
            element.style.height = `${value}px`;
        }, height);
        await page.waitForTimeout(50);
    };

    await shrink(80);
    const shrunk = await measureConversationEnd(page, 'shrink-4-assistant');
    assert.ok(
        shrunk.hiddenBelow <= 0,
        `newest line stayed ${shrunk.hiddenBelow}px below the shrunk viewport`
    );

    await scroll.evaluate(element => { element.scrollTop = 40; });
    await shrink(60);
    assert.equal(await scroll.evaluate(element => element.scrollTop), 40);
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 CONVERSATION-OPEN-LATEST-001 anchors outline navigation on the selected input even when it is the newest one', async t => {
    const page = await openViewerPage(t);
    const outline = Array.from({ length: 5 }, (_item, index) => ({
        interactionId: `nav-${index}`,
        userPreview: `Nav input ${index + 1}`,
        responseState: 'complete',
    }));
    const html = interactionHtml('nav', 4, 40)
        + interactionHtml('nav', 1, 40, 4);
    const navigateTo = async (interactionId, requestId, atLatest) => {
        await sendPage(page, {
            ...hostileConversationPage,
            requestId,
            updateKind: 'navigation',
            html,
            outline,
            selectedInteractionId: interactionId,
            selectedInput: Number(interactionId.split('-')[1]) + 1,
            totalInputs: 5,
            atLatest,
        });
        return page.evaluate(id => {
            const scroll = document.querySelector(
                '[data-conversation-scroll]'
            );
            const prompt = document.querySelector(
                `[data-message-id="${id}-user"]`
            );
            return Math.round(
                prompt.getBoundingClientRect().top
                - scroll.getBoundingClientRect().top
            );
        }, interactionId);
    };

    await sendPage(page, {
        ...hostileConversationPage,
        html,
        outline,
        selectedInteractionId: 'nav-4',
        selectedInput: 5,
        totalInputs: 5,
        atLatest: true,
        nextCursor: undefined,
    });

    const middleTop = await navigateTo('nav-2', 2, false);
    const newestTop = await navigateTo('nav-4', 3, true);

    assert.ok(
        middleTop >= 0,
        `middle input anchored ${middleTop}px above the viewport`
    );
    assert.ok(
        newestTop >= 0,
        `newest input anchored ${newestTop}px above the viewport`
    );
    assert.equal(newestTop, middleTop);
});

test('CONVERSATION-VIEWER-PARTIAL-001 labels capped input positions and partial history', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        ...hostileConversationPage,
        html: messageHtml('partial', 2),
        outline: Array.from({ length: 2 }, (_, index) => ({
            interactionId: `partial-${index}`,
            userPreview: `Partial input ${index + 1}`,
            responseState: 'complete',
        })),
        selectedInteractionId: 'partial-0',
        selectedInput: 2,
        totalInputs: 2_000,
        partial: true,
    });

    assert.equal(
        await page.locator('[data-conversation-position]').textContent(),
        'Input 2 of 2,000+'
    );
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'Partial history — showing newest inputs.'
    );
});

test('CONVERSATION-VIEWER-BROWSER-SCROLL-001 CONVERSATION-READING-FOCUS-001 preserves the reading viewport and semantic focus on refresh', async t => {
    const page = await openViewerPage(t);
    const baseHtml = messageHtml('follow', 20);
    const appendedHtml = baseHtml + messageHtml('follow-new', 1);
    const baseMessage = {
        ...hostileConversationPage,
        html: baseHtml,
        selectedInput: 20,
        totalInputs: 20,
        atLatest: true,
        previousCursor: 'previous',
        nextCursor: undefined,
        updateKind: 'initial',
    };
    const scroll = page.locator('[data-conversation-scroll]');

    await sendPage(page, baseMessage);
    const focusedMessage = page.locator('[data-message-id="follow-10"]');
    await focusedMessage.evaluate(element => {
        element.tabIndex = -1;
        element.focus();
    });
    await scroll.evaluate(element => {
        element.scrollTop = element.scrollHeight - element.clientHeight;
    });
    const bottomBefore = await scroll.evaluate(element => element.scrollTop);
    await sendPage(page, {
        ...baseMessage,
        requestId: 2,
        updateKind: 'refresh',
        html: appendedHtml,
        totalInputs: 21,
    });
    assert.equal(
        await scroll.evaluate(element => element.scrollTop),
        bottomBefore
    );
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute('data-message-id')),
        'follow-10'
    );
    assert.equal(await page.getByRole('button', {
        name: 'New response content',
    }).isVisible(), true);

    await sendPage(page, {
        ...baseMessage,
        requestId: 3,
        updateKind: 'navigation',
    });
    await scroll.evaluate(element => {
        element.scrollTop = element.scrollHeight - element.clientHeight - 9;
    });
    const before = await scroll.evaluate(element => element.scrollTop);
    await sendPage(page, {
        ...baseMessage,
        requestId: 4,
        updateKind: 'refresh',
        html: appendedHtml,
        totalInputs: 21,
    });
    assert.equal(await scroll.evaluate(element => element.scrollTop), before);
    assert.equal(await page.getByRole('button', {
        name: 'New response content',
    }).isVisible(), true);
});

test('CONVERSATION-VIEWER-BROWSER-PENDING-001 preserves the earliest unread response across refreshes and ignores explicit navigation', async t => {
    const page = await openViewerPage(t);
    const originalHtml = messageHtml('pending', 8);
    await sendPage(page, {
        ...hostileConversationPage,
        html: originalHtml,
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'refresh',
        html: originalHtml + messageHtml('pending-new', 1),
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 3,
        updateKind: 'refresh',
        html: originalHtml
            + messageHtml('pending-new', 1)
            + messageHtml('pending-later', 1),
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 4,
        updateKind: 'refresh',
        html: originalHtml
            + messageHtml('pending-new', 1)
            + messageHtml('pending-later', 1),
    });

    const newResponse = page.getByRole('button', {
        name: 'New response content',
    });
    assert.equal(await newResponse.isVisible(), true);
    await newResponse.click();
    assert.equal(await page.evaluate(() =>
        document.activeElement
            && document.activeElement.getAttribute('data-message-id')
    ), 'pending-new-0');

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 5,
        updateKind: 'navigation',
        html: originalHtml + messageHtml('historical-page', 1),
    });
    assert.equal(await newResponse.isHidden(), true);
});

test('CONVERSATION-VIEWER-BROWSER-CORRELATION-001 rejects stale request and subscription publications', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 5,
        html: messageHtml('request-5', 1),
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 4,
        html: messageHtml('request-4', 1),
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 6,
        subscriptionGeneration: 2,
        html: messageHtml('generation-2', 1),
    });

    assert.equal(await page.locator('[data-message-id="request-5-0"]').count(), 1);
    assert.equal(await page.locator('[data-message-id="request-4-0"]').count(), 0);
    assert.equal(await page.locator('[data-message-id="generation-2-0"]').count(), 0);
});

test('CONVERSATION-VIEWER-BROWSER-RACE-001 treats a refresh that wins initial loading as the initial page', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        ...hostileConversationPage,
        updateKind: 'refresh',
    });

    assert.equal(await page.getByRole('button', {
        name: 'New response content',
    }).isHidden(), true);
    assert.equal(await page.locator(
        '[data-interaction-id="input-4"].conversation-selected-interaction'
    ).count(), 1);
});

test('CONVERSATION-VIEWER-BROWSER-REFRESH-001 CONVERSATION-READING-FOCUS-001 preserves a real Host history window at every reading position', async t => {
    const publications = await realHostAppendPublications();
    for (const distance of [9, 8]) {
        const page = await openViewerPage(t);
        await sendPage(page, publications.initial);
        const scroll = page.locator('[data-conversation-scroll]');
        await scroll.evaluate((element, offset) => {
            element.scrollTop = element.scrollHeight
                - element.clientHeight
                - offset;
        }, distance);
        const before = await scroll.evaluate(element => element.scrollTop);

        await sendPage(page, publications.refresh);

        assert.equal(await page.locator(
            '[data-interaction-id="host-input-1"]'
        ).count(), 1);
        assert.equal(await page.locator(
            '[data-interaction-id="host-input-21"]'
        ).count(), 1);
        assert.equal(
            await scroll.evaluate(element => element.scrollTop),
            before
        );
        assert.equal(await page.getByRole('button', {
            name: 'New response content',
        }).isVisible(), true);
    }
});
