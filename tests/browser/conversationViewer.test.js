'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright-chromium');
const {
    ConversationCommentFileStore,
} = require('../../out/aiSessions/conversation/commentStore');
const {
    ConversationBookmarkFileStore,
} = require('../../out/aiSessions/conversation/bookmarkStore');
const {
    formatConversationClockTime,
} = require('../../out/aiSessions/conversation/text');

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
const conversationSubagentsScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationSubagentsScripts.js'),
    'utf8'
);
const conversationFindScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationFindScripts.js'),
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
    subagents: [],
    activeSubagent: null,
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
                    <strong data-conversation-provider>Codex</strong>
                    <span data-conversation-display-name>Original session</span>
                    <span data-conversation-position>Input 0 of 0</span>
                    <button type="button" data-action="previous">Previous</button>
                    <button type="button" data-action="next">Next</button>
                    <button type="button" data-action="latest">Latest</button>
                </header>
                <section class="conversation-telemetry"
                    data-conversation-telemetry hidden>
                    <div class="conversation-telemetry-provider"
                        data-telemetry-provider data-provider="codex"
                        title="Provider · Codex"></div>
                    <button type="button" class="conversation-telemetry-worktree"
                        data-telemetry-worktree data-worktree-root="" title=""
                        hidden>
                        <span data-telemetry-worktree-branch></span>
                    </button>
                    <div class="conversation-telemetry-model"
                        data-telemetry-model hidden>
                        <strong data-telemetry-model-value></strong>
                    </div>
                    <div class="conversation-telemetry-usage conversation-telemetry-context"
                        data-telemetry-context hidden>
                        <span class="conversation-telemetry-ring"
                            aria-hidden="true">
                            <svg class="conversation-telemetry-ring-progress"
                                viewBox="0 0 36 36">
                                <circle data-telemetry-context-progress
                                    cx="18" cy="18" r="15.5"
                                    pathLength="100"></circle>
                            </svg>
                        </span>
                        <span data-telemetry-context-value></span>
                    </div>
                    <div class="conversation-telemetry-limits"
                        data-telemetry-limits></div>
                </section>
                <div data-conversation-status aria-live="polite"></div>
                <div data-conversation-scroll tabindex="0"
                    style="height: 160px; overflow-y: auto">
                    <div data-conversation-messages></div>
                    <div class="conversation-working" data-conversation-working
                        role="status" aria-live="polite" hidden>
                        <span>Working</span>
                        <span class="conversation-working-dots"
                            aria-hidden="true">
                            <span class="conversation-working-dot"></span>
                            <span class="conversation-working-dot"></span>
                            <span class="conversation-working-dot"></span>
                        </span>
                    </div>
                </div>
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

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 applies an authoritative cross-provider Session switch without replacing the Webview shell', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, hostileConversationPage);
    await page.evaluate(() => {
        window.__retainedConversationMessages = document.querySelector(
            '[data-conversation-messages]'
        );
    });

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        subscriptionGeneration: 2,
        html: '<article data-message-id="kimi-message" '
            + 'data-interaction-id="kimi-input"><p>Kimi response</p></article>',
        outline: [{
            interactionId: 'kimi-input',
            userPreview: 'Kimi input',
            responseState: 'complete',
        }],
        selectedInteractionId: 'kimi-input',
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'kimi',
            sessionId: 'kimi-session',
            interactionId: 'kimi-input',
            displayName: 'Kimi Session',
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    assert.deepEqual(await page.evaluate(() => ({
        retainedRoot: document.querySelector('[data-conversation-messages]')
            === window.__retainedConversationMessages,
        provider: document.querySelector('[data-conversation-provider]')
            .textContent,
        telemetryProvider: document.querySelector('[data-telemetry-provider]')
            .getAttribute('data-provider'),
        telemetryProviderTitle: document
            .querySelector('[data-telemetry-provider]')
            .getAttribute('title'),
        displayName: document.querySelector('[data-conversation-display-name]')
            .textContent,
        response: document.querySelector('[data-conversation-messages]')
            .textContent.trim(),
    })), {
        retainedRoot: true,
        provider: 'Kimi',
        telemetryProvider: 'kimi',
        telemetryProviderTitle: 'Provider · Kimi',
        displayName: 'Kimi Session',
        response: 'Kimi response',
    });
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 adds late subagents without replacing readable Conversation messages', async t => {
    const { page } = await openHostViewerDocument(t);
    const html = messageHtml('readable-before-subagents', 2);
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html,
        subagents: [],
    });
    await page.locator('[data-message-id="readable-before-subagents-0"]')
        .evaluate(element => { element.__retainedAfterSubagents = true; });

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 51,
        updateKind: 'refresh',
        html,
        subagents: [{
            id: 'a11111111',
            label: 'Late provider worker',
            status: 'running',
            updatedAt: 1_780_000_000_000,
        }],
    });

    assert.equal(await page.locator(
        '[data-message-id="readable-before-subagents-0"]'
    ).evaluate(element => element.__retainedAfterSubagents), true,
    'a late optional update must retain the readable message DOM');
    assert.equal(
        await page.locator('[data-subagent-id="a11111111"]').count(),
        1
    );
    assert.equal(
        await page.locator('[data-telemetry-subagents]').innerText(),
        '1/1'
    );
});

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
        await page.locator('[data-telemetry-provider]')
            .getAttribute('data-provider'),
        'codex'
    );
    assert.equal(
        await page.locator('[data-telemetry-provider]').getAttribute('title'),
        'Provider · Codex'
    );
    assert.equal(
        await page.locator('[data-telemetry-model-value]').textContent(),
        'gpt-5.6-sol'
    );
    assert.equal(
        await page.locator('[data-telemetry-context-value]').textContent(),
        '25%'
    );
    assert.equal(
        await page.locator('[data-telemetry-limit-value]').textContent(),
        '40%'
    );
    assert.equal(
        await page.locator('[data-telemetry-context-progress]')
            .getAttribute('stroke-dashoffset'),
        '75'
    );
    assert.match(
        await page.locator('[data-telemetry-context]').getAttribute('title'),
        /Context window · 25% used.*32\.0k \/ 128k tokens/s
    );
    assert.match(
        await page.locator('[data-telemetry-limit]').getAttribute('title'),
        /Week · 40% used · resets in/
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
    const provider = options.provider || 'codex';
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
            provider,
            sessionId: 'session-host-document',
            sourceRevision: 'r1',
            interactions: interactionIds.map(id => ({
                id,
                userPreview: options.userPreviews?.[id] || id,
                userGraphemeCount: id.length,
                responseState: options.responseStates?.[id] || 'complete',
            })),
            totalInteractions: options.totalInteractions
                ?? interactionIds.length,
            partial: options.outlinePartial ?? false,
        }),
        readPage: async () => ({
            provider,
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
        showThinking: options.showThinking,
        submitPrompt: options.submitPrompt || (async () => {}),
        bookmarkStore: options.bookmarkStore,
        commentStore: options.commentStore,
        projectCommentStore: options.projectCommentStore,
    });
    await viewer.open({
        projectId: 'project-a',
        provider,
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
    const renderedHtml = await renderHostViewerDocument(options);
    const html = options.transformHostDocument
        ? options.transformHostDocument(renderedHtml)
        : renderedHtml;
    if (options.pageErrors) {
        page.on('pageerror', error => options.pageErrors.push(error.message));
    }
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
                body: options.viewerScriptSource || viewerScript,
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
                body: options.outlineScriptSource
                    || conversationOutlineScript,
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
        if (pathname === '/conversationSubagentsScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationSubagentsScript,
            });
            return;
        }
        if (pathname === '/conversationFindScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationFindScript,
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
        if (pathname === '/conversationTelemetry.css') {
            await route.fulfill({
                contentType: 'text/css',
                body: options?.includeStyles ? telemetryCss : '',
            });
            return;
        }
        await route.fulfill({ contentType: 'text/html', body: html });
    });
    if (options.trackScrollIntoView) {
        await page.addInitScript(() => {
            window.__scrollIntoViewCalls = [];
            const scrollIntoView = Element.prototype.scrollIntoView;
            Element.prototype.scrollIntoView = function (...args) {
                window.__scrollIntoViewCalls.push({
                    messageId: this.getAttribute?.('data-message-id') || '',
                });
                return scrollIntoView.apply(this, args);
            };
        });
    }
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

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 persists the authoritative target for extension-host reload restoration', async t => {
    const { page } = await openHostViewerDocument(t, {
        initialWebviewState: {
            conversationSidebar: { open: true, width: 260, view: 'outline' },
        },
    });

    const savedState = await page.evaluate(() => window.__webviewState);
    assert.deepEqual(savedState.conversationSidebar, {
        open: true,
        width: 260,
        view: 'outline',
    });
    assert.deepEqual(savedState.conversationViewer, {
        version: 1,
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-host-document',
            interactionId: 'input-2',
        },
    });
});

test('CONVERSATION-SESSION-REBIND-001 updates the identity without replacing focused DOM state', async t => {
    const page = await openViewerPage(t);
    await page.evaluate(() => {
        const draft = document.createElement('input');
        draft.setAttribute('data-test-local-draft', '');
        draft.value = 'unfinished local draft';
        document.body.appendChild(draft);
        draft.focus();
    });

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        displayName: 'Rebound session',
    });

    assert.equal(
        await page.locator('[data-conversation-display-name]').innerText(),
        'Rebound session'
    );
    assert.equal(
        await page.locator('[data-test-local-draft]').inputValue(),
        'unfinished local draft'
    );
    assert.equal(
        await page.locator('[data-test-local-draft]').evaluate(
            element => element === document.activeElement
        ),
        true
    );
});

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

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 acquires one real document API and delegates HTTPS links only to native Webview navigation', async t => {
    const { page } = await openHostViewerDocument(t);

    assert.equal(await page.evaluate(() => window.__acquireCount), 1);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    const defaultPreventedBeforeTestGuard = await page.locator(
        'a[href="https://example.test/safe"]'
    ).evaluate(link => {
        let defaultPrevented;
        document.addEventListener('click', event => {
            defaultPrevented = event.defaultPrevented;
            event.preventDefault();
        }, { once: true });
        link.click();
        return defaultPrevented;
    });
    assert.equal(
        defaultPreventedBeforeTestGuard,
        false,
        'the Webview must retain the native HTTPS navigation path'
    );

    assert.deepEqual(await postedMessages(page), [
        {
            type: 'conversation-viewer-focus',
            version: 1,
            focused: true,
        },
        { type: 'conversation-viewer-previous', version: 1 },
        { type: 'conversation-viewer-next', version: 1 },
        { type: 'conversation-viewer-latest', version: 1 },
    ]);
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 lists subagents, opens a transcript, and restores the conversation', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const subagents = [{
        id: 'a11111111',
        label: 'Explore the parser',
        agentType: 'explore',
        status: 'running',
        updatedAt: 1_780_000_000_000,
    }, {
        id: 'a22222222',
        label: 'Implement the feature',
        agentType: 'coder',
        status: 'idle',
        updatedAt: 1_780_000_100_000,
    }];
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html: messageHtml('main-session-message', 2),
        subagents,
        activeSubagent: null,
    });

    await page.locator('[data-action="toggle-sidebar"]').click();
    await page.locator('[data-sidebar-tab="subagents"]').click();
    const entry = page.locator('[data-subagent-id="a11111111"]');
    const finishedEntry = page.locator('[data-subagent-id="a22222222"]');
    assert.match(await entry.innerText(), /Explore the parser/);
    assert.match(await entry.innerText(), /Running/);
    assert.equal(
        await page.locator('[data-subagent-banner]').evaluate(
            element => getComputedStyle(element).display
        ),
        'none',
        'a hidden banner must stay display:none with production styles'
    );
    assert.match(
        await page.locator('[data-subagents-summary]').innerText(),
        /2 \/ 2 subagents/
    );

    // The running-only filter hides finished subagents and persists into the
    // Webview state so a document rebuild (subagent switch) keeps it.
    await page.locator('[data-subagents-running-only]').check();
    assert.equal(await finishedEntry.count(), 0);
    assert.equal(await entry.count(), 1);
    assert.match(
        await page.locator('[data-subagents-summary]').innerText(),
        /1 \/ 2 subagents/
    );
    const savedState = await page.evaluate(() => window.__webviewState);
    assert.equal(savedState.conversationSidebar.subagentsRunningOnly, true);
    await page.close();

    const rebuilt = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        initialWebviewState: savedState,
    });
    await sendPage(rebuilt.page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html: messageHtml('main-session-message', 2),
        subagents,
        activeSubagent: { id: 'a11111111', label: 'Explore the parser' },
    });
    assert.equal(
        await rebuilt.page.locator('[data-subagents-running-only]').isChecked(),
        true,
        'the filter must survive a document rebuild'
    );
    await rebuilt.page.locator('[data-sidebar-tab="subagents"]').click();
    assert.equal(
        await rebuilt.page.locator('[data-subagent-id="a22222222"]').count(),
        0
    );
    assert.equal(
        await rebuilt.page.locator('[data-subagent-id="a11111111"]').count(),
        1
    );
    await rebuilt.page.locator('[data-subagents-running-only]').uncheck();
    const rebuiltEntry = rebuilt.page.locator('[data-subagent-id="a11111111"]');
    assert.equal(
        await rebuilt.page.locator('[data-subagent-id="a22222222"]').count(),
        1
    );

    // The telemetry counter shows running/total and opens the Subagents tab.
    const counter = rebuilt.page.locator('[data-telemetry-subagents]');
    assert.equal(await counter.isVisible(), true);
    assert.equal(await counter.innerText(), '1/2');
    assert.match(await counter.getAttribute('title'), /1 running of 2/);
    assert.equal(
        await rebuilt.page.locator('[data-conversation-telemetry]').isVisible(),
        true,
        'the counter must reveal the telemetry bar even without usage data'
    );
    await rebuilt.page.locator('[data-action="toggle-sidebar"]').click();
    await counter.click();
    assert.equal(
        await rebuilt.page.locator('[data-sidebar-tab="subagents"]')
            .getAttribute('aria-selected'),
        'true'
    );
    assert.equal(
        await rebuilt.page.locator('[data-conversation-subagents]').isVisible(),
        true
    );

    await rebuiltEntry.click();
    assert.deepEqual((await postedMessages(rebuilt.page)).at(-1), {
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: 'a11111111',
    });

    await sendPage(rebuilt.page, {
        ...hostileConversationPage,
        requestId: 51,
        updateKind: 'navigation',
        html: messageHtml('subagent-message', 2),
        subagents,
        activeSubagent: { id: 'a11111111', label: 'Explore the parser' },
    });
    assert.equal(
        await rebuilt.page.locator('[data-subagent-banner]').isVisible(),
        true
    );
    assert.match(
        await rebuilt.page.locator('[data-subagent-banner-label]').innerText(),
        /Explore the parser/
    );
    assert.equal(
        await rebuilt.page.evaluate(() =>
            document.body.getAttribute('data-viewing-subagent')),
        'true'
    );
    assert.equal(await rebuiltEntry.getAttribute('aria-current'), 'true');

    await rebuilt.page.locator('[data-action="close-subagent"]').click();
    assert.deepEqual((await postedMessages(rebuilt.page)).at(-1), {
        type: 'conversation-viewer-close-subagent',
        version: 1,
    });

    // Returning to the main conversation hides the banner again, even with
    // production styles where display:flex would beat the hidden attribute.
    await sendPage(rebuilt.page, {
        ...hostileConversationPage,
        requestId: 52,
        updateKind: 'initial',
        html: messageHtml('main-session-message', 2),
        subagents,
        activeSubagent: null,
    });
    assert.equal(
        await rebuilt.page.locator('[data-subagent-banner]').evaluate(
            element => getComputedStyle(element).display
        ),
        'none'
    );
    assert.equal(
        await rebuilt.page.evaluate(() =>
            document.body.getAttribute('data-viewing-subagent')),
        'false'
    );

    await sendPage(rebuilt.page, {
        ...hostileConversationPage,
        requestId: 53,
        updateKind: 'refresh',
        subagents: [],
        activeSubagent: null,
    });
    // The pill doubles as the Subagents quick entry and stays visible at
    // zero instead of disappearing.
    assert.equal(await counter.isVisible(), true);
    assert.equal(await counter.innerText(), '0/0');
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 keeps boundary navigation inert while Latest stays available', async t => {
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
    const previous = page.getByRole('button', { name: 'Previous', exact: true });
    const next = page.getByRole('button', { name: 'Next', exact: true });
    const latest = page.getByRole('button', { name: 'Latest', exact: true });

    assert.equal(await page.evaluate(() => window.__acquireCount), 1);
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.isDisabled(), true);
    assert.equal(await latest.isDisabled(), false);
    const initialFocus = [{
        type: 'conversation-viewer-focus',
        version: 1,
        focused: true,
    }];
    assert.deepEqual(await postedMessages(page), initialFocus);

    await previous.evaluate(element => element.click());
    await next.evaluate(element => element.click());
    assert.deepEqual(await postedMessages(page), initialFocus);

    await latest.click();
    assert.deepEqual(await postedMessages(page), [
        ...initialFocus,
        { type: 'conversation-viewer-latest', version: 1 },
    ]);
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
    const sidebarToggle = page.locator('[data-action="toggle-sidebar"]');

    assert.equal(await sidebar.isHidden(), true);
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'false');
    await sidebarToggle.click();
    assert.equal(await sidebar.isVisible(), true);
    assert.equal(await outline.isVisible(), true);
    assert.equal(await comments.isHidden(), true);
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('[data-outline-interaction-id]').count(), 4);
    assert.deepEqual(
        await page.locator('[data-outline-interaction-id]')
            .evaluateAll(elements => elements.map(element =>
                element.getAttribute('data-outline-interaction-id')
            )),
        ['input-4', 'input-3', 'input-2', 'input-1'],
        'the newest input must render at the top of the outline'
    );
    assert.deepEqual(
        await page.locator('.conversation-outline-number')
            .evaluateAll(elements => elements.map(element =>
                element.textContent
            )),
        ['4', '3', '2', '1'],
        'newest-first rendering must retain authoritative input numbers'
    );
    const outlineSort = page.locator('[data-outline-sort]');
    assert.equal(
        await page.locator('[data-outline-summary]').isHidden(),
        true,
        'the compatibility summary anchor must not render a count row'
    );
    assert.equal(await outlineSort.getAttribute('data-order'), 'newest');
    assert.equal(
        await outlineSort.getAttribute('aria-label'),
        'Show oldest inputs first'
    );
    await outlineSort.click();
    assert.deepEqual(
        await page.locator('[data-outline-interaction-id]')
            .evaluateAll(elements => elements.map(element =>
                element.getAttribute('data-outline-interaction-id')
            )),
        ['input-1', 'input-2', 'input-3', 'input-4'],
        'the sort control should switch the outline to oldest-first'
    );
    assert.deepEqual(
        await page.locator('.conversation-outline-number')
            .evaluateAll(elements => elements.map(element =>
                element.textContent
            )),
        ['1', '2', '3', '4'],
        'oldest-first rendering must retain authoritative input numbers'
    );
    assert.equal(await outlineSort.getAttribute('data-order'), 'oldest');
    assert.equal(
        await outlineSort.getAttribute('aria-label'),
        'Show newest inputs first'
    );
    await outlineSort.click();
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
        await page.evaluate(() => window.__webviewState.conversationSidebar),
        {
            open: true,
            width: 240,
            view: 'outline',
            query: 'deploy',
            subagentsRunningOnly: false,
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
        'input-1'
    );
    await page.keyboard.press('Enter');
    let requests = await postedMessages(page);
    assert.deepEqual(requests.at(-1), {
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-1',
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
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true');
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
        'toggle-sidebar'
    );
    await sidebarToggle.click();
    assert.equal(await comments.isVisible(), true);
    assert.equal(await outline.isHidden(), true);
    await page.locator('[data-sidebar-tab="outline"]').click();
    assert.equal(await outline.isVisible(), true);
    assert.equal(await comments.isHidden(), true);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 settles stars authoritatively, filters favorites, and preserves newest-first input order', async t => {
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[1],
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

    await page.locator('[data-action="toggle-sidebar"]').click();
    assert.deepEqual(await orderedIds(), [...interactionIds].reverse());
    const outlineLayout = await page.evaluate(() => {
        const outline = document.querySelector('[data-conversation-outline]');
        const tabs = document.querySelector('.conversation-sidebar-tabs');
        const search = outline.querySelector('[data-outline-search]');
        const sort = outline.querySelector('[data-outline-sort]');
        const selectedItem = outline.querySelector(
            '[data-outline-interaction-id="input-2"]'
        ).closest('.conversation-outline-item');
        const star = document.querySelector(
            '[data-outline-bookmark-id="input-1"]'
        );
        const preview = document.querySelector(
            '[data-outline-interaction-id="input-1"]'
        )?.querySelector('.conversation-outline-preview');
        const outlineRect = outline.getBoundingClientRect();
        const searchRect = search.getBoundingClientRect();
        const sortRect = sort.getBoundingClientRect();
        const starRect = star.getBoundingClientRect();
        const previewRect = preview.getBoundingClientRect();
        return {
            tabsHeight: tabs.getBoundingClientRect().height,
            sortAlignedWithSearch:
                Math.abs(sortRect.top - searchRect.top) < 1,
            previewInset: previewRect.left - outlineRect.left,
            starInset: starRect.left - outlineRect.left,
            starOpacity: Number(getComputedStyle(star).opacity),
            selectedBackground: getComputedStyle(selectedItem).backgroundColor,
        };
    });
    assert.ok(
        outlineLayout.tabsHeight >= 28 && outlineLayout.tabsHeight <= 34,
        `outline tabs should stay compact, got ${outlineLayout.tabsHeight}px`
    );
    assert.ok(
        outlineLayout.previewInset >= 11
            && outlineLayout.previewInset <= 15,
        `outline text inset should stay balanced, got ${outlineLayout.previewInset}px`
    );
    assert.ok(
        outlineLayout.starInset > outlineLayout.previewInset,
        'bookmark control should occupy a stable trailing column'
    );
    assert.equal(
        outlineLayout.starOpacity,
        1,
        'an available bookmark control must keep full theme contrast'
    );
    assert.equal(
        outlineLayout.sortAlignedWithSearch,
        true,
        'search, bookmark filter, and sort should share one compact row'
    );
    assert.notEqual(
        outlineLayout.selectedBackground,
        'rgba(0, 0, 0, 0)',
        'the selected surface should cover the complete outline row'
    );
    assert.equal(await inputOneStar.getAttribute('aria-pressed'), 'false');
    assert.equal(
        await page.locator('[data-outline-bookmarks-only]')
            .getAttribute('aria-label'),
        'Show bookmarked inputs only, 1 bookmark'
    );
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
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        '',
        'outline star settlements stay out of the status line'
    );
    assert.deepEqual(await orderedIds(), [...interactionIds].reverse());

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
        ['input-3', 'input-1']
    );
    assert.equal(
        await page.locator('[data-outline-bookmarks-only]')
            .getAttribute('aria-label'),
        'Show all inputs, 2 bookmarks'
    );
});

test('CONVERSATION-MESSAGE-BOOKMARK-001 bookmarks an input from its card without opening the sidebar', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[1],
        viewport: { width: 1050, height: 620 },
        interactionIds: ['input-1', 'input-2'],
        interactionId: 'input-1',
        pageOverrides: {
            messages: [{
                id: 'input-1:user',
                interactionId: 'input-1',
                role: 'user',
                markdown: 'First question',
            }, {
                id: 'input-1:assistant:0',
                interactionId: 'input-1',
                role: 'assistant',
                markdown: 'First answer',
            }, {
                id: 'input-2:user',
                interactionId: 'input-2',
                role: 'user',
                markdown: 'Second question',
            }, {
                id: 'input-2:assistant:0',
                interactionId: 'input-2',
                role: 'assistant',
                markdown: 'Second answer',
            }],
        },
        bookmarkStore: {
            async load() {
                return { revision: 3, interactionIds: ['input-2'] };
            },
            async save() {},
        },
    });
    const cardStar = page.locator(
        '.conversation-message-user[data-interaction-id="input-1"]'
            + ' .conversation-message-bookmark'
    );
    const cardTwoStar = page.locator(
        '.conversation-message-user[data-interaction-id="input-2"]'
            + ' .conversation-message-bookmark'
    );

    await cardStar.waitFor();
    assert.equal(await cardStar.getAttribute('aria-pressed'), 'false');
    assert.equal(
        await cardStar.getAttribute('aria-label'),
        'Bookmark this input'
    );
    assert.equal(
        await cardTwoStar.getAttribute('aria-pressed'),
        'true',
        'the initial bookmark snapshot paints the card stars'
    );
    assert.equal(
        await cardTwoStar.getAttribute('aria-label'),
        'Remove bookmark from this input'
    );
    assert.equal(
        await page.locator('.conversation-message-bookmark').count(),
        2,
        'exactly one toggle per user input card'
    );
    assert.equal(
        await page.locator(
            '.conversation-message-assistant .conversation-message-bookmark'
        ).count(),
        0,
        'answers carry no bookmark toggle'
    );
    const starGeometry = await page.evaluate(() => {
        const card = document.querySelector(
            '.conversation-message-user[data-interaction-id="input-1"]'
        );
        const star = card.querySelector('.conversation-message-bookmark');
        const cardRect = card.getBoundingClientRect();
        const starRect = star.getBoundingClientRect();
        return {
            insideCard: starRect.top >= cardRect.top
                && starRect.bottom <= cardRect.top + cardRect.height / 2
                && starRect.right <= cardRect.right
                && starRect.left > cardRect.left + cardRect.width / 2,
            starColor: getComputedStyle(star).color,
        };
    });
    assert.equal(
        starGeometry.insideCard,
        true,
        'the star sits in the top-right corner of the input card'
    );
    assert.notEqual(
        starGeometry.starColor,
        'rgba(0, 0, 0, 0)',
        'an available card star must keep theme contrast'
    );

    await cardStar.click();
    assert.equal(
        await cardStar.getAttribute('aria-pressed'),
        'false',
        'the card star must not update optimistically'
    );
    assert.equal(
        await cardStar.isDisabled(),
        true,
        'the toggle waits for the authoritative settlement'
    );
    const requests = await postedMessages(page);
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
        'starring a card must not navigate'
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
        interactionIds: ['input-2', 'input-1'],
    }, '*'), requestId);
    await page.waitForFunction(() =>
        document.querySelector(
            '.conversation-message-user[data-interaction-id="input-1"]'
                + ' .conversation-message-bookmark'
        )?.getAttribute('aria-pressed') === 'true'
    );
    assert.equal(
        await cardStar.getAttribute('aria-label'),
        'Remove bookmark from this input'
    );
    assert.equal(await cardStar.isEnabled(), true);
    assert.equal(
        await page.locator('[data-outline-bookmark-id="input-1"]')
            .getAttribute('aria-pressed'),
        'true',
        'card and outline stars share one authoritative state'
    );
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        '',
        'a successful star settlement stays out of the status line'
    );
    assert.equal(
        await page.locator('[data-outline-bookmarks-only]')
            .getAttribute('aria-label'),
        'Show bookmarked inputs only, 2 bookmarks'
    );
    assert.equal(
        await page.evaluate(() => document.activeElement
            ?.classList.contains('conversation-message-bookmark')),
        true,
        'focus returns to the card star after the settlement'
    );

    await cardStar.click();
    const removal = (await postedMessages(page)).at(-1);
    assert.deepEqual(removal.payload, {
        interactionId: 'input-1',
        bookmarked: false,
    });
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
        revision: 5,
        interactionIds: ['input-2'],
    }, '*'), removal.requestId);
    await page.waitForFunction(() =>
        document.querySelector(
            '.conversation-message-user[data-interaction-id="input-1"]'
                + ' .conversation-message-bookmark'
        )?.getAttribute('aria-pressed') === 'false'
    );
    assert.equal(
        await page.locator('[data-outline-bookmark-id="input-1"]')
            .getAttribute('aria-pressed'),
        'false',
        'removing from the card also clears the outline star'
    );
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        '',
        'removals stay out of the status line too'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 copies code blocks with a hover control and language label', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 900, height: 560 },
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: {
            messages: [{
                id: 'input-1:user',
                interactionId: 'input-1',
                role: 'user',
                markdown: 'How do I answer?',
            }, {
                id: 'input-1:assistant:0',
                interactionId: 'input-1',
                role: 'assistant',
                markdown: 'Like this:\n\n```ts\nconst answer = 42;\n```',
            }],
        },
    });
    const block = page.locator('.conversation-code-block');
    const copyButton = block.locator('.conversation-code-copy');

    await block.waitFor();
    assert.equal(
        await block.locator('.conversation-code-lang').textContent(),
        'ts'
    );
    assert.equal(
        await block.locator('pre code').textContent(),
        'const answer = 42;\n'
    );
    assert.equal(
        await copyButton.textContent(),
        '',
        'the code copy control is an icon, not a word'
    );
    assert.equal(await copyButton.getAttribute('aria-label'), 'Copy code');
    assert.equal(
        await copyButton.locator('svg').count(),
        1,
        'the code copy control renders a real icon glyph'
    );
    assert.equal(
        await copyButton.evaluate(element =>
            getComputedStyle(element).opacity),
        '1',
        'the header strip keeps the copy control visible'
    );
    const chrome = await page.evaluate(() => {
        const blockElement = document.querySelector(
            '.conversation-code-block'
        );
        const header = blockElement.querySelector(
            '.conversation-code-header'
        );
        const headerRect = header.getBoundingClientRect();
        const label = blockElement
            .querySelector('.conversation-code-lang')
            .getBoundingClientRect();
        const button = blockElement
            .querySelector('.conversation-code-copy')
            .getBoundingClientRect();
        const pre = blockElement.querySelector('pre');
        const preRect = pre.getBoundingClientRect();
        return {
            headerAboveCode: headerRect.bottom <= preRect.top + 1,
            labelInHeader: label.top >= headerRect.top - 1
                && label.bottom <= headerRect.bottom + 1,
            buttonInHeader: button.top >= headerRect.top - 1
                && button.bottom <= headerRect.bottom + 1
                && button.right <= headerRect.right + 1,
            nothingOnCode: label.bottom <= preRect.top + 1
                && button.bottom <= preRect.top + 1,
            distinctSurface: getComputedStyle(header).backgroundColor
                !== getComputedStyle(pre).backgroundColor,
        };
    });
    assert.deepEqual(chrome, {
        headerAboveCode: true,
        labelInHeader: true,
        buttonInHeader: true,
        nothingOnCode: true,
        distinctSurface: true,
    }, 'code chrome lives on its own header strip above the code');
    const initialIcon = await copyButton.evaluate(element =>
        element.querySelector('svg')?.innerHTML);
    assert.ok(initialIcon, 'the icon starts as the copy glyph');

    await copyButton.click();
    const requests = await postedMessages(page);
    const requestId = requests.at(-1).requestId;
    assert.match(requestId, /^conversation-copy:[a-z0-9]+:1$/);
    assert.deepEqual(requests.at(-1), {
        type: 'conversation-viewer-copy',
        version: 1,
        requestId,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        operation: 'copy',
        payload: {
            kind: 'code',
            text: 'const answer = 42;\n',
        },
    });
    assert.equal(
        await copyButton.evaluate(element =>
            element.classList.contains('is-copied')),
        false,
        'the control must not claim success before the settlement'
    );

    await page.evaluate(id => window.postMessage({
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: id,
        success: true,
    }, '*'), requestId);
    await page.waitForFunction(() =>
        document.querySelector('.conversation-code-copy')
            ?.classList.contains('is-copied') === true
    );
    assert.equal(
        await copyButton.getAttribute('aria-label'),
        'Copied',
        'the settlement announces itself to screen readers'
    );
    assert.notEqual(
        await copyButton.evaluate(element =>
            element.querySelector('svg')?.innerHTML),
        initialIcon,
        'the settlement swaps the copy glyph for a check'
    );
    await page.waitForFunction(() =>
        document.querySelector('.conversation-code-copy')
            ?.classList.contains('is-copied') === false
            && document.querySelector('.conversation-code-copy')
                ?.getAttribute('aria-label') === 'Copy code',
        undefined,
        { timeout: 4000 }
    );
    assert.equal(
        await copyButton.evaluate(element =>
            element.querySelector('svg')?.innerHTML),
        initialIcon,
        'the copy glyph returns after the feedback window'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 copies user inputs and assistant answers through the Host', async t => {
    const completedAt = Date.now();
    const timestamp = completedAt - 120_000;
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[1],
        viewport: { width: 900, height: 560 },
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: {
            messages: [{
                id: 'input-1:user',
                interactionId: 'input-1',
                role: 'user',
                markdown: 'Add tests for the parser',
            }, {
                id: 'input-1:tool:0',
                interactionId: 'input-1',
                role: 'tool',
                markdown: '',
                tool: {
                    name: 'Shell',
                    summary: 'npm test',
                    detail: '9 passing',
                },
            }, {
                id: 'input-1:assistant:0',
                interactionId: 'input-1',
                role: 'assistant',
                markdown: 'Done, all green.',
            }],
            interactionStates: [{
                interactionId: 'input-1',
                responseState: 'complete',
                timestamp,
                completedAt,
            }],
        },
    });
    const userCopy = page.locator(
        '.conversation-message-user .conversation-message-copy'
    );
    const answerCopy = page.locator(
        '.conversation-message-assistant .conversation-message-copy'
    );

    await userCopy.waitFor();
    assert.equal(await userCopy.getAttribute('title'), 'Copy input');
    assert.equal(await userCopy.getAttribute('aria-label'), 'Copy input');
    assert.equal(await answerCopy.getAttribute('title'), 'Copy response');
    assert.equal(await answerCopy.getAttribute('aria-label'), 'Copy response');
    assert.equal(
        await page.locator('.conversation-message-copy').count(),
        2,
        'exactly one copy control per user/assistant article'
    );
    assert.equal(
        await page.locator(
            '.conversation-message-tool .conversation-message-copy'
        ).count(),
        0
    );
    assert.equal(
        await page.locator(
            '.conversation-message-worklog .conversation-message-copy'
        ).count(),
        0
    );
    const actionRows = await page.evaluate(() => {
        const card = document.querySelector('.conversation-message-user');
        const cardBounds = card.getBoundingClientRect();
        const star = card.querySelector('.conversation-message-bookmark')
            .getBoundingClientRect();
        const corner = card.querySelector('.conversation-message-corner')
            .getBoundingClientRect();
        const answer = document.querySelector(
            '.conversation-message-assistant'
        );
        const answerMarkdown = answer.querySelector('.conversation-markdown')
            .getBoundingClientRect();
        const answerRow = answer.querySelector(
            '.conversation-message-actions'
        ).getBoundingClientRect();
        const answerCopy = answer.querySelector('.conversation-message-copy')
            .getBoundingClientRect();
        return {
            cornerBesideStar: corner.right <= star.left + 1
                && Math.abs(
                    (corner.top + corner.bottom) - (star.top + star.bottom)
                ) <= 4,
            cornerInside: corner.top >= cardBounds.top - 1
                && corner.bottom <= cardBounds.top
                    + cardBounds.height / 2,
            cardHasNoRow: !card.querySelector(
                '.conversation-message-actions'
            ),
            answerRowBelow: answerRow.top >= answerMarkdown.bottom - 1,
            answerRowLeft: answerCopy.left
                - answer.getBoundingClientRect().left < 48,
        };
    });
    assert.deepEqual(actionRows, {
        cornerBesideStar: true,
        cornerInside: true,
        cardHasNoRow: true,
        answerRowBelow: true,
        answerRowLeft: true,
    }, 'the user card clusters its controls with the star while the answer keeps a bottom row');
    assert.equal(
        await userCopy.locator('svg').count(),
        1,
        'the message copy control renders a real icon glyph'
    );
    const answerTime = page.locator(
        '.conversation-message-assistant .conversation-message-time'
    );
    assert.match(
        await answerTime.textContent(),
        /^\d{2}:\d{2}$/,
        'the answer row shows a same-day clock time'
    );
    assert.equal(
        await answerTime.getAttribute('title'),
        formatConversationClockTime(completedAt, Date.now()).title,
        'the tooltip carries the full timestamp'
    );
    const clockGeometry = await page.evaluate(() => {
        const row = document.querySelector(
            '.conversation-message-assistant .conversation-message-actions'
        );
        const copy = row.querySelector('.conversation-message-copy')
            .getBoundingClientRect();
        const clock = row.querySelector('.conversation-message-time')
            .getBoundingClientRect();
        return {
            rightOfCopy: clock.left >= copy.right - 1,
            sameRow: Math.abs(
                (clock.top + clock.bottom) - (copy.top + copy.bottom)
            ) <= 4,
        };
    });
    assert.deepEqual(clockGeometry, {
        rightOfCopy: true,
        sameRow: true,
    }, 'the clock shares the action row with the copy control');
    const userTime = page.locator(
        '.conversation-message-user .conversation-message-time'
    );
    assert.match(
        await userTime.textContent(),
        /^\d{2}:\d{2}$/,
        'the user corner clocks the input time'
    );
    assert.equal(
        await userTime.getAttribute('title'),
        formatConversationClockTime(timestamp, Date.now()).title,
        'the user clock tooltip carries the input timestamp'
    );
    const cornerOrder = await page.evaluate(() => {
        const card = document.querySelector('.conversation-message-user');
        const time = card.querySelector('.conversation-message-time')
            .getBoundingClientRect();
        const copy = card.querySelector('.conversation-message-copy')
            .getBoundingClientRect();
        const star = card.querySelector('.conversation-message-bookmark')
            .getBoundingClientRect();
        return {
            ordered: time.right <= copy.left + 1
                && copy.right <= star.left + 1,
        };
    });
    assert.equal(
        cornerOrder.ordered,
        true,
        'the corner reads time, copy, star from left to right'
    );
    const corner = page.locator('.conversation-message-corner');
    assert.equal(
        await corner.evaluate(element => getComputedStyle(element).opacity),
        '0',
        'the corner cluster stays quiet until hover'
    );
    await page.hover('.conversation-message-user');
    await page.waitForFunction(() =>
        getComputedStyle(document.querySelector(
            '.conversation-message-corner'
        )).opacity === '1',
        'the corner cluster reveals on hover'
    );

    await userCopy.click();
    let requests = await postedMessages(page);
    const requestId = requests.at(-1).requestId;
    assert.match(requestId, /^conversation-copy:[a-z0-9]+:1$/);
    assert.deepEqual(requests.at(-1).payload, {
        kind: 'message',
        messageId: 'input-1:user',
    });

    await page.evaluate(id => window.postMessage({
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: id,
        success: false,
        error: 'failed',
    }, '*'), requestId);
    await page.waitForFunction(() =>
        document.querySelector(
            '.conversation-message-user .conversation-message-copy'
        )?.classList.contains('is-failed') === true
    );
    assert.equal(
        await userCopy.getAttribute('aria-label'),
        'Copy failed'
    );
    await page.waitForFunction(() =>
        document.querySelector(
            '.conversation-message-user .conversation-message-copy'
        )?.classList.contains('is-failed') === false
            && document.querySelector(
                '.conversation-message-user .conversation-message-copy'
            )?.getAttribute('aria-label') === 'Copy input',
        undefined,
        { timeout: 4000 }
    );
    assert.equal(
        await userCopy.textContent(),
        '',
        'the message copy control is an icon, not a word'
    );

    await answerCopy.click();
    requests = await postedMessages(page);
    assert.deepEqual(requests.at(-1).payload, {
        kind: 'message',
        messageId: 'input-1:assistant:0',
    });
    assert.match(
        requests.at(-1).requestId,
        /^conversation-copy:[a-z0-9]+:2$/,
        'every copy intent gets a fresh request id'
    );
});

function findFixtureOverrides() {
    return {
        messages: [{
            id: 'input-1:user',
            interactionId: 'input-1',
            role: 'user',
            markdown: 'Add tests for the parser',
        }, {
            id: 'input-1:assistant:0',
            interactionId: 'input-1',
            role: 'assistant',
            markdown: 'I added `parser` tests and updated the parser module.',
        }],
        interactionStates: [{
            interactionId: 'input-1',
            responseState: 'complete',
        }],
    };
}

function currentFindMatch(page) {
    return page.evaluate(() => {
        const highlight = CSS.highlights.get('conversation-find-current');
        const range = highlight && highlight.size
            ? highlight.values().next().value
            : null;
        if (!range) return null;
        return {
            text: range.startContainer.textContent,
            start: range.startOffset,
            end: range.endOffset,
        };
    });
}

test('CONVERSATION-FIND-001 opens with Ctrl+F, highlights case-insensitive matches, and closes with Escape', async t => {
    const { page } = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: findFixtureOverrides(),
    });
    const findBar = page.locator('[data-conversation-find]');
    await findBar.waitFor({ state: 'attached' });
    assert.equal(await findBar.isHidden(), true, 'the find bar starts hidden');

    await page.keyboard.press('Control+f');
    assert.equal(await findBar.isVisible(), true, 'Ctrl+F opens the find bar');
    const input = page.locator('[data-find-input]');
    assert.equal(
        await input.evaluate(element => document.activeElement === element),
        true,
        'opening the find bar focuses the query input'
    );

    await input.fill('PARSER');
    assert.equal(
        await page.locator('[data-find-count]').textContent(),
        '1 of 3',
        'the query matches case-insensitively across messages'
    );
    assert.deepEqual(await page.evaluate(() => ({
        all: CSS.highlights.get('conversation-find')?.size ?? 0,
        current: CSS.highlights.get('conversation-find-current')?.size ?? 0,
    })), { all: 3, current: 1 },
        'every match paints with one distinct current match');
    assert.deepEqual(await currentFindMatch(page), {
        text: 'Add tests for the parser',
        start: 18,
        end: 24,
    }, 'the first match starts the navigation');

    await input.fill('parser tests');
    assert.equal(
        await page.locator('[data-find-count]').textContent(),
        '1 of 1',
        'a phrase match spans an inline code boundary'
    );

    await page.keyboard.press('Escape');
    assert.equal(await findBar.isHidden(), true, 'Escape closes the find bar');
    assert.deepEqual(await page.evaluate(() => ({
        all: CSS.highlights.has('conversation-find'),
        current: CSS.highlights.has('conversation-find-current'),
    })), { all: false, current: false },
        'closing clears every find highlight');

    await page.keyboard.press('Control+f');
    assert.equal(await input.inputValue(), 'parser tests',
        'reopening keeps the previous query');
    assert.deepEqual(
        await input.evaluate(element => [
            element.selectionStart,
            element.selectionEnd,
        ]),
        [0, 'parser tests'.length],
        'reopening selects the previous query for replacement'
    );
});

test('CONVERSATION-FIND-001 steps through matches with Enter, Shift+Enter, and the bar controls', async t => {
    const { page } = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: findFixtureOverrides(),
    });
    await page.keyboard.press('Control+f');
    const input = page.locator('[data-find-input]');
    const count = page.locator('[data-find-count]');
    await input.fill('parser');
    assert.equal(await count.textContent(), '1 of 3');

    await input.press('Enter');
    assert.equal(await count.textContent(), '2 of 3');
    assert.deepEqual(await currentFindMatch(page), {
        text: 'parser',
        start: 0,
        end: 6,
    }, 'Enter advances to the match inside the inline code');

    await input.press('Enter');
    assert.equal(await count.textContent(), '3 of 3');
    const third = await currentFindMatch(page);
    assert.equal(third.text, ' tests and updated the parser module.');
    assert.equal(third.start, 23);

    await input.press('Enter');
    assert.equal(await count.textContent(), '1 of 3',
        'Enter wraps around to the first match');

    await input.press('Shift+Enter');
    assert.equal(await count.textContent(), '3 of 3',
        'Shift+Enter steps backwards with wrap-around');

    await page.locator('[data-find-next]').click();
    assert.equal(await count.textContent(), '1 of 3',
        'the next control advances with wrap-around');
    await page.locator('[data-find-previous]').click();
    assert.equal(await count.textContent(), '3 of 3',
        'the previous control steps back with wrap-around');

    await page.locator('[data-conversation-scroll]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await count.textContent(), '3 of 3',
        'Enter outside the query input never steals navigation');
});

test('CONVERSATION-FIND-001 scrolls the current match into view', async t => {
    const interactionIds = Array.from(
        { length: 10 },
        (_unused, index) => `input-${index + 1}`
    );
    const messages = [];
    interactionIds.forEach((id, index) => {
        messages.push({
            id: `${id}:user`,
            interactionId: id,
            role: 'user',
            markdown: `Filler question ${index + 1} keeps the conversation tall enough to scroll.`,
        });
        messages.push({
            id: `${id}:assistant:0`,
            interactionId: id,
            role: 'assistant',
            markdown: index === interactionIds.length - 1
                ? 'The needle surfaces only at the very end of this conversation.'
                : `Filler answer ${index + 1} adds even more vertical space to the conversation.`,
        });
    });
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds,
        interactionId: 'input-10',
        pageOverrides: {
            messages,
            interactionStates: interactionIds.map(id => ({
                interactionId: id,
                responseState: 'complete',
            })),
        },
    });
    await page.evaluate(() => {
        document.querySelector('[data-conversation-scroll]').scrollTop = 0;
    });

    await page.keyboard.press('Control+f');
    await page.locator('[data-find-input]').fill('needle');
    const metrics = await page.evaluate(() => {
        const scroll = document.querySelector('[data-conversation-scroll]');
        const highlight = CSS.highlights.get('conversation-find-current');
        const range = highlight ? highlight.values().next().value : null;
        const bounds = range ? range.getBoundingClientRect() : null;
        const view = scroll.getBoundingClientRect();
        return {
            scrollTop: scroll.scrollTop,
            visible: !!bounds && bounds.top >= view.top
                && bounds.bottom <= view.bottom,
        };
    });
    assert.ok(metrics.scrollTop > 0,
        'a match below the fold scrolls the conversation');
    assert.equal(metrics.visible, true,
        'the current match lands inside the viewport');
});

test('CONVERSATION-FIND-001 flags queries without matches and caps runaway result sets', async t => {
    const { page } = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: {
            messages: [{
                id: 'input-1:user',
                interactionId: 'input-1',
                role: 'user',
                markdown: 'a'.repeat(2100),
            }],
            interactionStates: [{
                interactionId: 'input-1',
                responseState: 'complete',
            }],
        },
    });
    const findBar = page.locator('[data-conversation-find]');
    await page.keyboard.press('Control+f');
    const input = page.locator('[data-find-input]');
    const count = page.locator('[data-find-count]');

    await input.fill('zz');
    assert.equal(await count.textContent(), 'No results');
    assert.equal(
        await findBar.evaluate(
            element => element.classList.contains('conversation-find-no-results')
        ),
        true,
        'a query without matches flags the find bar'
    );
    assert.equal(
        await page.evaluate(() => CSS.highlights.has('conversation-find')),
        false,
        'a query without matches paints nothing'
    );

    await input.fill('aa');
    assert.equal(await count.textContent(), '1 of 999+',
        'runaway result sets stop at the announced cap');
    assert.equal(
        await findBar.evaluate(
            element => element.classList.contains('conversation-find-no-results')
        ),
        false,
        'matches clear the no-results flag'
    );
});

test('CONVERSATION-FIND-001 reapplies the query after authoritative page refreshes', async t => {
    const { page } = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: findFixtureOverrides(),
    });
    await page.keyboard.press('Control+f');
    await page.locator('[data-find-input]').fill('parser');
    assert.equal(
        await page.locator('[data-find-count]').textContent(),
        '1 of 3'
    );

    await sendPage(page, {
        type: 'conversation-viewer-page',
        version: 1,
        requestId: 100,
        subscriptionGeneration: 1,
        updateKind: 'refresh',
        html: `<article data-conversation-message-id="${
            encodeURIComponent('input-1:user')
        }" data-interaction-id="input-1">
            <section class="conversation-markdown">
                <p>Add tests for the parser</p>
            </section>
        </article>
        <article data-conversation-message-id="${
            encodeURIComponent('input-1:assistant:0')
        }" data-interaction-id="input-1">
            <section class="conversation-markdown">
                <p>I added <code>parser</code> tests and updated the parser module.</p>
            </section>
        </article>
        <article data-conversation-message-id="${
            encodeURIComponent('input-1:assistant:1')
        }" data-interaction-id="input-1">
            <section class="conversation-markdown">
                <p>Another parser pass.</p>
            </section>
        </article>`,
        outline: [{
            interactionId: 'input-1',
            userPreview: 'Add tests for the parser',
            responseState: 'complete',
        }],
        selectedInteractionId: 'input-1',
        selectedInput: 1,
        totalInputs: 1,
        partial: false,
        atLatest: true,
        stale: false,
        subagents: [],
        activeSubagent: null,
    });
    await page.waitForFunction(() =>
        document.querySelector('[data-find-count]')?.textContent === '1 of 4');
    assert.deepEqual(await page.evaluate(() => ({
        all: CSS.highlights.get('conversation-find')?.size ?? 0,
        current: CSS.highlights.get('conversation-find-current')?.size ?? 0,
    })), { all: 4, current: 1 },
        'the refreshed page repaints every match and keeps the position');
});

test('CONVERSATION-FIND-001 anchors the find bar to the top-right of the conversation viewport', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: findFixtureOverrides(),
    });
    await page.keyboard.press('Control+f');
    await page.locator('[data-find-input]').waitFor();
    const geometry = await page.evaluate(() => {
        const toRect = element => {
            const rect = element.getBoundingClientRect();
            return {
                top: rect.top,
                right: rect.right,
                bottom: rect.bottom,
                left: rect.left,
                width: rect.width,
            };
        };
        const bar = document.querySelector('[data-conversation-find]');
        const barRect = bar.getBoundingClientRect();
        const hit = document.elementFromPoint(
            barRect.left + barRect.width / 2,
            barRect.top + barRect.height / 2
        );
        return {
            bar: toRect(bar),
            header: toRect(document.querySelector('.conversation-header')),
            scroll: toRect(
                document.querySelector('[data-conversation-scroll]')
            ),
            overlaysContent: !!hit && bar.contains(hit),
        };
    });
    assert.ok(geometry.bar.top >= geometry.header.bottom - 1,
        `the find bar clears the header: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bar.right <= geometry.scroll.right + 1
        && geometry.bar.right >= geometry.scroll.right - 40,
        `the find bar hugs the right edge of the viewport: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.bar.left > geometry.scroll.left + geometry.scroll.width / 2,
        `the find bar sits in the right half: ${JSON.stringify(geometry)}`);
    assert.equal(geometry.overlaysContent, true,
        'the find bar floats above the conversation content');
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 keeps the outline usable with previous bookmark markup', async t => {
    const pageErrors = [];
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageErrors,
        bookmarkStore: {
            async load() {
                return { revision: 1, interactionIds: ['input-1'] };
            },
            async save() {},
        },
        transformHostDocument(html) {
            return html.replace(
                /<button type="button"\s+class="conversation-outline-bookmarks-only"[\s\S]*?<\/button>/,
                `<button type="button"
                    class="conversation-outline-bookmarks-only"
                    data-outline-bookmarks-only aria-pressed="false"
                    title="Show bookmarked inputs only">☆ 0</button>`
            );
        },
    });

    await page.locator('[data-action="toggle-sidebar"]').click();
    assert.equal(pageErrors.length, 0);
    assert.equal(
        await page.locator('[data-outline-interaction-id]').count(),
        1
    );
    assert.equal(
        await page.locator('[data-outline-bookmarks-only]')
            .getAttribute('aria-label'),
        'Show bookmarked inputs only, 1 bookmark'
    );
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 keeps every side-panel view usable across adjacent document and script generations', async t => {
    async function assertPanelViews(page, label) {
        await page.locator('[data-action="toggle-sidebar"]').click();
        assert.equal(
            await page.locator('[data-conversation-sidebar]').isVisible(),
            true,
            `${label}: the side panel should open`
        );
        assert.equal(
            await page.locator('[data-conversation-outline]').isVisible(),
            true,
            `${label}: Outline should remain available`
        );
        await page.locator('[data-sidebar-tab="comments"]').click();
        assert.equal(
            await page.locator('[data-conversation-comments]').isVisible(),
            true,
            `${label}: Comments should remain available`
        );
        await page.locator('[data-sidebar-tab="subagents"]').click();
        assert.equal(
            await page.locator('[data-conversation-subagents]').isVisible(),
            true,
            `${label}: Subagents should remain available`
        );
    }

    const previousViewerScript = viewerScript
        .replace(
            "    var outlineRoot = document.querySelector('[data-conversation-outline]');\n",
            "    var outlineRoot = document.querySelector('[data-conversation-outline]');\n"
                + "    var outlineCount = document.querySelector('[data-outline-count]');\n"
                + "    var outlineSummary = document.querySelector('[data-outline-summary]');\n"
        )
        .replace(
            "    var outlineSort = document.querySelector('[data-outline-sort]');\n",
            ''
        )
        .replace(
            '        && !!outlineSearch\n',
            '        && !!outlineSummary && !!outlineSearch\n'
        )
        .replace(
            '        outlineSearch: outlineSearch,\n',
            '        outlineCount: outlineCount,\n'
                + '        outlineSummary: outlineSummary,\n'
                + '        outlineSearch: outlineSearch,\n'
        )
        .replace(
            '        outlineSort: outlineSort,\n',
            ''
        );
    const previousOutlineScript = conversationOutlineScript
        .replace(
            '        var outlineSearch = options.outlineSearch;\n',
            '        var outlineCount = options.outlineCount;\n'
                + '        var outlineSummary = options.outlineSummary;\n'
                + '        var outlineSearch = options.outlineSearch;\n'
        )
        .replace('        var outlineSort = options.outlineSort;\n', '')
        .replace('            newestFirst: true,\n', '')
        .replace(
            /\n        function renderSortState\(\) \{[\s\S]*?\n        \}\n\n        function buildOutlineList\(\) \{\n            var fragment = document.createDocumentFragment\(\);\n            var entries = state.newestFirst\n                \? state.outline.slice\(\).reverse\(\)\n                : state.outline;\n            entries.forEach\(function \(entry\) \{/,
            '\n        function buildOutlineList() {\n'
                + '            var fragment = document.createDocumentFragment();\n'
                + '            state.outline.forEach(function (entry) {'
        )
        .replace(
            '            outlinePartial.hidden = !message.partial;\n',
            '            if (outlineCount) {\n'
                + '                outlineCount.textContent = String(message.outline.length);\n'
                + '                outlineCount.setAttribute(\n'
                + "                    'aria-label',\n"
                + "                    message.outline.length + ' inputs'\n"
                + '                );\n'
                + '            }\n'
                + '            outlineSummary.textContent = message.partial\n'
                + "                ? message.outline.length.toLocaleString() + '+ latest inputs'\n"
                + "                : message.outline.length.toLocaleString() + ' inputs';\n"
                + '            outlinePartial.hidden = !message.partial;\n'
        )
        .replace('            renderSortState();\n', '')
        .replace(
            /            if \(outlineSort\) \{\n                outlineSort.addEventListener\('click', function \(\) \{\n                    state.newestFirst = !state.newestFirst;\n                    renderSortState\(\);\n                    buildOutlineList\(\);\n                    filterOutline\(\);\n                \}\);\n            \}\n/,
            ''
        );
    const sha256 = source => crypto.createHash('sha256')
        .update(source)
        .digest('hex');
    assert.equal(
        sha256(previousViewerScript),
        '55deabeef15028403d1fa36bef88d58080c14f8bbd2fcd4b1155bc6cf4990861',
        'the previous Viewer fixture must stay byte-exact'
    );
    assert.equal(
        sha256(previousOutlineScript),
        'ce8a54a5657c344b37d709fece61cf05af18cc4e2ab55c1e418b386b46e127b3',
        'the previous Outline fixture must stay byte-exact'
    );

    const previousScriptErrors = [];
    const previousScript = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageErrors: previousScriptErrors,
        viewerScriptSource: previousViewerScript,
        outlineScriptSource: previousOutlineScript,
    });
    await assertPanelViews(previousScript.page, 'previous scripts');
    assert.deepEqual(previousScriptErrors, []);

    const previousDocumentErrors = [];
    const previousDocument = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageErrors: previousDocumentErrors,
        transformHostDocument(html) {
            return html.replace(
                /                    <button type="button"\s+                        class="conversation-outline-sort"[\s\S]*?                    <span data-outline-summary hidden aria-hidden="true"><\/span>/,
                '                    <span class="conversation-outline-summary"\n'
                    + '                        data-outline-summary>No inputs yet</span>'
            );
        },
    });
    assert.equal(
        await previousDocument.page.locator('[data-outline-sort]').count(),
        0,
        'the previous document fixture must not expose the sort control'
    );
    assert.equal(
        await previousDocument.page.locator('[data-outline-summary]')
            .getAttribute('class'),
        'conversation-outline-summary',
        'the previous document fixture must expose its visible summary marker'
    );
    await assertPanelViews(previousDocument.page, 'previous document');
    assert.deepEqual(previousDocumentErrors, []);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 keeps unbookmarked controls visible in dark and forced-color themes', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: ['input-1'],
        interactionId: 'input-1',
    });
    await page.locator('[data-action="toggle-sidebar"]').click();
    const bookmark = page.locator('[data-outline-bookmark-id="input-1"]');

    assert.equal(await bookmark.evaluate(element =>
        Number(getComputedStyle(element).opacity)), 1);
    assert.equal(
        await bookmark.evaluate(element => getComputedStyle(element).color),
        viewerThemeFixtures[0].tokens.descriptionForeground
    );

    await page.emulateMedia({ forcedColors: 'active' });
    assert.equal(await bookmark.evaluate(element =>
        Number(getComputedStyle(element).opacity)), 1);
    assert.notEqual(
        await bookmark.evaluate(element => getComputedStyle(element).color),
        'rgba(0, 0, 0, 0)'
    );
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 keeps four-digit input numbers inside compact trailing metadata', async t => {
    const interactionIds = [
        'input-1997', 'input-1998', 'input-1999', 'input-2000',
    ];
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[1],
        viewport: { width: 1050, height: 620 },
        interactionIds,
        interactionId: 'input-2000',
        totalInteractions: 2000,
        outlinePartial: true,
    });
    await page.locator('[data-action="toggle-sidebar"]').click();

    const layout = await page.locator(
        '[data-outline-interaction-id="input-2000"]'
    ).evaluate(button => {
        const outline = button.closest('[data-conversation-outline]');
        const number = button.querySelector('.conversation-outline-number');
        const preview = button.querySelector('.conversation-outline-preview');
        const numberRange = document.createRange();
        numberRange.selectNodeContents(number);
        const buttonRect = button.getBoundingClientRect();
        const numberTextRect = numberRange.getBoundingClientRect();
        const previewRect = preview.getBoundingClientRect();
        return {
            number: number.textContent,
            numberInside: numberTextRect.left >= previewRect.right
                && numberTextRect.right <= buttonRect.right,
            previewInset: previewRect.left
                - outline.getBoundingClientRect().left,
        };
    });
    assert.deepEqual(layout, {
        number: '2000',
        numberInside: true,
        previewInset: layout.previewInset,
    });
    assert.ok(
        layout.previewInset >= 11 && layout.previewInset <= 15,
        `four-digit outline text inset should stay balanced, got ${layout.previewInset}px`
    );
});

test('CONVERSATION-SESSION-REBIND-001 renders comments and bookmarks copied to the rebound Session', async t => {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-conversation-rebind-browser-')
    );
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const commentStore = new ConversationCommentFileStore(root);
    const bookmarkStore = new ConversationBookmarkFileStore(root);
    const previous = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    };
    const next = { ...previous, sessionId: 'session-host-document' };
    await commentStore.save(previous, {
        revision: 5,
        comments: [{
            id: 'rebound-comment',
            messageId: 'input-2:user',
            interactionId: 'input-2',
            role: 'user',
            quote: 'input-2',
            prefix: '',
            suffix: '',
            comment: 'Survives the root rollover.',
            status: 'open',
        }],
    });
    await bookmarkStore.save(previous, {
        revision: 4,
        interactionIds: ['input-2'],
    });
    await Promise.all([
        commentStore.copyForRebind(previous, next),
        bookmarkStore.copyForRebind(previous, next),
    ]);

    const { page } = await openHostViewerDocument(t, {
        initialWebviewState: {
            conversationCommentsPanel: {
                open: true,
                width: 240,
                view: 'comments',
            },
        },
        commentStore,
        bookmarkStore,
    });

    assert.equal(
        await page.locator('[data-comment-id="rebound-comment"]').count(),
        1
    );
    assert.equal(
        await page.locator('[data-outline-bookmark-id="input-2"]')
            .getAttribute('aria-pressed'),
        'true'
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
    const sidebarToggle = page.locator('[data-action="toggle-sidebar"]');
    const panel = page.locator('[data-conversation-sidebar]');
    const comments = page.locator('[data-conversation-comments]');
    const resizer = page.locator('[data-comments-resizer]');

    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.isHidden(), true);
    await sidebarToggle.click();
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await comments.isHidden(), true);
    assert.equal(await resizer.getAttribute('aria-valuenow'), '240');

    await resizer.press('ArrowLeft');
    await resizer.press('ArrowLeft');
    assert.equal(await resizer.getAttribute('aria-valuenow'), '272');
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState.conversationSidebar),
        {
            open: true,
            width: 272,
            view: 'outline',
            query: '',
            subagentsRunningOnly: false,
        }
    );

    await sidebarToggle.click();
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.isHidden(), true);
    assert.equal(await resizer.isHidden(), true);
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState.conversationSidebar),
        {
            open: false,
            width: 272,
            view: 'outline',
            query: '',
            subagentsRunningOnly: false,
        }
    );

    const restored = await openHostViewerDocument(t, {
        ...options,
        initialWebviewState: {
            conversationCommentsPanel: { open: false, width: 312 },
        },
    });
    const restoredToggle = restored.page.locator(
        '[data-action="toggle-sidebar"]'
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
                conversationKeepsReadingWidth: conversation.width > 0,
            };
        }),
        {
            sidebarRightAligned: true,
            sidebarOverConversation: false,
            conversationUsesWorkspace: false,
            conversationKeepsReadingWidth: true,
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
                open: true, width: 240, view: 'outline', query: '',
            },
        },
    });
    assert.deepEqual(
        await extraNarrow.page.evaluate(() => {
            const sidebar = document.querySelector(
                '[data-conversation-sidebar]'
            ).getBoundingClientRect();
            const search = document.querySelector(
                '[data-outline-search]'
            ).getBoundingClientRect();
            const bookmarks = document.querySelector(
                '[data-outline-bookmarks-only]'
            ).getBoundingClientRect();
            const sort = document.querySelector(
                '[data-outline-sort]'
            ).getBoundingClientRect();
            return {
                leftVisible: sidebar.left >= 0,
                rightVisible: sidebar.right <= window.innerWidth,
                controlsFit: search.left >= sidebar.left
                    && sort.right <= sidebar.right
                    && search.right < bookmarks.left
                    && bookmarks.right < sort.left,
            };
        }),
        {
            leftVisible: true,
            rightVisible: true,
            controlsFit: true,
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
        const sidebarToggle = document.querySelector(
            '[data-action="toggle-sidebar"]'
        );
        const resizer = document.querySelector('[data-comments-resizer]');
        for (let index = 0; index < 100; index += 1) {
            sidebarToggle.click();
            resizer.dispatchEvent(new KeyboardEvent('keydown', {
                key: index % 2 === 0 ? 'ArrowLeft' : 'ArrowRight',
                bubbles: true,
            }));
            sidebarToggle.click();
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

test('CONVERSATION-COMMENTS-UI-001 send action and telemetry comments pill drive the comments flow', async t => {
    const interactionId = 'input-header-send';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationSidebar: {
                open: true,
                width: 240,
                view: 'outline',
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

    // The header chrome is one uniform row of four icon buttons; sending
    // lives in the comments toolbar, not the header.
    const navButtons = page.locator('.conversation-navigation [data-action]');
    assert.equal(await navButtons.count(), 4);
    assert.equal(
        await page.locator('[data-action="send-comments"]').count(),
        0,
        'header must not carry a Send button'
    );
    assert.deepEqual(
        await navButtons.evaluateAll(buttons => buttons.map(button => ({
            text: button.innerText,
            icons: button.querySelectorAll('svg').length,
        }))),
        [
            { text: '', icons: 1 },
            { text: '', icons: 1 },
            { text: '', icons: 1 },
            { text: '', icons: 1 },
        ],
        'header buttons must stay icon-only'
    );
    assert.deepEqual(
        (await navButtons.evaluateAll(buttons =>
            Array.from(new Set(buttons.map(button => {
                const box = button.getBoundingClientRect();
                return Math.round(box.width) + 'x' + Math.round(box.height);
            })))
        )),
        ['28x28'],
        'header buttons must render as one uniform row of 28px icons'
    );
    assert.deepEqual(
        (await navButtons.evaluateAll(buttons =>
            Array.from(new Set(buttons.map(button =>
                Math.round(
                    button.querySelector('svg').getBoundingClientRect().width
                )
            )))
        )),
        [16],
        'header icons must render at 16px'
    );

    const toolbarSend = page.locator(
        '[data-comments-toolbar] [data-comment-action="send"]'
    );
    const pill = page.locator('[data-telemetry-comments]');
    assert.equal(await toolbarSend.isDisabled(), true);
    assert.equal(await pill.isVisible(), true);
    assert.equal(await pill.innerText(), '0');

    await page.locator('[data-sidebar-tab="comments"]').click();
    await page.locator('[data-comment-action="new"]').click();
    await page.locator('[data-comment-input]').fill(
        'Check the rollout constraint.'
    );
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    const comment = {
        id: 'note-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Check the rollout constraint.',
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
    }, { request: addRequest, comment });

    assert.equal(await toolbarSend.isDisabled(), false);
    assert.equal(
        await toolbarSend.getAttribute('title'),
        'Send 1 open comment to the session input'
    );
    assert.equal(await pill.isVisible(), true);
    assert.equal(await pill.innerText(), '1/1');

    await page.locator('[data-sidebar-tab="outline"]').click();
    await pill.click();
    assert.equal(
        await page.locator('[data-sidebar-tab="comments"]')
            .getAttribute('aria-selected'),
        'true'
    );
    await toolbarSend.click();
    const sendRequest = (await postedMessages(page)).at(-1);
    assert.equal(sendRequest.type, 'conversation-viewer-send-comments');
    assert.equal(sendRequest.operation, 'sendComments');
});

function projectCommentSettlement(request, comments, overrides = {}) {
    return {
        type: 'conversation-viewer-project-comments-result',
        version: 1,
        requestId: request.requestId,
        subscriptionGeneration: request.subscriptionGeneration,
        projectId: request.projectId,
        provider: request.provider,
        sessionId: request.sessionId,
        operation: request.operation,
        success: true,
        revision: 1,
        comments,
        ...overrides,
    };
}

test('PROJECT-COMMENTS-UI-001 captures, tags, filters, and dispatches project notes', async t => {
    const interactionId = 'input-project-notes';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationSidebar: {
                open: true,
                width: 280,
                view: 'outline',
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

    await page.locator('[data-sidebar-tab="comments"]').click();
    const projectSection = page.locator('[data-project-comments]');
    const projectHeader = page.locator('[data-project-comments-header]');
    assert.equal(await projectSection.isVisible(), true);
    assert.equal(
        await projectHeader.locator(
            '.conversation-comments-section-title'
        ).innerText(),
        'WORKSPACE'
    );
    assert.equal(
        await page.locator('[data-session-comments-provider]').count(),
        0
    );

    // The composer stays tucked away until the section's + button opens it.
    const composer = projectSection.locator('[data-project-comment-composer]');
    assert.equal(await composer.isVisible(), false);
    await projectHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    assert.equal(await composer.isVisible(), true);

    // Quick capture with a draft tag, submitted via Ctrl+Enter.
    const input = projectSection.locator('[data-project-comment-input]');
    const addButton = projectSection.locator(
        '[data-project-comment-action="add"]'
    );
    assert.equal(await addButton.isDisabled(), true);
    await input.fill('遥测条在窄窗口下横向溢出');
    assert.equal(await addButton.isDisabled(), false);
    await projectSection.locator(
        '[data-project-comment-action="add-draft-tag"]'
    ).click();
    const draftTagInput = projectSection.locator(
        '[data-project-comment-draft-tag-input]'
    );
    await draftTagInput.fill('bug');
    await draftTagInput.press('Enter');
    assert.equal(
        await projectSection.locator(
            '[data-project-comment-draft-tags] .conversation-project-comment-tag'
        ).innerText(),
        'bug\n×'
    );
    await input.press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    assert.equal(
        addRequest.type,
        'conversation-viewer-project-comment-mutation'
    );
    assert.equal(addRequest.operation, 'add');
    assert.equal(addRequest.expectedRevision, 0);
    assert.deepEqual(addRequest.payload, {
        text: '遥测条在窄窗口下横向溢出',
        tags: ['bug'],
    });

    const noteOne = {
        id: 'note-1',
        text: '遥测条在窄窗口下横向溢出',
        tags: ['bug'],
        status: 'open',
        createdAt: 1000,
        dispatches: [],
    };
    await sendPage(page, projectCommentSettlement(addRequest, [noteOne]));
    const cards = projectSection.locator('[data-project-comment-id]');
    assert.equal(await cards.count(), 1);
    assert.equal(
        await cards.first().locator(
            '.conversation-project-comment-tag'
        ).first().innerText(),
        'bug\n×'
    );
    // Tags live on their own row at the bottom of the card, keeping the
    // heading row to status + icon actions like Session cards.
    assert.equal(
        await cards.first().evaluate(element =>
            element.lastElementChild.className
        ),
        'conversation-project-comment-tags-row'
    );
    assert.equal(
        await cards.first().locator(
            '.conversation-project-comment-status'
        ).innerText(),
        'Open'
    );
    assert.equal(await input.inputValue(), '');
    assert.equal(await composer.isVisible(), false);
    const filterChips = projectSection.locator(
        '[data-project-comment-tag-filter] button'
    );
    assert.deepEqual(
        await filterChips.allInnerTexts(),
        ['All · 1', 'bug · 1']
    );

    // A second, untagged note lands on top (newest first).
    await projectHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    await input.fill('支持一键 spawn 新 session');
    await addButton.click();
    const addSecond = (await postedMessages(page)).at(-1);
    const noteTwo = {
        id: 'note-2',
        text: '支持一键 spawn 新 session',
        tags: [],
        status: 'open',
        createdAt: 2000,
        dispatches: [],
    };
    await sendPage(
        page,
        projectCommentSettlement(addSecond, [noteOne, noteTwo], {
            revision: 2,
        })
    );
    assert.equal(await cards.count(), 2);
    assert.equal(
        await cards.first().getAttribute('data-project-comment-id'),
        'note-2'
    );

    // Tag filtering narrows the list and toggles back off.
    await filterChips.nth(1).click();
    assert.equal(await cards.count(), 1);
    assert.equal(
        await cards.first().getAttribute('data-project-comment-id'),
        'note-1'
    );
    await filterChips.first().click();
    assert.equal(await cards.count(), 2);

    // Sending dispatches to the current session and keeps the note open.
    await projectSection.locator(
        '[data-project-comment-id="note-1"]'
    ).locator('[data-project-comment-action="send"]').click();
    const sendRequest = (await postedMessages(page)).at(-1);
    assert.equal(
        sendRequest.type,
        'conversation-viewer-send-project-comment'
    );
    assert.equal(sendRequest.operation, 'sendProjectComment');
    assert.deepEqual(sendRequest.payload, { commentId: 'note-1' });
    await sendPage(page, projectCommentSettlement(
        sendRequest,
        [
            {
                ...noteOne,
                dispatches: [{
                    provider: 'codex',
                    sessionId: 'session-host-document',
                    at: 3000,
                }],
            },
            noteTwo,
        ],
        { revision: 3 }
    ));
    const dispatchedCard = projectSection.locator(
        '[data-project-comment-id="note-1"]'
    );
    assert.match(
        await dispatchedCard.locator(
            '.conversation-project-comment-dispatch'
        ).innerText(),
        /Sent to Codex/
    );
    assert.equal(
        await dispatchedCard.locator(
            '.conversation-project-comment-status'
        ).innerText(),
        'Open'
    );

    // Both section headers collapse their group and expand it back.
    await projectHeader.locator('.conversation-comments-section-title')
        .click();
    assert.equal(
        await projectSection.locator('[data-project-comments-content]')
            .isVisible(),
        false
    );
    assert.equal(
        await projectHeader.locator('[data-comments-section-toggle]')
            .getAttribute('aria-expanded'),
        'false'
    );
    await projectHeader.locator('[data-comments-section-toggle]').click();
    assert.equal(
        await projectSection.locator('[data-project-comments-content]')
            .isVisible(),
        true
    );

    const sessionHeader = page.locator('[data-session-comments-header]');
    await sessionHeader.locator('.conversation-comments-section-title')
        .click();
    assert.equal(
        await page.locator('[data-session-comments-content]').isVisible(),
        false
    );
    await sessionHeader.locator('[data-comments-section-toggle]').click();
    assert.equal(
        await page.locator('[data-session-comments-content]').isVisible(),
        true
    );

    // The section + button must not toggle the group, and pressing it
    // while the group is collapsed must unfold it first.
    await projectHeader.locator('.conversation-comments-section-title')
        .click();
    assert.equal(
        await projectSection.locator('[data-project-comments-content]')
            .isVisible(),
        false
    );
    await projectHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    assert.equal(
        await projectSection.locator('[data-project-comments-content]')
            .isVisible(),
        true
    );
    assert.equal(
        await projectSection.locator('[data-project-comment-composer]')
            .isVisible(),
        true
    );
});

test('PROJECT-COMMENTS-UI-001 toggles, edits, and deletes notes with source snapshots', async t => {
    const interactionId = 'input-project-notes-manage';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationSidebar: {
                open: true,
                width: 280,
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

    const projectSection = page.locator('[data-project-comments]');
    await page.locator('[data-project-comments-header]')
        .locator('[data-project-comment-action="open-composer"]')
        .click();
    const input = projectSection.locator('[data-project-comment-input]');
    await input.fill('浏览器测试要跑全量');
    await projectSection.locator(
        '[data-project-comment-action="add"]'
    ).click();
    const addRequest = (await postedMessages(page)).at(-1);
    const note = {
        id: 'note-1',
        text: '浏览器测试要跑全量',
        tags: ['optimize'],
        status: 'open',
        createdAt: 1000,
        source: {
            provider: 'kimi',
            sessionId: 'session-source',
            quote: '292 > 281 at 281px',
        },
        dispatches: [],
    };
    await sendPage(page, projectCommentSettlement(addRequest, [note]));

    // The source snapshot renders as display-only provenance.
    const card = projectSection.locator('[data-project-comment-id="note-1"]');
    assert.equal(
        await card.locator('.conversation-comment-quote-label').innerText(),
        'FROM KIMI SESSION'
    );
    assert.equal(
        await card.locator('.conversation-comment-quote blockquote')
            .innerText(),
        '292 > 281 at 281px'
    );
    assert.equal(
        await card.locator(
            '[data-project-comment-action="locate"]'
        ).count(),
        0
    );

    // The status pill toggles done and the card collapses.
    await card.locator('.conversation-project-comment-status').click();
    const doneRequest = (await postedMessages(page)).at(-1);
    assert.equal(doneRequest.operation, 'setStatus');
    assert.deepEqual(doneRequest.payload, {
        commentId: 'note-1',
        status: 'done',
    });
    await sendPage(page, projectCommentSettlement(
        doneRequest,
        [{ ...note, status: 'done', doneAt: 2000 }],
        { revision: 2 }
    ));
    assert.equal(
        await card.getAttribute('data-comment-status'),
        'done'
    );
    assert.equal(
        await card.locator(
            '.conversation-comment-collapsed-body'
        ).innerText(),
        '浏览器测试要跑全量'
    );

    // Reopen, then edit the text in place.
    await card.locator('.conversation-project-comment-status').click();
    const reopenRequest = (await postedMessages(page)).at(-1);
    await sendPage(page, projectCommentSettlement(
        reopenRequest,
        [note],
        { revision: 3 }
    ));
    await card.locator('[data-project-comment-action="edit"]').click();
    const editor = card.locator('[data-project-comment-edit]');
    await editor.fill('浏览器测试要跑全量（含 CSS 回归）');
    await editor.press('Control+Enter');
    const updateRequest = (await postedMessages(page)).at(-1);
    assert.equal(updateRequest.operation, 'update');
    assert.deepEqual(updateRequest.payload, {
        commentId: 'note-1',
        text: '浏览器测试要跑全量（含 CSS 回归）',
    });
    await sendPage(page, projectCommentSettlement(
        updateRequest,
        [{ ...note, text: '浏览器测试要跑全量（含 CSS 回归）' }],
        { revision: 4 }
    ));
    assert.equal(
        await card.locator('.conversation-comment-body').innerText(),
        '浏览器测试要跑全量（含 CSS 回归）'
    );

    // Card-level tag editing posts addTag/removeTag mutations.
    await card.locator(
        '[data-project-comment-action="open-tag-editor"]'
    ).click();
    const tagInput = card.locator('[data-project-comment-tag-input]');
    await tagInput.fill('ci');
    await tagInput.press('Enter');
    const tagRequest = (await postedMessages(page)).at(-1);
    assert.equal(tagRequest.operation, 'addTag');
    assert.deepEqual(tagRequest.payload, {
        commentId: 'note-1',
        tag: 'ci',
    });
    await sendPage(page, projectCommentSettlement(
        tagRequest,
        [{ ...note, tags: ['optimize', 'ci'] }],
        { revision: 5 }
    ));
    assert.deepEqual(
        await card.locator('.conversation-project-comment-tag')
            .allInnerTexts(),
        ['optimize\n×', 'ci\n×']
    );
    await card.locator(
        '[data-project-comment-action="remove-tag"]'
    ).first().click();
    const removeTagRequest = (await postedMessages(page)).at(-1);
    assert.deepEqual(removeTagRequest.payload, {
        commentId: 'note-1',
        tag: 'optimize',
    });

    // Delete returns the section to its empty state.
    await sendPage(page, projectCommentSettlement(
        removeTagRequest,
        [note],
        { revision: 6 }
    ));
    await card.locator('[data-project-comment-action="delete"]').click();
    const deleteRequest = (await postedMessages(page)).at(-1);
    assert.deepEqual(deleteRequest.payload, { commentId: 'note-1' });
    await sendPage(page, projectCommentSettlement(
        deleteRequest,
        [],
        { revision: 7 }
    ));
    assert.equal(
        await projectSection.locator('[data-project-comment-id]').count(),
        0
    );
    assert.equal(
        await projectSection.locator('[data-project-comment-empty]')
            .isVisible(),
        true
    );
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

test('CONVERSATION-COMMENTS-ORDERING-001 drags cards into a Host-authoritative order and preserves keyboard focus', async t => {
    const comments = [{
        id: 'comment-first',
        messageId: 'input-comment-order:user',
        interactionId: 'input-comment-order',
        role: 'user',
        quote: 'Alpha',
        prefix: '',
        suffix: ' beta gamma.',
        comment: 'First comment.',
        status: 'open',
    }, {
        id: 'comment-second',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Second comment.',
        status: 'done',
    }, {
        id: 'comment-third',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Third comment.',
        status: 'open',
    }];
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 800 },
        initialWebviewState: {
            conversationCommentsPanel: {
                open: true,
                width: 192,
                view: 'comments',
            },
        },
        interactionIds: ['input-comment-order'],
        interactionId: 'input-comment-order',
        markdown: 'Alpha beta gamma.',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
        commentStore: {
            async load() {
                return { revision: 7, comments };
            },
            async save() {},
        },
    });

    async function settle(request, success, revision, authoritativeComments) {
        await page.evaluate(({
            request, success, revision, authoritativeComments,
        }) => {
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
                    success,
                    revision,
                    comments: authoritativeComments,
                    ...(success ? {} : { error: 'failed' }),
                },
            }));
        }, { request, success, revision, authoritativeComments });
    }

    const cardIds = () => page.locator('[data-comment-list] [data-comment-id]')
        .evaluateAll(cards => cards.map(card =>
            card.getAttribute('data-comment-id')
        ));
    assert.deepEqual(await cardIds(), [
        'comment-first', 'comment-second', 'comment-third',
    ]);
    const handles = page.locator('[data-comment-drag-handle]');
    assert.equal(await handles.count(), 3);
    assert.deepEqual(
        await handles.evaluateAll(elements => elements.map(element => ({
            draggable: element.draggable,
            label: element.getAttribute('aria-label'),
            shortcuts: element.getAttribute('aria-keyshortcuts'),
            size: Math.round(element.getBoundingClientRect().width),
        }))),
        [
            {
                draggable: true,
                label: 'Move comment 1',
                shortcuts: 'Alt+ArrowUp Alt+ArrowDown',
                size: 22,
            },
            {
                draggable: true,
                label: 'Move comment 2',
                shortcuts: 'Alt+ArrowUp Alt+ArrowDown',
                size: 22,
            },
            {
                draggable: true,
                label: 'Move comment 3',
                shortcuts: 'Alt+ArrowUp Alt+ArrowDown',
                size: 22,
            },
        ]
    );
    assert.equal(
        await page.locator('[data-comment-list]').evaluate(element =>
            element.scrollWidth <= element.clientWidth
        ),
        true,
        'the minimum-width comments panel must not overflow horizontally'
    );

    await page.locator('[data-comment-id="comment-first"]')
        .locator('[data-comment-drag-handle]')
        .dragTo(
            page.locator('[data-comment-id="comment-third"]')
                .locator('.conversation-comment-body')
        );
    const dragRequest = (await postedMessages(page)).at(-1);
    assert.equal(dragRequest.type, 'conversation-viewer-comment-mutation');
    assert.equal(dragRequest.operation, 'reorder');
    assert.equal(dragRequest.expectedRevision, 7);
    assert.deepEqual(dragRequest.payload, {
        orderedCommentIds: [
            'comment-second', 'comment-third', 'comment-first',
        ],
    });
    assert.deepEqual(
        await cardIds(),
        ['comment-first', 'comment-second', 'comment-third'],
        'dragging must not optimistically commit the visible order'
    );
    assert.equal(
        await page.locator('[data-conversation-comments]')
            .getAttribute('aria-busy'),
        'true'
    );

    const reordered = [comments[1], comments[2], comments[0]];
    await settle(dragRequest, true, 8, reordered);
    assert.deepEqual(await cardIds(), [
        'comment-second', 'comment-third', 'comment-first',
    ]);
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'Comment order saved.'
    );
    assert.equal(
        await page.evaluate(() => document.activeElement
            ?.closest('[data-comment-id]')
            ?.getAttribute('data-comment-id')),
        'comment-first',
        'focus must follow the moved card after authoritative replacement'
    );

    const movedHandle = page.locator('[data-comment-id="comment-first"]')
        .locator('[data-comment-drag-handle]');
    await movedHandle.press('Alt+ArrowUp');
    const keyboardRequest = (await postedMessages(page)).at(-1);
    assert.equal(keyboardRequest.operation, 'reorder');
    assert.deepEqual(keyboardRequest.payload, {
        orderedCommentIds: [
            'comment-second', 'comment-first', 'comment-third',
        ],
    });
    await settle(keyboardRequest, false, 8, reordered);
    assert.deepEqual(await cardIds(), [
        'comment-second', 'comment-third', 'comment-first',
    ]);
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'The comment action failed. Your comments were kept.'
    );
    assert.equal(
        await page.evaluate(() => document.activeElement
            ?.closest('[data-comment-id]')
            ?.getAttribute('data-comment-id')),
        'comment-first'
    );

    await page.locator('[data-comment-filter="open"]').click();
    assert.deepEqual(await cardIds(), ['comment-third', 'comment-first']);
    await page.locator('[data-comment-id="comment-first"]')
        .locator('[data-comment-drag-handle]')
        .press('Alt+ArrowUp');
    const filteredRequest = (await postedMessages(page)).at(-1);
    assert.equal(filteredRequest.operation, 'reorder');
    assert.deepEqual(
        filteredRequest.payload,
        {
            orderedCommentIds: [
                'comment-second', 'comment-first', 'comment-third',
            ],
        },
        'filtered sorting must preserve the hidden done-card slot'
    );
    const filteredOrder = [comments[1], comments[0], comments[2]];
    await settle(filteredRequest, true, 9, filteredOrder);
    assert.deepEqual(await cardIds(), ['comment-first', 'comment-third']);
    await page.locator('[data-comment-filter="all"]').click();
    assert.deepEqual(await cardIds(), [
        'comment-second', 'comment-first', 'comment-third',
    ]);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 renders ghost session-switch rails that post exact switch intents', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 600 },
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        markdown: 'Alpha beta gamma delta.',
    });

    const buttons = page.locator('[data-session-nav]');
    assert.equal(await buttons.count(), 2);
    assert.deepEqual(
        await buttons.evaluateAll(elements => elements.map(element => ({
            direction: element.getAttribute('data-session-nav'),
            label: element.getAttribute('aria-label'),
            iconOnly: element.innerText === ''
                && element.querySelectorAll('svg').length === 1,
        }))),
        [
            {
                direction: 'previous',
                label: 'Previous active session',
                iconOnly: true,
            },
            {
                direction: 'next',
                label: 'Next active session',
                iconOnly: true,
            },
        ],
        'session rails must be two icon-only buttons'
    );

    const rail = page.locator('.conversation-session-nav-layer');
    assert.equal(await rail.evaluate(element =>
        getComputedStyle(element).pointerEvents
    ), 'none', 'the rail overlay must never block conversation interactions');

    // Ghost affordances stay compact and translucent until hovered.
    const next = page.locator('[data-session-nav="next"]');
    assert.deepEqual(
        await next.evaluate(element => {
            const style = getComputedStyle(element);
            return {
                position: style.position,
                width: style.width,
                height: style.height,
                borderRadius: style.borderRadius,
                opacity: style.opacity,
            };
        }),
        {
            position: 'absolute',
            width: '36px',
            height: '36px',
            borderRadius: '50%',
            opacity: '0.3',
        },
        'session rails must render as compact translucent circles'
    );

    const previousBox = await page.locator('[data-session-nav="previous"]')
        .boundingBox();
    const nextBox = await next.boundingBox();
    assert.equal(previousBox.x, 16);
    assert.equal(previousBox.y + previousBox.height, 600 - 16);
    assert.equal(nextBox.x + nextBox.width, 850 - 16);
    assert.equal(nextBox.y + nextBox.height, 600 - 16);

    await next.hover();
    await page.waitForFunction(() =>
        getComputedStyle(document.querySelector('[data-session-nav="next"]'))
            .opacity === '1'
    );
    assert.equal(await next.evaluate(element =>
        getComputedStyle(element).opacity
    ), '1', 'session rails must become fully opaque on hover');

    await next.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-switch-session',
        version: 1,
        direction: 'next',
    });
    await page.locator('[data-session-nav="previous"]').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-switch-session',
        version: 1,
        direction: 'previous',
    });
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 keeps session rails inside the conversation column when the side panel is open', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 600 },
        initialWebviewState: {
            conversationCommentsPanel: { open: true, width: 192 },
        },
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        markdown: 'Alpha beta gamma delta.',
    });

    const sidebar = page.locator('[data-conversation-sidebar]');
    assert.equal(await sidebar.isVisible(), true);
    const nextBox = await page.locator('[data-session-nav="next"]').boundingBox();
    const sidebarBox = await sidebar.boundingBox();
    assert.ok(
        nextBox.x + nextBox.width <= sidebarBox.x,
        `next rail right edge ${nextBox.x + nextBox.width} must stay left of the side panel at ${sidebarBox.x}`
    );
});

test('CONVERSATION-COMMENTS-UI-001 CONVERSATION-COMMENTS-SUBMIT-002 renders read-only icon-action cards with edit mode and per-card send', async t => {
    const interactionId = 'input-card-actions';
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

    function cardActions(cardLocator) {
        return cardLocator
            .locator('.conversation-comment-actions [data-comment-action]')
            .evaluateAll(buttons => buttons.map(button =>
                button.getAttribute('data-comment-action')
            ));
    }

    const selectBeta = () => page.locator('.conversation-markdown').evaluate(element => {
        const node = element.querySelector('p').firstChild;
        const start = node.nodeValue.indexOf('beta');
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 'beta'.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await selectBeta();

    // The selection bubble offers three icon actions: comment, save as
    // project note, and send.
    const selectionBubble = page.locator('[data-add-comment]');
    assert.equal(await selectionBubble.isVisible(), true);
    assert.deepEqual(
        await selectionBubble.locator('button').evaluateAll(buttons =>
            buttons.map(button => ({
                action: button.getAttribute('data-comment-selection-action'),
                iconOnly: button.innerText === ''
                    && button.querySelectorAll('svg').length === 1,
            }))
        ),
        [
            { action: 'comment', iconOnly: true },
            { action: 'project', iconOnly: true },
            { action: 'send', iconOnly: true },
        ],
        'selection bubble actions must be icon-only buttons'
    );
    // The send action is the bubble's accent chip; comment and project stay
    // ghosts.
    assert.deepEqual(
        await selectionBubble.locator('button').evaluateAll(buttons =>
            buttons.map(button => {
                const style = getComputedStyle(button);
                return {
                    action: button.getAttribute('data-comment-selection-action'),
                    background: style.backgroundColor,
                    color: style.color,
                };
            })
        ),
        [
            {
                action: 'comment',
                background: 'rgba(0, 0, 0, 0)',
                color: 'rgb(160, 160, 160)',
            },
            {
                action: 'project',
                background: 'rgba(0, 0, 0, 0)',
                color: 'rgb(160, 160, 160)',
            },
            {
                action: 'send',
                background: 'rgb(14, 99, 156)',
                color: 'rgb(255, 255, 255)',
            },
        ],
        'send must render as the accent chip and comment as a ghost button'
    );

    // Send drops the selected text into the active terminal via the Host.
    await selectionBubble.locator('[data-comment-selection-action="send"]')
        .click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-send-selection',
        version: 1,
        text: 'beta',
    });
    assert.equal(await selectionBubble.isHidden(), true);

    await selectBeta();
    await selectionBubble.locator('[data-comment-selection-action="comment"]')
        .click();
    await page.locator('[data-comment-input]').fill(
        'Explain beta.\nSecond line stays visible.'
    );
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    assert.equal(addRequest.operation, 'add');

    const comments = [{
        id: 'comment-1',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'beta',
        prefix: 'Alpha ',
        suffix: ' gamma beta delta.',
        comment: 'Explain beta.\nSecond line stays visible.',
        status: 'open',
        createdAt: Date.now() - 5 * 60000,
    }, {
        id: 'comment-2',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Session-wide reminder.',
        status: 'open',
        createdAt: Date.now() - 5 * 60000,
    }];
    await settle(addRequest, 1, comments);

    const card = page.locator('[data-comment-id="comment-1"]');
    const noteCard = page.locator('[data-comment-id="comment-2"]');

    // Read mode renders the full comment without a textarea or clipping.
    assert.equal(await card.locator('textarea').count(), 0);
    const body = card.locator('.conversation-comment-body');
    assert.equal(
        await body.textContent(),
        'Explain beta.\nSecond line stays visible.'
    );
    assert.equal(await body.evaluate(element =>
        element.scrollHeight <= element.clientHeight
    ), true, 'read mode must show the full comment without scrolling');
    assert.equal(
        await card.locator('.conversation-comment-meta span').first()
            .textContent(),
        '#1'
    );
    assert.equal(
        await card.locator('.conversation-comment-time').textContent(),
        '5m ago'
    );
    assert.equal(
        await noteCard.locator('.conversation-comment-scope').textContent(),
        'Session note'
    );

    // Open cards expose the full icon action set per scope.
    assert.deepEqual(await cardActions(card), [
        'send-comment', 'locate', 'edit-comment', 'delete',
    ]);
    assert.deepEqual(await cardActions(noteCard), [
        'send-comment', 'edit-comment', 'delete',
    ]);

    // Every action is a uniform compact icon button with a tooltip label.
    const iconMetrics = await page
        .locator('.conversation-comment .conversation-comment-icon-button')
        .evaluateAll(buttons => buttons.map(button => {
            const rect = button.getBoundingClientRect();
            return {
                width: Math.round(rect.width),
                height: Math.round(rect.height),
                labelled: button.getAttribute('aria-label')
                    === button.title
                    && button.title.length > 0,
                hasIcon: !!button.querySelector('svg'),
            };
        }));
    assert.equal(iconMetrics.length, 7);
    iconMetrics.forEach(metric => {
        assert.deepEqual(
            { width: metric.width, height: metric.height },
            { width: iconMetrics[0].width, height: iconMetrics[0].height },
            'icon buttons must share one size'
        );
        assert.ok(metric.width <= 24 && metric.height <= 24);
        assert.equal(metric.labelled, true);
        assert.equal(metric.hasIcon, true);
    });

    // Edit mode swaps the body for an autosized textarea and save/cancel.
    await card.locator('[data-comment-action="edit-comment"]').click();
    const editor = card.locator('[data-comment-edit]');
    assert.equal(await editor.count(), 1);
    assert.equal(
        await editor.inputValue(),
        'Explain beta.\nSecond line stays visible.'
    );
    assert.deepEqual(await cardActions(card), ['update', 'cancel-edit']);
    assert.equal(await editor.evaluate(element =>
        element.scrollHeight <= element.clientHeight + 1
    ), true, 'edit textarea must autosize to the draft');

    // Empty saves are rejected locally without posting.
    const postedBeforeEmptySave = (await postedMessages(page)).length;
    await editor.fill('   ');
    await card.locator('[data-comment-action="update"]').click();
    assert.equal((await postedMessages(page)).length, postedBeforeEmptySave);
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'A comment cannot be empty.'
    );
    assert.equal(await editor.count(), 1);

    // Escape cancels the edit and restores the authoritative read view.
    await editor.fill('Discard me.');
    await editor.press('Escape');
    assert.equal(await card.locator('textarea').count(), 0);
    assert.equal(
        await card.locator('.conversation-comment-body').textContent(),
        'Explain beta.\nSecond line stays visible.'
    );

    // Saving posts the edited draft and exits edit mode on settlement.
    await card.locator('[data-comment-action="edit-comment"]').click();
    await card.locator('[data-comment-edit]').fill(
        'Explain beta thoroughly.'
    );
    await card.locator('[data-comment-action="update"]').click();
    const update = (await postedMessages(page)).at(-1);
    assert.equal(update.type, 'conversation-viewer-comment-mutation');
    assert.equal(update.operation, 'update');
    assert.deepEqual(update.payload, {
        commentId: 'comment-1',
        comment: 'Explain beta thoroughly.',
    });
    comments[0] = {
        ...comments[0],
        comment: 'Explain beta thoroughly.',
    };
    await settle(update, 2, comments);
    assert.equal(await card.locator('textarea').count(), 0);
    assert.equal(
        await card.locator('.conversation-comment-body').textContent(),
        'Explain beta thoroughly.'
    );

    // A failed save keeps the draft editable and reports the failure.
    await card.locator('[data-comment-action="edit-comment"]').click();
    await card.locator('[data-comment-edit]').fill('Add verification steps.');
    await card.locator('[data-comment-action="update"]').click();
    assert.equal(
        await card.locator('[data-comment-action="update"]').isDisabled(),
        true,
        'controls must stay disabled while the save is in flight'
    );
    assert.equal(
        await card.locator('[data-comment-edit]').isDisabled(),
        true
    );
    const postedBeforeEscape = (await postedMessages(page)).length;
    await page.keyboard.press('Escape');
    assert.equal(
        await card.locator('[data-comment-edit]').count(),
        1,
        'Escape must not cancel editing while a request is pending'
    );
    assert.equal(
        (await postedMessages(page)).length,
        postedBeforeEscape,
        'Escape during a pending edit must not close the viewer'
    );
    const failedUpdate = (await postedMessages(page)).at(-1);
    assert.equal(failedUpdate.operation, 'update');
    await page.evaluate(({ request, comments }) => {
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
                success: false,
                revision: 2,
                comments,
                error: 'failed',
            },
        }));
    }, { request: failedUpdate, comments });
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'The comment action failed. Your comments were kept.'
    );
    assert.equal(
        await card.locator('[data-comment-edit]').inputValue(),
        'Add verification steps.',
        'a failed save must preserve the edited draft'
    );
    assert.equal(
        await card.locator('[data-comment-drag-handle]').isDisabled(),
        true,
        'a failed edit must keep its drag handle disabled'
    );
    assert.equal(
        await card.locator('[data-comment-drag-handle]').getAttribute(
            'draggable'
        ),
        'false'
    );
    await card.locator('[data-comment-action="cancel-edit"]').click();
    assert.equal(
        await card.locator('.conversation-comment-body').textContent(),
        'Explain beta thoroughly.'
    );

    // Per-card send stages only this comment through the send channel.
    await card.locator('[data-comment-action="send-comment"]').click();
    const sendOne = (await postedMessages(page)).at(-1);
    assert.equal(sendOne.type, 'conversation-viewer-send-comments');
    assert.equal(sendOne.operation, 'sendComment');
    assert.deepEqual(sendOne.payload, { commentId: 'comment-1' });
    comments[0] = {
        ...comments[0],
        status: 'done',
        sentAt: Date.now() - 60000,
    };
    await settle(sendOne, 3, comments);
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'Comment added to session input. Review and press Enter to send.'
    );

    // A freshly sent card flips to Done, stays expanded once, and drops
    // the send action while keeping edit (which reopens it) and delete.
    assert.equal(
        await card.locator('[data-comment-status-label]').textContent(),
        'Done'
    );
    assert.deepEqual(await cardActions(card), [
        'toggle-done', 'locate', 'edit-comment', 'delete',
    ]);
    assert.equal(
        await card.locator('.conversation-comment-time').textContent(),
        'sent 1m ago'
    );

    // Collapsing a done card dims it to a single line; clicking the
    // collapsed body expands it again.
    await card.locator('[data-comment-action="toggle-done"]').click();
    assert.equal(
        await card.getAttribute('class'),
        'conversation-comment conversation-comment-done-collapsed'
    );
    assert.deepEqual(await cardActions(card), ['toggle-done']);
    assert.equal(
        await card.locator('.conversation-comment-collapsed-body')
            .textContent(),
        'Explain beta thoroughly.'
    );
    await card.locator('.conversation-comment-collapsed-body').click();
    assert.deepEqual(await cardActions(card), [
        'toggle-done', 'locate', 'edit-comment', 'delete',
    ]);

    // Editing a done card posts the update and the Host flips it back to
    // open so it can be sent again.
    await card.locator('[data-comment-action="edit-comment"]').click();
    await card.locator('[data-comment-edit]').fill(
        'Explain beta thoroughly with a test.'
    );
    await card.locator('[data-comment-action="update"]').click();
    const reopenUpdate = (await postedMessages(page)).at(-1);
    assert.equal(reopenUpdate.operation, 'update');
    assert.deepEqual(reopenUpdate.payload, {
        commentId: 'comment-1',
        comment: 'Explain beta thoroughly with a test.',
    });
    comments[0] = {
        ...comments[0],
        comment: 'Explain beta thoroughly with a test.',
        status: 'open',
    };
    delete comments[0].sentAt;
    await settle(reopenUpdate, 4, comments);
    assert.equal(
        await card.locator('[data-comment-status-label]').textContent(),
        'Open'
    );
    assert.deepEqual(await cardActions(card), [
        'send-comment', 'locate', 'edit-comment', 'delete',
    ]);
});

test('CONVERSATION-COMMENT-QUOTE-LOCATION-001 centers the exact quoted occurrence instead of the whole message', async t => {
    const interactionId = 'input-quote-location';
    const fillerBefore = Array.from(
        { length: 60 },
        (_item, index) => `Filler paragraph ${index}.`
    ).join('\n\n');
    const fillerAfter = Array.from(
        { length: 20 },
        (_item, index) => `Trailing paragraph ${index}.`
    ).join('\n\n');
    const comment = {
        id: 'comment-quote-location',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'repeated quote',
        // Legacy comments could omit selected edge whitespace from their
        // context, so this intentionally lacks the space before the quote.
        prefix: 'Second occurrence:',
        suffix: ' after second.',
        comment: 'Review the second occurrence.',
        status: 'open',
    };
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 500 },
        initialWebviewState: {
            conversationCommentsPanel: { open: true, width: 240 },
        },
        interactionIds: [interactionId],
        interactionId,
        markdown: `First occurrence: repeated quote after first.\n\n${fillerBefore}`
            + '\n\nSecond occurrence: repeated quote after second.\n\n'
            + fillerAfter,
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
        commentStore: {
            async load() {
                return { revision: 1, comments: [comment] };
            },
        },
    });
    const target = page.locator('.conversation-markdown p')
        .filter({ hasText: /^Second occurrence:/ });
    assert.match(await target.innerText(), /^Second occurrence:/);

    await page.locator('[data-comment-id="comment-quote-location"]')
        .locator('[data-comment-action="locate"]').click();

    const location = await target.evaluate(element => {
        const scroll = document.querySelector('[data-conversation-scroll]');
        const targetBounds = element.getBoundingClientRect();
        const scrollBounds = scroll.getBoundingClientRect();
        return {
            visible: targetBounds.top >= scrollBounds.top
                && targetBounds.bottom <= scrollBounds.bottom,
            centerOffset: Math.abs(
                (targetBounds.top + targetBounds.bottom) / 2
                - (scrollBounds.top + scrollBounds.bottom) / 2
            ),
        };
    });
    assert.equal(location.visible, true, JSON.stringify(location));
    assert.ok(
        location.centerOffset <= 40,
        `quoted text was ${location.centerOffset}px away from viewport center`
    );

    await target.evaluate(element => {
        const node = element.firstChild;
        const selectedText = ' repeated quote ';
        const start = node.nodeValue.indexOf(selectedText);
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + selectedText.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator(
        '[data-comment-selection-action="comment"]'
    ).click();
    await page.locator('[data-comment-input]').fill(
        'Keep context aligned with the trimmed quote.'
    );
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    assert.equal(addRequest.operation, 'add');
    const { prefix, suffix, ...selection } = addRequest.payload;
    assert.deepEqual(selection, {
        messageId: `${interactionId}:user`,
        interactionId,
        quote: 'repeated quote',
        comment: 'Keep context aligned with the trimmed quote.',
    });
    assert.equal(prefix.endsWith('Second occurrence: '), true);
    assert.equal(suffix.startsWith(' after second.'), true);
});

test('CONVERSATION-COMMENT-QUOTE-LOCATION-001 preserves and locates a quote spanning Markdown blocks', async t => {
    const interactionId = 'input-block-quote-location';
    const fillerBefore = Array.from(
        { length: 50 },
        (_item, index) => `Earlier paragraph ${index}.`
    ).join('\n\n');
    const fillerAfter = Array.from(
        { length: 20 },
        (_item, index) => `Later paragraph ${index}.`
    ).join('\n\n');
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 500 },
        initialWebviewState: {
            conversationCommentsPanel: { open: true, width: 240 },
        },
        interactionIds: [interactionId],
        interactionId,
        markdown: `${fillerBefore}\n\nOpening block phrase alpha.`
            + '\n\nClosing block beta phrase.\n\n'
            + fillerAfter,
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    const opening = page.locator('.conversation-markdown p')
        .filter({ hasText: /^Opening block/ });
    const closing = page.locator('.conversation-markdown p')
        .filter({ hasText: /^Closing block/ });
    await page.locator('.conversation-markdown').evaluate((element, labels) => {
        const paragraphs = Array.from(element.querySelectorAll('p'));
        const startNode = paragraphs.find(paragraph =>
            paragraph.textContent.startsWith(labels.opening)
        ).firstChild;
        const endNode = paragraphs.find(paragraph =>
            paragraph.textContent.startsWith(labels.closing)
        ).firstChild;
        const range = document.createRange();
        range.setStart(startNode, startNode.nodeValue.indexOf('alpha'));
        range.setEnd(
            endNode,
            endNode.nodeValue.indexOf('beta') + 'beta'.length
        );
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, { opening: 'Opening block', closing: 'Closing block' });
    await page.locator('[data-comment-selection-action="comment"]')
        .evaluate(button => button.click());
    await page.locator('[data-comment-input]').fill('Review both blocks.');
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    assert.equal(addRequest.payload.quote, 'alpha.\n\nClosing block beta');
    const comment = {
        id: 'comment-block-quote-location',
        ...addRequest.payload,
        role: 'user',
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
                comments: [{ ...comment, quote: '   ' }],
            },
        }));
    }, { request: addRequest, comment });
    assert.equal(
        await page.locator('[data-conversation-comments]')
            .getAttribute('aria-busy'),
        'true',
        'a whitespace-only quote settlement must be rejected'
    );
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
    }, { request: addRequest, comment });

    await page.locator('[data-comment-id="comment-block-quote-location"]')
        .locator('[data-comment-action="locate"]').click();
    const location = await page.evaluate(() => {
        const scroll = document.querySelector('[data-conversation-scroll]');
        const paragraphs = Array.from(document.querySelectorAll(
            '.conversation-markdown p'
        ));
        const opening = paragraphs.find(paragraph =>
            paragraph.textContent.startsWith('Opening block')
        ).getBoundingClientRect();
        const closing = paragraphs.find(paragraph =>
            paragraph.textContent.startsWith('Closing block')
        ).getBoundingClientRect();
        const scrollBounds = scroll.getBoundingClientRect();
        return {
            openingVisible: opening.top >= scrollBounds.top,
            closingVisible: closing.bottom <= scrollBounds.bottom,
            centerOffset: Math.abs(
                (opening.top + closing.bottom) / 2
                - (scrollBounds.top + scrollBounds.bottom) / 2
            ),
        };
    });
    assert.equal(await opening.count(), 1);
    assert.equal(await closing.count(), 1);
    assert.equal(location.openingVisible, true, JSON.stringify(location));
    assert.equal(location.closingVisible, true, JSON.stringify(location));
    assert.ok(
        location.centerOffset <= 40,
        `block quote was ${location.centerOffset}px away from viewport center`
    );
});

test('CONVERSATION-COMMENTS-UI-001 filters cards, jumps from message markers, and keeps the toolbar to one icon row', async t => {
    const interactionId = 'input-filter-marker';
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

    async function settle(request, revision, comments, operation) {
        await page.evaluate(({ request, revision, comments, operation }) => {
            window.dispatchEvent(new MessageEvent('message', {
                data: {
                    type: 'conversation-viewer-comments-result',
                    version: 1,
                    requestId: request.requestId,
                    subscriptionGeneration: request.subscriptionGeneration,
                    projectId: request.projectId,
                    provider: request.provider,
                    sessionId: request.sessionId,
                    operation: operation || request.operation,
                    success: true,
                    revision,
                    comments,
                },
            }));
        }, { request, revision, comments, operation });
    }

    await page.locator('.conversation-markdown').evaluate(element => {
        const node = element.querySelector('p').firstChild;
        const start = node.nodeValue.indexOf('beta');
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + 'beta'.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.locator(
        '[data-comment-selection-action="comment"]'
    ).click();
    await page.locator('[data-comment-input]').fill('Explain beta.');
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    const comments = [{
        id: 'comment-1',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'beta',
        prefix: 'Alpha ',
        suffix: ' gamma beta delta.',
        comment: 'Explain beta.',
        status: 'open',
        createdAt: Date.now() - 60000,
    }, {
        id: 'comment-2',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'gamma',
        prefix: 'Alpha beta ',
        suffix: ' beta delta.',
        comment: 'Already sent to the session.',
        status: 'done',
        createdAt: Date.now() - 3600000,
        sentAt: Date.now() - 1800000,
    }, {
        id: 'comment-3',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Session-wide reminder.',
        status: 'open',
        createdAt: Date.now() - 120000,
    }];
    await settle(addRequest, 1, comments);

    const card = page.locator('[data-comment-id="comment-1"]');
    const doneCard = page.locator('[data-comment-id="comment-2"]');

    // The toolbar is a single row of six icon buttons.
    const toolbar = page.locator('[data-comments-toolbar]');
    assert.equal(await toolbar.locator('[data-comment-action]').count(), 6);
    assert.deepEqual(
        (await toolbar.locator('[data-comment-action]').evaluateAll(buttons =>
            Array.from(new Set(buttons.map(button =>
                Math.round(button.getBoundingClientRect().top)
            )))
        )).length,
        1,
        'toolbar buttons must share a single row'
    );
    const toolbarHeight = await toolbar.evaluate(element =>
        element.getBoundingClientRect().height
    );
    assert.ok(
        toolbarHeight <= 64,
        `comment toolbar height ${toolbarHeight}px must remain compact`
    );

    // The send action is a bare icon: no count badge, one uniform size.
    assert.equal(
        await toolbar.locator('[data-comment-send-count]').count(),
        0,
        'send button must not render a count badge'
    );
    assert.equal(
        await toolbar.locator('[data-comment-action="send"]').innerText(),
        '',
        'send button must stay icon-only'
    );
    assert.deepEqual(
        (await toolbar.locator('[data-comment-action]').evaluateAll(buttons =>
            Array.from(new Set(buttons.map(button => {
                const box = button.getBoundingClientRect();
                return Math.round(box.width) + 'x' + Math.round(box.height);
            })))
        )).length,
        1,
        'toolbar buttons must share one uniform icon size'
    );

    // Telemetry pill reports open/total.
    assert.equal(
        await page.locator('[data-telemetry-comments]').innerText(),
        '2/3'
    );

    // A done card settled outside a send starts collapsed and dimmed.
    assert.equal(
        await doneCard.getAttribute('class'),
        'conversation-comment conversation-comment-done-collapsed'
    );

    // The message marker counts every comment on that message.
    const marker = page.locator('[data-comment-marker]');
    assert.equal(await marker.count(), 1);
    assert.equal(
        await marker.locator('.conversation-comment-marker-count')
            .textContent(),
        '2'
    );

    // Filtering narrows the rendered cards and persists the choice.
    await page.locator('[data-comment-filter="done"]').click();
    assert.equal(await page.locator('[data-comment-id]').count(), 1);
    assert.equal(
        await page.locator('[data-comment-filter="done"]')
            .getAttribute('aria-pressed'),
        'true'
    );
    assert.equal(
        await page.evaluate(() =>
            window.__webviewState.conversationCommentsFilter
        ),
        'done'
    );
    await page.locator('[data-comment-filter="open"]').click();
    assert.equal(await page.locator('[data-comment-id]').count(), 2);

    // A marker jump resets a filter that hides the target card.
    await page.locator('[data-comment-filter="done"]').click();
    assert.equal(await page.locator('[data-comment-id]').count(), 1);
    await marker.click();
    assert.equal(
        await page.locator('[data-comment-filter="all"]')
            .getAttribute('aria-pressed'),
        'true'
    );
    assert.equal(await page.locator('[data-comment-id]').count(), 3);
    assert.equal(
        await card.evaluate(element =>
            element.classList.contains('conversation-comment-flash')
        ),
        true
    );

    // Sending every open comment empties the open filter with a hint.
    await page.locator('[data-comment-filter="all"]').click();
    await page.locator('[data-comments-toolbar] [data-comment-action="send"]')
        .click();
    const sendAll = (await postedMessages(page)).at(-1);
    assert.equal(sendAll.operation, 'sendComments');
    const allDone = comments.map(comment => ({
        ...comment,
        status: 'done',
        sentAt: Date.now(),
    }));
    await settle(sendAll, 2, allDone);
    assert.equal(
        await page.locator('[data-telemetry-comments]').innerText(),
        '0/3'
    );
    await page.locator('[data-comment-filter="open"]').click();
    assert.equal(await page.locator('[data-comment-id]').count(), 0);
    assert.equal(
        await page.locator('[data-comment-filter-empty]').textContent(),
        'No open comments.'
    );

    // With only done cards left, the marker targets and expands the first.
    await page.locator('[data-comment-filter="all"]').click();
    await card.locator('[data-comment-action="toggle-done"]').click();
    assert.equal(
        await card.getAttribute('class'),
        'conversation-comment conversation-comment-done-collapsed'
    );
    await marker.click();
    assert.equal(
        await card.evaluate(element =>
            element.classList.contains('conversation-comment-flash')
        ),
        true
    );
    assert.equal(
        await card.locator('.conversation-comment-collapsed-body').count(),
        0,
        'a marker jump must expand the collapsed done card'
    );

    // Markers are rebuilt after Host page re-renders.
    await sendPage(page, {
        type: 'conversation-viewer-page',
        version: 1,
        requestId: 100,
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
        totalInputs: 1,
        partial: false,
        atLatest: true,
        stale: false,
        subagents: [],
        activeSubagent: null,
    });
    assert.equal(await page.locator('[data-comment-marker]').count(), 1);

    // Clear done empties the list in one correlated mutation.
    await page.locator('[data-comment-action="clearDone"]').click();
    const clearDone = (await postedMessages(page)).at(-1);
    assert.equal(clearDone.operation, 'clearDone');
    assert.deepEqual(clearDone.payload, {});
    await settle(clearDone, 3, []);
    assert.equal(await page.locator('[data-comment-id]').count(), 0);
    assert.equal(await page.locator('[data-comment-marker]').count(), 0);
    assert.equal(
        await page.locator('[data-telemetry-comments]').innerText(),
        '0'
    );
});

test('CONVERSATION-COMMENTS-UI-001 CONVERSATION-COMMENTS-BULK-001 CONVERSATION-COMMENTS-LAYOUT-001 reviews contained cards and Host-owned comment batches', async t => {
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
        await page.locator(
            '[data-comment-selection-action="comment"]'
        ).click();
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
    assert.equal(
        await page.locator('[data-comment-count]').count(),
        0,
        'the redundant count badge stays removed'
    );
    assert.equal(
        await page.locator('[data-telemetry-comments]').innerText(),
        '2/2',
        'the telemetry pill carries the open/total counts'
    );
    const commentToolbar = page.locator('[data-comments-toolbar]');
    assert.equal(await commentToolbar.count(), 1);
    assert.equal(
        await commentToolbar.locator('[data-comment-action]').count(),
        6
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

    // The composer actions are icon buttons, same family as card actions.
    assert.deepEqual(
        await page.evaluate(() => {
            const actions = document.querySelector(
                '[data-comment-composer] .conversation-comment-actions'
            );
            return Array.from(actions.querySelectorAll('button'))
                .map(button => {
                    const box = button.getBoundingClientRect();
                    return {
                        action: button.getAttribute('data-comment-action'),
                        iconOnly: button.innerText === ''
                            && button.querySelectorAll('svg').length === 1,
                        iconButtonClass: button.classList.contains(
                            'conversation-comment-icon-button'
                        ),
                        size: Math.round(box.width) + 'x'
                            + Math.round(box.height),
                    };
                });
        }),
        [
            {
                action: 'cancel-add',
                iconOnly: true,
                iconButtonClass: true,
                size: '22x22',
            },
            {
                action: 'confirm-add',
                iconOnly: true,
                iconButtonClass: true,
                size: '22x22',
            },
        ],
        'composer actions must be 22px icon buttons like the card actions'
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
        subagents: [],
        activeSubagent: null,
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
        subagents: [],
        activeSubagent: null,
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
        comment.status = 'done';
    });
    await settle(send, 3, comments);

    assert.equal(await page.locator('[data-comment-id]').count(), 2);
    assert.deepEqual(
        await page.locator('[data-comment-status-label]').allTextContents(),
        ['Done', 'Done']
    );
    assert.equal(
        await page.locator('[data-comment-action="send"]').isDisabled(),
        true
    );
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'Comments added to session input. Review and press Enter to send.'
    );

    // Editing a done card posts an update and the Host flips it back to
    // open so it can be sent again.
    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="edit-comment"]').click();
    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-edit]').fill('Explain beta differently.');
    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="update"]').click();
    requests = await postedMessages(page);
    const reopenUpdate = requests.at(-1);
    assert.equal(reopenUpdate.operation, 'update');
    comments[0].status = 'open';
    comments[0].comment = 'Explain beta differently.';
    await settle(reopenUpdate, 4, comments);
    assert.equal(
        await page.locator('[data-comment-id="comment-1"]')
            .getAttribute('data-comment-status'),
        'open'
    );
    assert.equal(
        await page.locator('[data-telemetry-comments]').innerText(),
        '1/2',
        'the telemetry pill reflects the reopened comment'
    );
    assert.equal(
        await page.locator('[data-comment-action="send"]').isEnabled(),
        true
    );

    await page.locator('[data-comment-action="clearDone"]').click();
    requests = await postedMessages(page);
    const clearDone = requests.at(-1);
    assert.equal(clearDone.operation, 'clearDone');
    assert.equal(clearDone.expectedRevision, 4);
    assert.deepEqual(clearDone.payload, {});
    comments.splice(1, 1);
    await settle(clearDone, 5, comments);
    assert.deepEqual(
        await page.locator('[data-comment-status-label]').allTextContents(),
        ['Open']
    );

    await page.locator('[data-comment-id="comment-1"]')
        .locator('[data-comment-action="send-comment"]').click();
    requests = await postedMessages(page);
    const sendRemaining = requests.at(-1);
    comments[0].status = 'done';
    await settle(sendRemaining, 6, comments);

    await page.locator('[data-comment-action="clearDone"]').click();
    requests = await postedMessages(page);
    const clearDoneRemaining = requests.at(-1);
    assert.equal(clearDoneRemaining.operation, 'clearDone');
    assert.equal(clearDoneRemaining.expectedRevision, 6);
    comments.splice(0);
    await settle(clearDoneRemaining, 7, comments);
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
    await settle(third, 8, comments);

    const messageCountBeforeConfirmation = (await postedMessages(page)).length;
    const clearAllButton = page.locator('[data-comment-action="clearAll"]');
    await clearAllButton.click();
    assert.equal(
        (await postedMessages(page)).length,
        messageCountBeforeConfirmation
    );
    assert.equal(
        await clearAllButton.getAttribute('data-confirming'),
        'true'
    );
    assert.equal(
        await clearAllButton.getAttribute('aria-label'),
        'Confirm clearing all comments'
    );
    await clearAllButton.click();
    requests = await postedMessages(page);
    const clearAll = requests.at(-1);
    assert.equal(clearAll.operation, 'clearAll');
    assert.equal(clearAll.expectedRevision, 8);
    assert.deepEqual(clearAll.payload, {});
    comments.splice(0);
    await settle(clearAll, 9, comments);
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

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 sanitizes hostile HTML, preserves one native HTTPS path, and keeps the viewer open on Escape', async t => {
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

    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-previous',
        version: 1,
    });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-next',
        version: 1,
    });
    await page.getByRole('button', { name: 'Latest', exact: true }).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-latest',
        version: 1,
    });

    const postedBeforeLink = (await postedMessages(page)).length;
    const defaultPreventedBeforeTestGuard = await page.locator(
        'a[href="https://example.test/safe"]'
    ).evaluate(link => {
        let defaultPrevented;
        document.addEventListener('click', event => {
            defaultPrevented = event.defaultPrevented;
            event.preventDefault();
        }, { once: true });
        link.click();
        return defaultPrevented;
    });
    assert.equal(defaultPreventedBeforeTestGuard, false);
    assert.equal(
        (await postedMessages(page)).length,
        postedBeforeLink,
        'sanitized HTTPS links must not also ask the Host to open them'
    );

    const postedBeforeEscape = (await postedMessages(page)).length;
    await page.keyboard.press('Escape');
    assert.equal(
        (await postedMessages(page)).length,
        postedBeforeEscape,
        'Escape must not close the conversation viewer'
    );
});

test('CONVERSATION-LOCAL-FILE-LINKS-001 keeps rendered absolute file links clickable through the Webview', async t => {
    const firstHref = '/home/example/project/src/localStore.ts:17';
    const secondHref = '/home/example/project/src/localStore.ts:216';
    const { page } = await openHostViewerDocument(t, {
        markdown: `[localStore.ts](${firstHref}) expires records and `
            + `[localStore.ts](${secondHref}) deletes them.`,
    });

    const links = page.getByRole('link', { name: 'localStore.ts' });
    assert.equal(await links.count(), 2);
    assert.equal(await links.nth(0).getAttribute('href'), firstHref);
    assert.equal(await links.nth(1).getAttribute('href'), secondHref);
    await links.nth(1).click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-open-link',
        version: 1,
        href: secondHref,
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

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 strips inline emphasis tags from Mermaid labels instead of rendering them literally', async t => {
    const page = await openViewerPage(t, { includeMermaid: true });
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="emphasis" data-interaction-id="input-4">
            <section class="conversation-markdown">
                <pre><code class="language-mermaid">flowchart LR
                    A[&quot;&lt;b&gt;Deploy&lt;/b&gt; &lt;i&gt;service&lt;/i&gt;&quot;] --&gt; B[Done]</code></pre>
            </section>
        </article>`,
    });

    const diagram = page.locator('.conversation-mermaid-image');
    await diagram.waitFor();
    await page.waitForFunction(() => {
        const image = document.querySelector('.conversation-mermaid-image');
        return image && image.complete && image.naturalWidth > 0;
    });
    const normalizedSvg = await diagram.evaluate(async image =>
        (await fetch(image.src)).text()
    );
    assert.match(normalizedSvg, />Deploy</);
    assert.match(normalizedSvg, /> service</);
    assert.doesNotMatch(normalizedSvg, /&lt;\/?(b|i|em|strong)&gt;/i);
    assert.match(normalizedSvg, />Done</);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 collapses completed-turn work behind a Worked-for row that toggles and survives refresh', async t => {
    const page = await openViewerPage(t, {});
    const userArticle = `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Run the tests</p></section>
    </article>`;
    const worklogArticle = `<article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle"
            onclick="window.__pwned = true">
            <span class="conversation-worklog-label">Worked for 1m 20s</span>
        </button>
    </article>`;
    const toolArticle = `<article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <details class="conversation-tool-call">
            <summary><span class="conversation-tool-name">Shell</span> Shell npm test</summary>
            <pre class="conversation-tool-detail"><code>9 passing</code></pre>
        </details>
    </article>`;
    const assistantArticle = `<article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>All pass.</p></section>
    </article>`;
    // The row heads the work group so expanding reveals entries below the
    // toggle and the toggle itself never moves under the pointer.
    const turnHtml = userArticle + worklogArticle + toolArticle
        + assistantArticle;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 60,
        updateKind: 'initial',
        html: turnHtml,
    });

    const tool = page.locator('.conversation-message-tool');
    const toggle = page.locator('.conversation-worklog-toggle');
    assert.equal(await toggle.count(), 1, 'button must survive sanitizing');
    assert.equal(
        await toggle.evaluate(element => element.hasAttribute('onclick')),
        false,
        'event handler attributes must be stripped'
    );
    assert.match(await toggle.innerText(), /Worked for 1m 20s/);
    assert.equal(await tool.isHidden(), true,
        'completed-turn work starts collapsed');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');

    const toggleYBefore = (await toggle.boundingBox()).y;
    await toggle.click();
    assert.equal(await tool.isVisible(), true, 'click expands the worklog');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(
        (await toggle.boundingBox()).y,
        toggleYBefore,
        'expanding reveals entries below the toggle, never moving it'
    );

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 61,
        updateKind: 'refresh',
        html: turnHtml,
    });
    assert.equal(
        await page.locator('.conversation-message-tool').isVisible(),
        true,
        'expanded state survives a live refresh'
    );
    assert.equal(
        await page.locator('.conversation-worklog-toggle')
            .getAttribute('aria-expanded'),
        'true'
    );
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 keeps in-progress work expanded and collapses it when the answer lands', async t => {
    const page = await openViewerPage(t, {});
    const liveHtml = `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Run the tests</p></section>
    </article>
    <article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <details class="conversation-tool-call">
            <summary><span class="conversation-tool-name">Shell</span> Shell npm test</summary>
            <pre class="conversation-tool-detail"><code>running</code></pre>
        </details>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 70,
        updateKind: 'initial',
        html: liveHtml,
        outline: [{
            interactionId: 'input-4',
            userPreview: 'Run the tests',
            responseState: 'inProgress',
        }],
        atLatest: true,
    });
    assert.equal(
        await page.locator('.conversation-message-tool').isVisible(),
        true,
        'in-progress work stays expanded'
    );
    assert.equal(
        await page.locator('.conversation-message-worklog').count(),
        0,
        'no row while the turn is live'
    );

    const doneHtml = liveHtml.replace('running', '9 passing').replace(
        '<article class="conversation-message conversation-message-tool"',
        `<article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle">
            <span class="conversation-worklog-label">Worked for 45s</span>
        </button>
    </article>
    <article class="conversation-message conversation-message-tool"`
    ) + `
    <article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>All pass.</p></section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 71,
        updateKind: 'refresh',
        html: doneHtml,
        atLatest: true,
    });
    assert.equal(
        await page.locator('.conversation-message-tool').isHidden(),
        true,
        'work collapses once the answer lands'
    );
    const toggle = page.locator('.conversation-worklog-toggle');
    assert.match(await toggle.innerText(), /Worked for 45s/);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 moves focus to the worklog toggle when focused work auto-collapses', async t => {
    const page = await openViewerPage(t, {});
    const liveHtml = `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Run the tests</p></section>
    </article>
    <article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <div class="conversation-tool-call-static">Running tests</div>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 75,
        updateKind: 'initial',
        html: liveHtml,
        outline: [{
            interactionId: 'input-4',
            userPreview: 'Run the tests',
            responseState: 'inProgress',
        }],
        atLatest: true,
    });
    const tool = page.locator('.conversation-message-tool');
    await tool.evaluate(element => {
        element.tabIndex = -1;
        element.focus();
    });
    assert.equal(await tool.evaluate(element =>
        document.activeElement === element), true);

    const doneHtml = liveHtml.replace(
        '<article class="conversation-message conversation-message-tool"',
        `<article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle">
            <span class="conversation-worklog-label">Worked for 45s</span>
        </button>
    </article>
    <article class="conversation-message conversation-message-tool"`
    ) + `
    <article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>All pass.</p></section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 76,
        updateKind: 'refresh',
        html: doneHtml,
        atLatest: true,
    });

    assert.equal(await tool.isHidden(), true);
    assert.equal(
        await page.locator('.conversation-worklog-toggle').evaluate(element =>
            document.activeElement === element),
        true,
        'focus must remain visible on the control that reveals the hidden work'
    );
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 keeps the worklog row at the reading anchor when work auto-collapses', async t => {
    const page = await openViewerPage(t, {});
    const filler = Array.from({ length: 40 }, (_item, index) => `
    <article class="conversation-message conversation-message-tool"
            data-message-id="input-5:tool:${index}"
            data-conversation-message-id="input-5%3Atool%3A${index}"
            data-interaction-id="input-5">
        <div class="conversation-tool-call-static">Later work ${index}</div>
    </article>`).join('');
    const userHtml = `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Run the tests</p></section>
    </article>`;
    const toolHtml = `<article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <div class="conversation-tool-call-static">Running tests</div>
    </article>`;
    const liveHtml = userHtml + toolHtml + filler;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 77,
        updateKind: 'initial',
        html: liveHtml,
        outline: [{
            interactionId: 'input-4',
            userPreview: 'Run the tests',
            responseState: 'inProgress',
        }],
        atLatest: false,
    });
    const scroll = page.locator('[data-conversation-scroll]');
    const tool = page.locator('[data-message-id="input-4:tool:0"]');
    await scroll.evaluate((element, top) => {
        element.scrollTop += top
            - element.getBoundingClientRect().top;
    }, (await tool.boundingBox()).y);
    const anchoredTop = (await tool.boundingBox()).y;

    const worklogHtml = `<article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle">
            <span class="conversation-worklog-label">Worked for 45s</span>
        </button>
    </article>`;
    const answerHtml = `<article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>All pass.</p></section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 78,
        updateKind: 'refresh',
        html: userHtml + worklogHtml
            + toolHtml.replace('Running tests', 'Tests passed')
            + answerHtml + filler,
        atLatest: false,
    });

    const worklogTop = (await page.locator(
        '.conversation-message-worklog'
    ).boundingBox()).y;
    assert.ok(
        Math.abs(worklogTop - anchoredTop) <= 2,
        `collapsed row moved from reading anchor: ${anchoredTop} -> ${worklogTop}`
    );
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 aligns the Worked-for row with the message column', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 80,
        updateKind: 'initial',
        html: `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Run the tests</p></section>
    </article>
    <article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle">
            <span class="conversation-worklog-label">Worked for 1m 20s</span>
        </button>
    </article>
    <article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <details class="conversation-tool-call">
            <summary><span class="conversation-tool-name">Shell</span> Shell npm test</summary>
            <pre class="conversation-tool-detail"><code>9 passing</code></pre>
        </details>
    </article>
    <article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>All pass.</p></section>
    </article>`,
    });

    const row = page.locator('.conversation-message-worklog');
    await row.waitFor();
    const rowX = Math.round((await row.boundingBox()).x);
    const assistantX = Math.round(
        (await page.locator('.conversation-message-assistant').boundingBox()).x
    );
    const userX = Math.round(
        (await page.locator('.conversation-message-user').boundingBox()).x
    );
    assert.equal(rowX, assistantX,
        'the row heads the group at the message column edge, not indented');
    assert.equal(rowX, userX);
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

test('CONVERSATION-VIEWER-BROWSER-NAVIGATION-001 preserves historical scroll without a pending-response control', async t => {
    const page = await openViewerPage(t);
    const originalHtml = messageHtml('message', 12);
    await sendPage(page, {
        ...hostileConversationPage,
        html: originalHtml,
    });
    assert.equal(await page.locator('[data-new-response]').count(), 0);
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
    assert.equal(await page.locator('[data-message-id="message-12"]').count(), 1);
    assert.equal(await page.locator('[data-new-response]').count(), 0);
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

test('CONVERSATION-NAVIGATION-STATE-001 CONVERSATION-READING-FOCUS-001 highlights only the selected input and does not replay the locator on live refresh', async t => {
    const page = await openViewerPage(t);
    const outline = [{
        interactionId: 'highlight-0',
        userPreview: 'Highlighted input',
        responseState: 'inProgress',
    }];
    await sendPage(page, {
        ...hostileConversationPage,
        html: interactionHtml('highlight', 1, 3),
        outline,
        selectedInteractionId: 'highlight-0',
        selectedInput: 1,
        totalInputs: 1,
        atLatest: true,
        previousCursor: undefined,
        nextCursor: undefined,
    });
    const initialHighlights = await page.locator(
        '.conversation-selected-interaction'
    ).evaluateAll(elements => elements.map(element =>
        element.getAttribute('data-message-id')
    ));

    await page.locator('.conversation-selected-interaction').evaluateAll(
        elements => elements.forEach(element =>
            element.classList.remove('conversation-selected-interaction')
        )
    );
    const refreshHighlights = [];
    for (const requestId of [2, 3]) {
        await sendPage(page, {
            ...hostileConversationPage,
            requestId,
            updateKind: 'refresh',
            html: interactionHtml('highlight', 1, requestId + 2),
            outline,
            selectedInteractionId: 'highlight-0',
            selectedInput: 1,
            totalInputs: 1,
            atLatest: true,
            previousCursor: undefined,
            nextCursor: undefined,
        });
        refreshHighlights.push(await page.locator(
            '.conversation-selected-interaction'
        ).evaluateAll(elements => elements.map(element =>
            element.getAttribute('data-message-id')
        )));
        await page.locator('.conversation-selected-interaction').evaluateAll(
            elements => elements.forEach(element =>
                element.classList.remove('conversation-selected-interaction')
            )
        );
    }

    assert.deepEqual(refreshHighlights, [[], []]);
    assert.deepEqual(initialHighlights, ['highlight-0-user']);
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

test('CONVERSATION-VIEWER-BROWSER-SCROLL-001 CONVERSATION-READING-FOCUS-001 follows new content from the end and preserves historical reading focus', async t => {
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
    await sendPage(page, {
        ...baseMessage,
        requestId: 2,
        updateKind: 'refresh',
        html: appendedHtml,
        totalInputs: 21,
    });
    assert.ok(
        await scroll.evaluate(element =>
            element.scrollHeight - element.clientHeight - element.scrollTop
                <= 1
        ),
        'live refresh follows newly appended content when already at the end'
    );
    assert.equal(
        await page.evaluate(() =>
            document.activeElement?.getAttribute('data-message-id')),
        'follow-10'
    );
    assert.equal(await page.locator('[data-new-response]').count(), 0);

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
    assert.equal(await page.locator('[data-new-response]').count(), 0);
});

test('CONVERSATION-SCROLL-CONTAINMENT-001 keeps overscroll inside the message viewport without moving telemetry', async t => {
    const interactionId = 'input-scroll-containment';
    const messages = Array.from({ length: 40 }, (_item, index) => ({
        id: `${interactionId}:assistant:${index}`,
        interactionId,
        role: 'assistant',
        markdown: `Progress line ${index + 1}: inspect the active conversation.`,
    }));
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        trackScrollIntoView: true,
        interactionIds: [interactionId],
        interactionId,
        pageOverrides: {
            messages,
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    const telemetry = page.locator('[data-conversation-telemetry]');
    await telemetry.evaluate(element => {
        element.hidden = false;
    });
    const scroll = page.locator('[data-conversation-scroll]');
    await scroll.evaluate(element => {
        element.scrollTop = element.scrollHeight - element.clientHeight;
    });
    await scroll.hover();
    await page.mouse.wheel(0, 4_000);

    const layout = await page.evaluate(() => {
        const reader = document.querySelector('[data-conversation-scroll]');
        const usage = document.querySelector('[data-conversation-telemetry]');
        return {
            rootScrollTop: document.documentElement.scrollTop,
            bodyScrollTop: document.body.scrollTop,
            rootOverflowY: getComputedStyle(document.documentElement).overflowY,
            bodyOverflowY: getComputedStyle(document.body).overflowY,
            readerOverscrollY: getComputedStyle(reader).overscrollBehaviorY,
            telemetryTop: usage.getBoundingClientRect().top,
            telemetryBottom: usage.getBoundingClientRect().bottom,
            viewportHeight: window.innerHeight,
        };
    });
    assert.deepEqual(
        [layout.rootOverflowY, layout.bodyOverflowY],
        ['hidden', 'hidden']
    );
    assert.equal(layout.readerOverscrollY, 'contain');
    assert.equal(layout.rootScrollTop, 0);
    assert.equal(layout.bodyScrollTop, 0);
    assert.ok(layout.telemetryTop >= 0);
    assert.ok(layout.telemetryBottom <= layout.viewportHeight);

    await page.locator('[data-action="latest"]').click();
    const latestInteractionId = 'input-latest';
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'navigation',
        html: Array.from({ length: 40 }, (_item, index) =>
            `<article data-message-id="latest-${index}"
                data-interaction-id="${latestInteractionId}">
                <section><p>Latest response line ${index + 1}</p></section>
            </article>`
        ).join(''),
        outline: [{
            interactionId: latestInteractionId,
            userPreview: 'Latest input',
            responseState: 'complete',
        }],
        selectedInteractionId: latestInteractionId,
        selectedInput: 1,
        totalInputs: 1,
        atLatest: true,
        previousCursor: undefined,
        nextCursor: undefined,
    });

    const latestLayout = await page.evaluate(() => {
        const header = document.querySelector('.conversation-header');
        const usage = document.querySelector('[data-conversation-telemetry]');
        return {
            rootScrollTop: document.documentElement.scrollTop,
            bodyScrollTop: document.body.scrollTop,
            headerTop: header.getBoundingClientRect().top,
            telemetryTop: usage.getBoundingClientRect().top,
        };
    });
    assert.equal(latestLayout.rootScrollTop, 0);
    assert.equal(latestLayout.bodyScrollTop, 0);
    assert.ok(latestLayout.headerTop >= 0);
    assert.ok(latestLayout.telemetryTop >= 0);
    assert.deepEqual(
        await page.evaluate(() => window.__scrollIntoViewCalls),
        [],
        'Latest navigation must scroll only the message viewport'
    );
});

test('CONVERSATION-WORKING-INDICATOR-001 shows an animated status only for the latest in-progress response', async t => {
    const page = await openViewerPage(t);
    await page.addStyleTag({ content: viewerCss });
    const working = page.locator('[data-conversation-working]');
    const inProgressOutline = [{
        interactionId: 'input-4',
        userPreview: 'Waiting for a response',
        responseState: 'inProgress',
    }];

    await sendPage(page, {
        ...hostileConversationPage,
        outline: inProgressOutline,
        atLatest: true,
        totalInputs: 4,
    });

    assert.equal(await working.isVisible(), true);
    assert.equal((await working.innerText()).trim(), 'Working');
    assert.notEqual(await working.locator(
        '.conversation-working-dot'
    ).first().evaluate(element =>
        getComputedStyle(element).animationName
    ), 'none');
    for (const width of [700, 240]) {
        await page.setViewportSize({ width, height: 500 });
        const fitsViewport = await working.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return bounds.left >= 0
                && bounds.right <= document.documentElement.clientWidth
                && element.scrollWidth <= element.clientWidth;
        });
        assert.equal(fitsViewport, true, `Working fits at ${width}px`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await working.locator(
        '.conversation-working-dot'
    ).first().evaluate(element =>
        getComputedStyle(element).animationName
    ), 'none');

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'refresh',
        html: hostileConversationPage.html + `
            <article data-message-id="message-new-request"
                data-interaction-id="input-5">
                <section>New request</section>
            </article>`,
        outline: [
            { ...inProgressOutline[0], responseState: 'complete' },
            {
                interactionId: 'input-5',
                userPreview: 'New request',
                responseState: 'inProgress',
            },
        ],
        selectedInteractionId: 'input-5',
        atLatest: true,
        totalInputs: 5,
    });
    assert.equal(await working.isVisible(), true,
        'a newly appended running input must not hide Working');

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 3,
        updateKind: 'refresh',
        html: hostileConversationPage.html + `
            <article data-message-id="message-new-request"
                data-interaction-id="input-5">
                <section>New request</section>
            </article>`,
        outline: [
            { ...inProgressOutline[0], responseState: 'complete' },
            {
                interactionId: 'input-5',
                userPreview: 'New request',
                responseState: 'inProgress',
            },
        ],
        selectedInteractionId: 'input-4',
        atLatest: false,
        totalInputs: 5,
    });
    assert.equal(await page.locator(
        '[data-conversation-messages] [data-interaction-id="input-5"]'
    ).count(), 1, 'the latest running input is rendered in the current page');
    assert.equal(await working.isVisible(), true,
        'a rendered latest running input must show Working even before selection follows it');

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 4,
        updateKind: 'navigation',
        outline: [
            { ...inProgressOutline[0], responseState: 'complete' },
            {
                interactionId: 'input-5',
                userPreview: 'New request',
                responseState: 'inProgress',
            },
        ],
        selectedInteractionId: 'input-4',
        atLatest: false,
        totalInputs: 5,
    });
    assert.equal(await working.isHidden(), true);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 5,
        updateKind: 'refresh',
        outline: [{
            interactionId: 'input-5',
            userPreview: 'New request',
            responseState: 'complete',
        }],
        selectedInteractionId: 'input-5',
        atLatest: true,
        totalInputs: 5,
    });
    assert.equal(await working.isHidden(), true);
});

test('CONVERSATION-VIEWER-BROWSER-PENDING-001 applies repeated refreshes without a pending-response control', async t => {
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

    assert.equal(await page.locator('[data-message-id="pending-new-0"]').count(), 1);
    assert.equal(await page.locator('[data-message-id="pending-later-0"]').count(), 1);
    assert.equal(await page.locator('[data-new-response]').count(), 0);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 5,
        updateKind: 'navigation',
        html: originalHtml + messageHtml('historical-page', 1),
    });
    assert.equal(await page.locator('[data-new-response]').count(), 0);
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
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 7,
        subscriptionGeneration: 2,
        html: messageHtml('invalid-generation-2', 1),
        target: {
            projectId: 'project-1',
            provider: 'kimi',
            sessionId: 'kimi-session',
            interactionId: 'input-4',
            displayName: 'Kimi Session',
        },
        comments: { revision: 0, comments: [{}] },
        bookmarks: { revision: 0, interactionIds: [] },
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 6,
        html: messageHtml('request-6', 1),
    });

    assert.equal(await page.locator('[data-message-id="request-5-0"]').count(), 0);
    assert.equal(await page.locator('[data-message-id="request-6-0"]').count(), 1);
    assert.equal(await page.locator('[data-message-id="request-4-0"]').count(), 0);
    assert.equal(await page.locator('[data-message-id="generation-2-0"]').count(), 0);
    assert.equal(await page.locator(
        '[data-message-id="invalid-generation-2-0"]'
    ).count(), 0);
    assert.equal(await page.locator('[data-conversation-provider]').innerText(), 'Codex');
});

test('CONVERSATION-VIEWER-BROWSER-RACE-001 treats a refresh that wins initial loading as the initial page', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        ...hostileConversationPage,
        updateKind: 'refresh',
    });

    assert.equal(await page.locator('[data-new-response]').count(), 0);
    assert.equal(await page.locator(
        '[data-interaction-id="input-4"].conversation-selected-interaction'
    ).count(), 1);
});

test('CONVERSATION-VIEWER-BROWSER-REFRESH-001 CONVERSATION-READING-FOCUS-001 follows or preserves a real Host history window at the end threshold', async t => {
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
        if (distance <= 8) {
            assert.ok(await scroll.evaluate(element =>
                element.scrollHeight - element.clientHeight
                    - element.scrollTop <= 1
            ));
        } else {
            assert.equal(
                await scroll.evaluate(element => element.scrollTop),
                before
            );
        }
        assert.equal(await page.locator('[data-new-response]').count(), 0);
    }
});

test('CONVERSATION-TELEMETRY-001 renders the worktree chip, degrades missing paths, and posts open-worktree on click', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-telemetry',
            worktree: {
                branch: 'feat/worktree',
                worktreeRoot: '/repo/.worktree/feat-worktree',
                repoRoot: '/repo',
            },
            rateLimits: [],
        },
    });

    const chip = page.locator('[data-telemetry-worktree]');
    assert.equal(await chip.isVisible(), true);
    assert.equal(
        await page.locator('[data-telemetry-worktree-branch]').textContent(),
        'feat/worktree'
    );
    assert.match(
        await chip.getAttribute('title'),
        /Click to show changes in Source Control/
    );
    assert.equal(
        await page.locator('[data-conversation-telemetry]').isVisible(),
        true
    );

    await chip.click();
    assert.deepEqual(await postedMessages(page), [
        {
            type: 'conversation-viewer-focus',
            version: 1,
            focused: true,
        },
        {
            type: 'conversation-viewer-open-worktree',
            version: 1,
            worktreeRoot: '/repo/.worktree/feat-worktree',
        },
    ]);

    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 2,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-telemetry',
            worktree: {
                branch: 'feat/gone',
                worktreeRoot: '/repo/.worktree/feat-gone',
                repoRoot: '/repo',
                missing: true,
            },
            rateLimits: [],
        },
    });
    assert.equal(
        await chip.getAttribute('class'),
        'conversation-telemetry-worktree conversation-telemetry-worktree-missing'
    );
    assert.match(await chip.getAttribute('title'), /no longer exists/);

    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 3,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-telemetry',
            model: 'gpt-5.6-sol',
            rateLimits: [],
        },
    });
    assert.equal(await chip.isHidden(), true);

    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 4,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-telemetry',
            worktree: { branch: 42 },
            rateLimits: [],
        },
    });
    assert.equal(
        await page.locator('[data-telemetry-model-value]').textContent(),
        'gpt-5.6-sol',
        'malformed worktree telemetry must be rejected as a whole'
    );
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 renders collapsible tool calls and strips hostile attributes', async t => {
    const page = await openViewerPage(t, {});
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html: `<article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <details class="conversation-tool-call" ontoggle="window.__pwned = true">
            <summary><span class="conversation-tool-name">Shell</span> Shell npm test</summary>
            <pre class="conversation-tool-detail"><code>9 passing</code></pre>
        </details>
    </article>`,
        subagents: [],
        activeSubagent: null,
    });

    const details = page.locator('.conversation-tool-call');
    assert.equal(await details.count(), 1);
    assert.match(await details.locator('summary').innerText(), /Shell npm test/);
    assert.equal(
        await details.evaluate(element => element.hasAttribute('ontoggle')),
        false,
        'event handler attributes must be stripped'
    );
    assert.equal(await details.evaluate(element => element.open), false);
    await details.locator('summary').click();
    assert.equal(await details.evaluate(element => element.open), true);
    assert.match(
        await details.locator('.conversation-tool-detail').innerText(),
        /9 passing/
    );
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 pins running subagents above finished ones', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html: messageHtml('main-session-message', 1),
        subagents: [
            {
                id: 'a11111111',
                label: 'Finished first',
                status: 'idle',
                updatedAt: Date.now() - 3 * 24 * 60 * 60 * 1000,
            },
            {
                id: 'a22222222',
                label: 'Quiet worker',
                status: 'quiet',
                updatedAt: Date.now() - 12 * 60 * 1000,
            },
            {
                id: 'a33333333',
                label: 'Still running',
                status: 'running',
                updatedAt: Date.now() - 3 * 60 * 1000,
            },
        ],
        activeSubagent: null,
    });

    await page.locator('[data-action="toggle-sidebar"]').click();
    await page.locator('[data-sidebar-tab="subagents"]').click();
    const ids = await page.locator('[data-subagent-id]').evaluateAll(
        elements => elements.map(element =>
            element.getAttribute('data-subagent-id'))
    );
    assert.deepEqual(ids, ['a33333333', 'a22222222', 'a11111111']);
    assert.equal(
        await page.locator('[data-subagent-id="a22222222"] .conversation-subagent-status').innerText(),
        'Quiet'
    );
    assert.equal(
        await page.locator('[data-subagent-id="a33333333"] .conversation-subagent-time').innerText(),
        '3m ago'
    );
    assert.equal(
        await page.locator('[data-subagent-id="a22222222"] .conversation-subagent-time').innerText(),
        '12m ago'
    );

    // The Running only filter keeps quiet (not-finished) entries visible.
    await page.locator('[data-subagents-running-only]').check();
    const filteredIds = await page.locator('[data-subagent-id]').evaluateAll(
        elements => elements.map(element =>
            element.getAttribute('data-subagent-id'))
    );
    assert.deepEqual(filteredIds, ['a33333333', 'a22222222']);
});

test('CONVERSATION-THINKING-VISIBILITY-001 renders collapsed thinking blocks and strips hostile markup', async t => {
    const page = await openViewerPage(t, {});
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html: `<article class="conversation-message conversation-message-thinking"
            data-message-id="input-4:thinking:0"
            data-conversation-message-id="input-4%3Athinking%3A0"
            data-interaction-id="input-4">
        <details class="conversation-thinking" ontoggle="window.__pwned = true">
            <summary>Thinking</summary>
            <pre class="conversation-thinking-body">Compare the two runs.</pre>
        </details>
    </article>`,
        subagents: [],
        activeSubagent: null,
    });

    const details = page.locator('.conversation-thinking');
    assert.equal(await details.count(), 1);
    assert.match(await details.locator('summary').innerText(), /Thinking/);
    assert.equal(
        await details.evaluate(element => element.hasAttribute('ontoggle')),
        false,
        'event handler attributes must be stripped'
    );
    assert.equal(await details.evaluate(element => element.open), false);
    await details.locator('summary').click();
    assert.equal(await details.evaluate(element => element.open), true);
    assert.match(
        await details.locator('.conversation-thinking-body').innerText(),
        /Compare the two runs\./
    );
});

test('CONVERSATION-THINKING-VISIBILITY-001 omits Thinking from the default Host document and renders it when enabled', async t => {
    const thinkingMessage = {
        id: 'input-2:thinking:0',
        interactionId: 'input-2',
        role: 'thinking',
        markdown: '',
        thinking: { text: 'Compare the two runs.' },
    };
    const hidden = await openHostViewerDocument(t, {
        showThinking: () => false,
        pageOverrides: { messages: [thinkingMessage] },
    });
    assert.equal(
        await hidden.page.locator('.conversation-message-thinking').count(),
        0
    );

    const shown = await openHostViewerDocument(t, {
        showThinking: () => true,
        pageOverrides: { messages: [thinkingMessage] },
    });
    const details = shown.page.locator('.conversation-thinking');
    assert.equal(await details.count(), 1);
    assert.equal(await details.evaluate(element => element.open), false);
    await details.locator('summary').click();
    assert.equal(
        await details.locator('.conversation-thinking-body').innerText(),
        'Compare the two runs.'
    );
});

test('CONVERSATION-PROGRESS-VISIBILITY-001 renders progress by default while Thinking remains hidden', async t => {
    const opened = await openHostViewerDocument(t, {
        showThinking: () => false,
        pageOverrides: {
            messages: [
                {
                    id: 'input-2:progress:0',
                    interactionId: 'input-2',
                    role: 'progress',
                    markdown: 'Running the cross-provider checks.',
                },
                {
                    id: 'input-2:thinking:0',
                    interactionId: 'input-2',
                    role: 'thinking',
                    markdown: '',
                    thinking: { text: 'Private reasoning.' },
                },
            ],
        },
    });
    const progress = opened.page.locator('.conversation-progress');
    assert.equal(await progress.count(), 1);
    assert.match(await progress.innerText(), /Running the cross-provider checks\./);
    assert.equal(
        await progress.locator('.conversation-progress-label').textContent(),
        'Progress:'
    );
    assert.equal(
        await opened.page.locator('.conversation-message-thinking').count(),
        0
    );
    for (const width of [700, 240]) {
        await opened.page.setViewportSize({ width, height: 500 });
        assert.equal(await progress.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return bounds.left >= 0
                && bounds.right <= document.documentElement.clientWidth
                && element.scrollWidth <= element.clientWidth;
        }), true, `Progress fits at ${width}px`);
    }
});

test('CONVERSATION-PROVIDER-PARITY-001 keeps default disclosure and live status consistent for Codex, Claude, and Kimi', async t => {
    for (const fixture of [
        { provider: 'codex', label: 'Codex' },
        { provider: 'claude', label: 'Claude' },
        { provider: 'kimi', label: 'Kimi' },
    ]) {
        const interactionId = `${fixture.provider}-input`;
        const { page } = await openHostViewerDocument(t, {
            provider: fixture.provider,
            includeStyles: true,
            themeFixture: viewerThemeFixtures[0],
            interactionIds: [interactionId],
            interactionId,
            responseStates: { [interactionId]: 'inProgress' },
            showThinking: () => false,
            pageOverrides: {
                messages: [
                    {
                        id: `${interactionId}:user`,
                        interactionId,
                        role: 'user',
                        markdown: `Test ${fixture.label}`,
                    },
                    {
                        id: `${interactionId}:progress:0`,
                        interactionId,
                        role: 'progress',
                        markdown: `${fixture.label} is checking the workspace.`,
                    },
                    {
                        id: `${interactionId}:thinking:0`,
                        interactionId,
                        role: 'thinking',
                        markdown: '',
                        thinking: { text: `${fixture.label} private reasoning.` },
                    },
                    {
                        id: `${interactionId}:tool:0`,
                        interactionId,
                        role: 'tool',
                        markdown: '',
                        tool: {
                            name: 'Read',
                            summary: 'Read the active file',
                            detail: 'file contents',
                        },
                    },
                ],
                interactionStates: [{
                    interactionId,
                    responseState: 'inProgress',
                }],
                previousCursor: undefined,
                nextCursor: undefined,
                isStart: true,
                isEnd: true,
            },
        });

        assert.equal(
            await page.locator('.conversation-identity strong').innerText(),
            fixture.label
        );
        assert.match(
            await page.locator('.conversation-progress').innerText(),
            new RegExp(`${fixture.label} is checking the workspace\\.`)
        );
        assert.equal(
            await page.locator('.conversation-message-thinking').count(),
            0,
            `${fixture.label} must hide Thinking by default`
        );
        assert.equal(
            await page.locator('.conversation-tool-call').evaluate(
                element => element.open
            ),
            false,
            `${fixture.label} tool calls must start collapsed`
        );
        assert.equal(
            await page.locator('[data-conversation-working]').isVisible(),
            true,
            `${fixture.label} must show Working for its latest live response`
        );
        assert.equal(
            await page.locator('[data-new-response]').count(),
            0,
            `${fixture.label} must never require a New response content control`
        );
    }
});

test('CONVERSATION-CHROME-LAYOUT-001 keeps header, telemetry, and the message viewport bounded at wide and narrow widths', async t => {
    const interactionId = 'layout-input';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 700, height: 500 },
        interactionIds: [interactionId],
        interactionId,
        responseStates: { [interactionId]: 'inProgress' },
        pageOverrides: {
            messages: Array.from({ length: 40 }, (_item, index) => ({
                id: `${interactionId}:assistant:${index}`,
                interactionId,
                role: 'assistant',
                markdown: `Visible response line ${index + 1}.`,
            })),
            interactionStates: [{
                interactionId,
                responseState: 'inProgress',
            }],
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-host-document',
            model: 'gpt-5.6-sol',
            context: { usedTokens: 32_000, maxTokens: 128_000 },
            worktree: {
                branch: 'feature/telemetry-rings',
                worktreeRoot: '/repo/.worktree/telemetry-rings',
                repoRoot: '/repo',
            },
            rateLimits: [{
                id: 'codex:secondary',
                label: 'Week',
                usedPercent: 40,
            }],
        },
    });

    for (const width of [700, 400, 360, 320, 281, 240]) {
        await page.setViewportSize({ width, height: 500 });
        const layout = await page.evaluate(() => {
            const header = document.querySelector('.conversation-header');
            const telemetry = document.querySelector(
                '[data-conversation-telemetry]'
            );
            const workspace = document.querySelector(
                '.conversation-workspace'
            );
            const reader = document.querySelector(
                '[data-conversation-scroll]'
            );
            const headerBounds = header.getBoundingClientRect();
            const telemetryBounds = telemetry.getBoundingClientRect();
            const workspaceBounds = workspace.getBoundingClientRect();
            const readerBounds = reader.getBoundingClientRect();
            return {
                rootScrollTop: document.documentElement.scrollTop,
                bodyScrollTop: document.body.scrollTop,
                rootHeight: document.documentElement.scrollHeight,
                viewportHeight: document.documentElement.clientHeight,
                headerTop: headerBounds.top,
                headerBottom: headerBounds.bottom,
                telemetryTop: telemetryBounds.top,
                telemetryBottom: telemetryBounds.bottom,
                workspaceTop: workspaceBounds.top,
                workspaceBottom: workspaceBounds.bottom,
                readerTop: readerBounds.top,
                readerBottom: readerBounds.bottom,
                readerScrollable: reader.scrollHeight > reader.clientHeight,
                telemetryHeight: telemetryBounds.height,
                telemetryClientWidth: telemetry.clientWidth,
                telemetryScrollWidth: telemetry.scrollWidth,
                rootOverflow: getComputedStyle(
                    document.documentElement
                ).overflowY,
                bodyOverflow: getComputedStyle(document.body).overflowY,
            };
        });
        assert.equal(layout.rootScrollTop, 0, `root scroll at ${width}px`);
        assert.equal(layout.bodyScrollTop, 0, `body scroll at ${width}px`);
        assert.equal(layout.rootHeight, layout.viewportHeight);
        assert.deepEqual(
            [layout.rootOverflow, layout.bodyOverflow],
            ['hidden', 'hidden']
        );
        assert.ok(layout.headerTop >= 0);
        assert.ok(layout.telemetryTop >= layout.headerBottom - 1);
        assert.ok(layout.workspaceTop >= layout.telemetryBottom - 1);
        assert.ok(layout.readerTop >= layout.workspaceTop - 1);
        assert.ok(layout.readerBottom <= layout.workspaceBottom + 1);
        assert.ok(layout.workspaceBottom <= layout.viewportHeight + 1);
        assert.equal(layout.readerScrollable, true);
        assert.ok(
            layout.telemetryHeight <= (width > 360 ? 48 : 42),
            `telemetry grew vertically at ${width}px`
        );
        assert.ok(
            layout.telemetryScrollWidth <= layout.telemetryClientWidth + 1,
            `telemetry overflowed horizontally at ${width}px`
        );

        const reader = page.locator('[data-conversation-scroll]');
        await reader.evaluate(element => {
            element.scrollTop = element.scrollHeight - element.clientHeight;
        });
        await reader.hover();
        await page.mouse.wheel(0, 4_000);
        assert.deepEqual(await page.evaluate(() => [
            document.documentElement.scrollTop,
            document.body.scrollTop,
        ]), [0, 0], `overscroll escaped at ${width}px`);
    }

    await page.setViewportSize({ width: 700, height: 500 });
    await page.locator('[data-telemetry-context]').hover();
    const tooltipState = await page.locator(
        '[data-telemetry-context]'
    ).evaluate(element => {
        const style = getComputedStyle(element, '::after');
        return { content: style.content, visibility: style.visibility };
    });
    assert.equal(tooltipState.visibility, 'visible');
    assert.match(tooltipState.content, /Context window/);
    assert.deepEqual(
        await page.locator(
            '[data-telemetry-context], [data-telemetry-limit]'
        ).evaluateAll(elements => elements.map(element =>
            element.getAttribute('tabindex')
        )),
        ['0', '0'],
        'usage details must remain keyboard-focusable after labels become icons'
    );
    const orderedLeftEdges = await page.locator([
        '[data-telemetry-model]',
        '[data-telemetry-worktree]',
        '[data-telemetry-context]',
        '[data-telemetry-limit]',
        '[data-conversation-position]',
        '[data-telemetry-comments]',
        '[data-telemetry-subagents]',
    ].join(',')).evaluateAll(elements => elements.map(element =>
        Math.round(element.getBoundingClientRect().left)
    ));
    assert.deepEqual(
        orderedLeftEdges,
        [...orderedLeftEdges].sort((a, b) => a - b),
        'telemetry must follow model, branch, usage, then quick-entry order'
    );

    await page.emulateMedia({ forcedColors: 'active' });
    const forcedColorStroke = await page.locator(
        '[data-telemetry-context-progress]'
    ).evaluate(element => getComputedStyle(element).stroke);
    assert.notEqual(forcedColorStroke, 'none');
    assert.notEqual(
        forcedColorStroke,
        'rgba(0, 0, 0, 0)',
        'forced colors must preserve a visible progress-ring stroke'
    );
    assert.equal(
        await page.locator('[data-conversation-position]').evaluate(
            element => getComputedStyle(element).borderTopStyle
        ),
        'solid'
    );
});

test('CONVERSATION-LIVE-UPDATE-JOURNEY-001 preserves telemetry, auto-follow, history, and Working through a response lifecycle', async t => {
    const interactionId = 'live-input';
    const initialHtml = messageHtml('live-history', 30)
        + `<article data-message-id="live-current"
            data-interaction-id="${interactionId}">
            <section><p>Initial live output.</p></section>
        </article>`;
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: [interactionId],
        interactionId,
        responseStates: { [interactionId]: 'inProgress' },
        pageOverrides: {
            messages: Array.from({ length: 30 }, (_item, index) => ({
                id: `live-history-${index}`,
                interactionId: `live-history-${index}`,
                role: 'assistant',
                markdown: `History ${index + 1}.`,
            })).concat({
                id: 'live-current',
                interactionId,
                role: 'progress',
                markdown: 'Initial live output.',
            }),
            interactionStates: [{
                interactionId,
                responseState: 'inProgress',
            }],
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    await sendPage(page, {
        type: 'conversation-viewer-telemetry',
        version: 1,
        requestId: 1,
        subscriptionGeneration: 1,
        telemetry: {
            provider: 'codex',
            sessionId: 'session-host-document',
            model: 'gpt-5.6-sol',
            rateLimits: [],
        },
    });
    const reader = page.locator('[data-conversation-scroll]');
    assert.equal(await page.locator('[data-conversation-working]').isVisible(), true);

    const appendedHtml = initialHtml + messageHtml('live-appended', 3);
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'refresh',
        html: appendedHtml,
        outline: [{
            interactionId,
            userPreview: 'Live input',
            responseState: 'inProgress',
        }],
        selectedInteractionId: interactionId,
        selectedInput: 1,
        totalInputs: 1,
        atLatest: true,
        previousCursor: undefined,
        nextCursor: undefined,
    });
    assert.ok(await reader.evaluate(element =>
        element.scrollHeight - element.clientHeight - element.scrollTop <= 1
    ));
    assert.equal(await page.locator('[data-conversation-working]').isVisible(), true);
    assert.equal(await page.locator('[data-new-response]').count(), 0);
    assert.equal(
        await page.locator('[data-telemetry-model-value]').innerText(),
        'gpt-5.6-sol'
    );

    await reader.evaluate(element => {
        element.scrollTop = Math.max(
            0,
            element.scrollHeight - element.clientHeight - 40
        );
    });
    const historicalScrollTop = await reader.evaluate(
        element => element.scrollTop
    );
    const laterHtml = appendedHtml + messageHtml('live-later', 2);
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 3,
        updateKind: 'refresh',
        html: laterHtml,
        outline: [{
            interactionId,
            userPreview: 'Live input',
            responseState: 'inProgress',
        }],
        selectedInteractionId: interactionId,
        selectedInput: 1,
        totalInputs: 1,
        atLatest: true,
        previousCursor: undefined,
        nextCursor: undefined,
    });
    assert.equal(
        await reader.evaluate(element => element.scrollTop),
        historicalScrollTop,
        'a reader away from the end must not be pulled down'
    );

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 4,
        updateKind: 'refresh',
        html: laterHtml,
        outline: [{
            interactionId,
            userPreview: 'Live input',
            responseState: 'complete',
        }],
        selectedInteractionId: interactionId,
        selectedInput: 1,
        totalInputs: 1,
        atLatest: true,
        previousCursor: undefined,
        nextCursor: undefined,
    });
    assert.equal(await page.locator('[data-conversation-working]').isHidden(), true);
    assert.equal(await page.locator('[data-new-response]').count(), 0);
    assert.equal(
        await page.locator('[data-telemetry-model-value]').innerText(),
        'gpt-5.6-sol',
        'content refreshes must not replace telemetry'
    );
});

test('CONVERSATION-NAVIGATION-STATE-001 keeps controls, status, focus, and scroll ownership correlated', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        trackScrollIntoView: true,
    });
    const previous = page.locator('[data-action="previous"]');
    const next = page.locator('[data-action="next"]');
    const latest = page.locator('[data-action="latest"]');
    assert.equal(await page.locator('[data-conversation-position]').innerText(), '2/3');
    assert.equal(await previous.isEnabled(), true);
    assert.equal(await next.isEnabled(), true);
    assert.equal(await latest.isEnabled(), true);

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        updateKind: 'navigation',
        html: interactionHtml('nav', 1, 3),
        outline: [{
            interactionId: 'nav-0',
            userPreview: 'First input',
            responseState: 'complete',
        }],
        selectedInteractionId: 'nav-0',
        selectedInput: 1,
        totalInputs: 3,
        partial: true,
        atLatest: false,
        previousCursor: undefined,
        nextCursor: 'next-page',
        stale: true,
    });
    assert.equal(await page.locator('[data-conversation-position]').innerText(), '1/3+');
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.isEnabled(), true);
    assert.match(
        await page.locator('[data-conversation-status]').innerText(),
        /out of date.*Partial history/
    );

    await latest.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-latest',
        version: 1,
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 3,
        updateKind: 'navigation',
        html: interactionHtml('nav', 3, 20),
        outline: [0, 1, 2].map(index => ({
            interactionId: `nav-${index}`,
            userPreview: `Input ${index + 1}`,
            responseState: 'complete',
        })),
        selectedInteractionId: 'nav-2',
        selectedInput: 3,
        totalInputs: 3,
        partial: false,
        atLatest: true,
        previousCursor: 'previous-page',
        nextCursor: undefined,
        stale: false,
    });
    assert.equal(await page.locator('[data-conversation-position]').innerText(), '3/3');
    assert.equal(await previous.isEnabled(), true);
    assert.equal(await next.isDisabled(), true);
    assert.equal(await page.locator('[data-conversation-status]').innerText(), '');
    assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute(
            'data-message-id'
        )),
        'nav-2-user'
    );
    assert.equal(await page.evaluate(() => {
        const reader = document.querySelector('[data-conversation-scroll]');
        const selected = document.querySelector(
            '[data-message-id="nav-2-user"]'
        ).getBoundingClientRect();
        const bounds = reader.getBoundingClientRect();
        return selected.bottom > bounds.top && selected.top < bounds.bottom;
    }), true);
    assert.deepEqual(await page.evaluate(() => [
        document.documentElement.scrollTop,
        document.body.scrollTop,
    ]), [0, 0]);
    assert.deepEqual(
        await page.evaluate(() => window.__scrollIntoViewCalls),
        [],
        'navigation must remain inside the message viewport'
    );
});




test('TMP repro add flow from closed sidebar', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        interactionIds: ['input-repro'],
        interactionId: 'input-repro',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.locator('[data-action="toggle-sidebar"]').click();
    await page.locator('[data-sidebar-tab="comments"]').click();
    await page.locator('[data-project-comments-header]')
        .locator('[data-project-comment-action="open-composer"]').click();
    console.log('TMP composer visible:',
        await page.locator('[data-project-comment-composer]').isVisible());
    await page.locator('[data-project-comment-input]').fill('测试笔记');
    console.log('TMP add disabled:',
        await page.locator('[data-project-comment-action="add"]')
            .isDisabled());
    await page.locator('[data-project-comment-action="add"]').click();
    const requests = await postedMessages(page);
    console.log('TMP last request:', JSON.stringify(requests.at(-1)));
    console.log('TMP pageErrors:', JSON.stringify(pageErrors));
});

