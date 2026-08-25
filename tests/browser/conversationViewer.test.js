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
const conversationRegistryScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationRegistryScripts.js'),
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
const conversationChangesScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationChangesScripts.js'),
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
                --vscode-testing-iconPassed: #73c991;
                --vscode-errorForeground: #f48771;
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
                --vscode-testing-iconPassed: #388a34;
                --vscode-errorForeground: #d72e2b;
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
                    <span data-conversation-workspace-name>Test Workspace</span>
                    <span class="conversation-identity-separator"
                        data-conversation-task-separator aria-hidden="true"
                        hidden>·</span>
                    <span data-conversation-task-name hidden></span>
                    <span class="conversation-identity-separator"
                        aria-hidden="true">·</span>
                    <button type="button" class="conversation-display-name-button"
                        data-conversation-display-name data-action="rename-session"
                        title="Rename session" aria-label="Rename session">Original session</button>
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
    await page.addScriptTag({ content: conversationRegistryScript });
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

// Applied acknowledgements are protocol traffic, not user intents.
async function postedIntents(page) {
    return (await postedMessages(page)).filter(message =>
        message.type !== 'conversation-viewer-applied'
    );
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
            workspaceName: 'Test Workspace',
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    assert.deepEqual(await page.evaluate(() => ({
        retainedRoot: document.querySelector('[data-conversation-messages]')
            === window.__retainedConversationMessages,
        workspaceName: document.querySelector('[data-conversation-workspace-name]')
            .textContent,
        telemetryProvider: document.querySelector('[data-telemetry-provider]')
            .getAttribute('data-provider'),
        telemetryProviderTitle: document
            .querySelector('[data-telemetry-provider]')
            .getAttribute('data-tooltip'),
        displayName: document.querySelector('[data-conversation-display-name]')
            .textContent,
        response: document.querySelector('[data-conversation-messages]')
            .textContent.trim(),
    })), {
        retainedRoot: true,
        workspaceName: 'Test Workspace',
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

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 applies delta publications without resending or re-sanitizing HTML', async t => {
    const page = await openViewerPage(t);
    const fullPage = {
        ...hostileConversationPage,
        requestId: 1,
        html: '<article data-message-id="delta-0" '
            + 'data-interaction-id="input-1"><p>Delta one</p></article>'
            + '<article data-message-id="delta-1" '
            + 'data-interaction-id="input-2"><p>Delta two</p></article>',
        htmlSignature: 'sig-delta-1',
        outline: [{
            interactionId: 'input-1',
            userPreview: 'Input 1',
            responseState: 'complete',
        }, {
            interactionId: 'input-2',
            userPreview: 'Input 2',
            responseState: 'complete',
        }],
        selectedInteractionId: 'input-1',
        selectedInput: 1,
        totalInputs: 2,
        previousCursor: undefined,
        nextCursor: undefined,
    };
    await sendPage(page, fullPage);
    assert.equal(
        await page.locator('[data-conversation-position]').textContent(),
        'Input 1 of 2'
    );
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.evaluate(() => {
        window.__deltaNode = document.querySelector(
            '[data-message-id="delta-0"]'
        );
        window.__sanitizeCalls = 0;
        const sanitize = window.DOMPurify.sanitize;
        window.DOMPurify.sanitize = function () {
            window.__sanitizeCalls += 1;
            return sanitize.apply(window.DOMPurify, arguments);
        };
        const messageContainer = document.querySelector(
            '[data-conversation-messages]'
        );
        const querySelectorAll = messageContainer.querySelectorAll.bind(
            messageContainer
        );
        messageContainer.querySelectorAll = function (selector) {
            if (selector === '.conversation-message-copy, .conversation-code-copy'
                || selector === '[data-conversation-run-command]') {
                throw new Error('delta must not rescan action controls');
            }
            return querySelectorAll(selector);
        };
    });

    const { html, ...deltaBase } = fullPage;
    await sendPage(page, {
        ...deltaBase,
        requestId: 2,
        updateKind: 'navigation',
        selectedInteractionId: 'input-2',
        selectedInput: 2,
    });
    await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));

    assert.deepEqual(await page.evaluate(() => ({
        nodeRetained: document.querySelector('[data-message-id="delta-0"]')
            === window.__deltaNode,
        sanitizeCalls: window.__sanitizeCalls,
        position: document.querySelector('[data-conversation-position]')
            .textContent,
    })), {
        nodeRetained: true,
        sanitizeCalls: 0,
        position: 'Input 2 of 2',
    });

    // Every successfully applied page is acknowledged with its correlated
    // generation, request id, and content signature.
    const appliedAcks = (await postedMessages(page)).filter(message =>
        message.type === 'conversation-viewer-applied'
    );
    assert.deepEqual(appliedAcks, [{
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: 1,
        requestId: 1,
        htmlSignature: 'sig-delta-1',
        frames: [],
    }, {
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: 1,
        requestId: 2,
        htmlSignature: 'sig-delta-1',
        frames: [],
    }]);
    assert.equal((await postedMessages(page)).some(message =>
        message.type === 'conversation-viewer-request-sync'
    ), false, 'the delta must not recover from an unnecessary action scan');

    // A delta whose signature does not match the applied content is dropped
    // and answered with a resync request instead of staying silently stale.
    await sendPage(page, {
        ...deltaBase,
        requestId: 3,
        htmlSignature: 'sig-unrelated',
        updateKind: 'navigation',
        selectedInteractionId: 'input-1',
        selectedInput: 1,
    });
    assert.equal(
        await page.locator('[data-conversation-position]').textContent(),
        'Input 2 of 2'
    );
    const syncs = (await postedMessages(page)).filter(message =>
        message.type === 'conversation-viewer-request-sync'
    );
    assert.deepEqual(syncs, [{
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 1,
        requestId: 3,
        htmlSignature: 'sig-unrelated',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-telemetry',
    }]);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 reuses the sanitized page when switching back to a recent session', async t => {
    const page = await openViewerPage(t);
    await page.evaluate(() => {
        window.__deferredPagePresentation = [];
        window.requestAnimationFrame = callback => {
            window.__deferredPagePresentation.push(callback);
            return window.__deferredPagePresentation.length;
        };
        window.__sanitizeCalls = 0;
        const sanitize = window.DOMPurify.sanitize;
        window.DOMPurify.sanitize = function () {
            window.__sanitizeCalls += 1;
            return sanitize.apply(window.DOMPurify, arguments);
        };
    });
    const sessionPage = (generation, sessionId, marker, signature) => ({
        ...hostileConversationPage,
        requestId: generation * 10,
        subscriptionGeneration: generation,
        html: `<article data-message-id="${marker}-0" `
            + `data-interaction-id="${marker}-input">`
            + '<button class="conversation-message-copy"></button>'
            + `<p>${marker}</p></article>`,
        htmlSignature: signature,
        outline: [{
            interactionId: `${marker}-input`,
            userPreview: marker,
            responseState: 'complete',
        }],
        selectedInteractionId: `${marker}-input`,
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
            interactionId: `${marker}-input`,
            displayName: `${marker} session`,
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    await sendPage(page, sessionPage(
        2, 'session-alpha', 'alpha-content', 'sig-alpha-1'
    ));
    await page.evaluate(() => {
        window.__alphaNode = document.querySelector(
            '[data-message-id="alpha-content-0"]'
        );
    });
    await sendPage(page, sessionPage(
        3, 'session-beta', 'beta-content', 'sig-beta-1'
    ));
    // Switching back to alpha with unchanged content must not re-sanitize.
    const restorePage = sessionPage(
        4, 'session-alpha', 'alpha-content', 'sig-alpha-1'
    );
    delete restorePage.html;
    restorePage.restoreFrame = true;
    await sendPage(page, restorePage);
    await page.evaluate(() => {
        for (let index = 0;
            index < window.__deferredPagePresentation.length;
            index += 1) {
            window.__deferredPagePresentation[index](0);
        }
    });

    assert.deepEqual(await page.evaluate(() => ({
        sanitizeCalls: window.__sanitizeCalls,
        content: document.querySelector('[data-conversation-messages]')
            .textContent.trim(),
        nodeIdentity: document.querySelector(
            '[data-message-id="alpha-content-0"]'
        ) === window.__alphaNode,
        copyLabel: document.querySelector('.conversation-message-copy')
            .getAttribute('aria-label'),
        copyIcon: !!document.querySelector('.conversation-message-copy svg'),
    })), {
        sanitizeCalls: 2,
        content: 'alpha-content',
        nodeIdentity: true,
        copyLabel: 'Copy',
        copyIcon: true,
    });
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 restores a stashed frame with scroll position on a host restoreFrame page', async t => {
    const page = await openViewerPage(t);
    // Inline style attributes do not survive sanitizing; give the blocks
    // height through a stylesheet instead so the viewport can scroll.
    await page.addStyleTag({
        content: '.alpha-tall { height: 120px; margin: 0; }',
    });
    await page.evaluate(() => {
        window.__sanitizeCalls = 0;
        const sanitize = window.DOMPurify.sanitize;
        window.DOMPurify.sanitize = function () {
            window.__sanitizeCalls += 1;
            return sanitize.apply(window.DOMPurify, arguments);
        };
    });
    const tall = Array.from({ length: 8 }, (_unused, index) =>
        `<article data-message-id="alpha-${index}" `
            + `data-interaction-id="alpha-input-${index}">`
            + '<section class="conversation-markdown">'
            + `<p class="alpha-tall">alpha block ${index}</p>`
            + '</section></article>'
    ).join('');
    const sessionPage = (generation, sessionId, marker, signature) => ({
        ...hostileConversationPage,
        requestId: generation * 10,
        subscriptionGeneration: generation,
        html: marker === 'alpha'
            ? tall
            : `<article data-message-id="${marker}-0" `
                + `data-interaction-id="${marker}-input-0"><p>${marker}</p></article>`,
        htmlSignature: signature,
        outline: [{
            interactionId: `${marker}-input-0`,
            userPreview: marker,
            responseState: 'complete',
        }],
        selectedInteractionId: `${marker}-input-0`,
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
            interactionId: `${marker}-input-0`,
            displayName: `${marker} session`,
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    await sendPage(page, sessionPage(2, 'session-alpha', 'alpha', 'sig-a1'));
    await page.evaluate(() => {
        const scroll = document.querySelector('[data-conversation-scroll]');
        scroll.scrollTop = 240;
        window.__alphaNode = document.querySelector(
            '[data-message-id="alpha-3"]'
        );
    });
    await sendPage(page, sessionPage(3, 'session-beta', 'beta', 'sig-b1'));
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'beta'
    );

    // The Host judges the alpha frame cached and sends no HTML at all.
    const restorePage = sessionPage(4, 'session-alpha', 'alpha', 'sig-a1');
    delete restorePage.html;
    restorePage.restoreFrame = true;
    await sendPage(page, restorePage);

    const outcome = await page.evaluate(() => ({
        sanitizeCalls: window.__sanitizeCalls,
        nodeIdentity: document.querySelector('[data-message-id="alpha-3"]')
            === window.__alphaNode,
        scrollTop: document.querySelector('[data-conversation-scroll]')
            .scrollTop,
        content: document.querySelector('[data-conversation-messages]')
            .textContent.includes('alpha block 3'),
    }));
    assert.equal(outcome.sanitizeCalls, 2,
        'the frame restore must not sanitize or parse');
    assert.equal(outcome.nodeIdentity, true,
        'the restore reattaches the very same DOM nodes');
    assert.equal(outcome.content, true);
    assert.ok(Math.abs(outcome.scrollTop - 240) <= 2,
        `scroll position should return to 240, got ${outcome.scrollTop}`);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 paints Chat content before deferred decorations and drops stale work', async t => {
    const page = await openViewerPage(t, { controlledMermaid: true });
    await page.evaluate(() => {
        window.__deferredPagePresentation = [];
        window.requestAnimationFrame = callback => {
            window.__deferredPagePresentation.push(callback);
            return window.__deferredPagePresentation.length;
        };
    });
    const sessionPage = (requestId, generation, sessionId, marker) => ({
        ...hostileConversationPage,
        requestId,
        subscriptionGeneration: generation,
        html: `<article data-message-id="${marker}-message" `
            + `data-interaction-id="${marker}-input">`
            + `<pre><code class="language-mermaid">flowchart TB\n${marker}</code></pre>`
            + '</article>',
        htmlSignature: `signature-${marker}`,
        outline: [{
            interactionId: `${marker}-input`,
            userPreview: marker,
            responseState: 'complete',
        }],
        selectedInteractionId: `${marker}-input`,
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
            interactionId: `${marker}-input`,
            displayName: marker,
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    await sendPage(page, sessionPage(2, 2, 'session-alpha', 'alpha'));
    await sendPage(page, sessionPage(3, 3, 'session-beta', 'beta'));

    assert.deepEqual(
        (await postedMessages(page)).filter(message =>
            message.type === 'conversation-viewer-applied'
        ).map(message => message.requestId),
        [],
        'a page stays pending until its full presentation has settled'
    );
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'flowchart TB\nbeta',
        'the newest Chat transcript is already usable'
    );
    assert.equal(
        await page.evaluate(() => window.__mermaidRenders.length),
        0,
        'Mermaid is outside the first visible Chat frame'
    );

    await page.evaluate(() => window.__deferredPagePresentation[0](0));
    await page.evaluate(() => window.__deferredPagePresentation[1](0));
    assert.deepEqual(
        (await postedMessages(page)).filter(message =>
            message.type === 'conversation-viewer-applied'
        ).map(message => message.requestId),
        [],
        'the first animation frame is reserved for the transcript paint'
    );

    await page.evaluate(() => window.__deferredPagePresentation[2](0));
    assert.equal(
        await page.evaluate(() => window.__mermaidRenders.length),
        0,
        'the stale Chat cannot decorate the newer target'
    );

    await page.evaluate(() => window.__deferredPagePresentation[3](0));
    await page.waitForFunction(() => window.__mermaidRenders.length === 1);
    assert.match(
        await page.evaluate(() => window.__mermaidRenders[0].source),
        /beta/,
        'only the current Chat schedules deferred decoration'
    );
    assert.deepEqual(
        (await postedMessages(page)).filter(message =>
            message.type === 'conversation-viewer-applied'
        ).map(message => message.requestId),
        [3],
        'only the fully presented current Chat is acknowledged'
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 requests a resync when deferred presentation fails', async t => {
    const page = await openViewerPage(t);
    await page.evaluate(() => {
        window.__deferredPagePresentation = [];
        window.requestAnimationFrame = callback => {
            window.__deferredPagePresentation.push(callback);
            return window.__deferredPagePresentation.length;
        };
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        subscriptionGeneration: 2,
        html: '<article data-message-id="deferred-message" '
            + 'data-interaction-id="deferred-input">'
            + '<button class="conversation-message-copy"></button>'
            + '<p>deferred</p></article>',
        htmlSignature: 'signature-deferred-presentation',
        outline: [{
            interactionId: 'deferred-input',
            userPreview: 'deferred',
            responseState: 'complete',
        }],
        selectedInteractionId: 'deferred-input',
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId: 'session-deferred',
            interactionId: 'deferred-input',
            displayName: 'deferred',
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });
    await page.evaluate(() => {
        const createElementNS = document.createElementNS.bind(document);
        document.createElementNS = function (namespace, name) {
            if (name === 'svg') {
                throw new Error('deferred decoration failure');
            }
            return createElementNS(namespace, name);
        };
    });

    await page.evaluate(() => window.__deferredPagePresentation[0](0));
    await page.evaluate(() => window.__deferredPagePresentation[1](0));
    await page.waitForFunction(() => window.__postedMessages.some(message =>
        message.type === 'conversation-viewer-request-sync'
    ));

    const messages = await postedMessages(page);
    assert.equal(messages.some(message =>
        message.type === 'conversation-viewer-applied'
        && message.requestId === 2
    ), false, 'a failed decoration must not acknowledge the page');
    assert.deepEqual(messages.find(message =>
        message.type === 'conversation-viewer-request-sync'
    ), {
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 2,
        requestId: 2,
        htmlSignature: 'signature-deferred-presentation',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-deferred',
        applyError: 'deferred decoration failure',
    });
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 acknowledges a hidden retained Viewer without waiting for animation frames', async t => {
    const page = await openViewerPage(t);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
        });
        window.__deferredFrameCalls = 0;
        window.requestAnimationFrame = () => {
            window.__deferredFrameCalls += 1;
            throw new Error('hidden Viewer must not wait for a frame');
        };
    });
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        subscriptionGeneration: 2,
        html: '<article data-message-id="hidden-message" '
            + 'data-interaction-id="hidden-input"><p>hidden</p></article>',
        htmlSignature: 'signature-hidden-presentation',
        outline: [{
            interactionId: 'hidden-input',
            userPreview: 'hidden',
            responseState: 'complete',
        }],
        selectedInteractionId: 'hidden-input',
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId: 'session-hidden',
            interactionId: 'hidden-input',
            displayName: 'hidden',
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    const result = await page.evaluate(() => ({
        frameCalls: window.__deferredFrameCalls,
        applied: window.__postedMessages.filter(message =>
            message.type === 'conversation-viewer-applied'
        ).map(message => message.requestId),
    }));
    assert.deepEqual(result, {
        frameCalls: 0,
        applied: [2],
    });
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 requests a resync when a restoreFrame page has no cached frame', async t => {
    const page = await openViewerPage(t);
    const sessionPage = (generation, sessionId, marker, signature) => ({
        ...hostileConversationPage,
        requestId: generation * 10,
        subscriptionGeneration: generation,
        html: `<article data-message-id="${marker}-0" `
            + `data-interaction-id="${marker}-input"><p>${marker}</p></article>`,
        htmlSignature: signature,
        outline: [{
            interactionId: `${marker}-input`,
            userPreview: marker,
            responseState: 'complete',
        }],
        selectedInteractionId: `${marker}-input`,
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
            interactionId: `${marker}-input`,
            displayName: `${marker} session`,
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    await sendPage(page, sessionPage(2, 'session-alpha', 'alpha', 'sig-a1'));

    // The Host asks for a frame the Webview never cached: full resync.
    const restorePage = sessionPage(3, 'session-gamma', 'gamma', 'sig-g1');
    delete restorePage.html;
    restorePage.restoreFrame = true;
    await sendPage(page, restorePage);

    const syncs = (await postedMessages(page)).filter(message =>
        message.type === 'conversation-viewer-request-sync'
    );
    assert.deepEqual(syncs, [{
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 3,
        requestId: 30,
        htmlSignature: 'sig-g1',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-gamma',
    }]);
    // The previous session stays on screen until the full page arrives.
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'alpha'
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 resynchronizes every generation across rapid session switches', async t => {
    const page = await openViewerPage(t);
    const sessionPage = (generation, sessionId, marker, signature) => ({
        ...hostileConversationPage,
        requestId: generation * 10,
        subscriptionGeneration: generation,
        html: `<article data-message-id="${marker}-0" `
            + `data-interaction-id="${marker}-input"><p>${marker}</p></article>`,
        htmlSignature: signature,
        outline: [{
            interactionId: `${marker}-input`,
            userPreview: marker,
            responseState: 'complete',
        }],
        selectedInteractionId: `${marker}-input`,
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
            interactionId: `${marker}-input`,
            displayName: `${marker} session`,
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });

    await sendPage(page, sessionPage(2, 'session-alpha', 'alpha', 'sig-a1'));

    // A restoreFrame miss for beta requests a resync correlated to beta's
    // generation and session.
    const betaRestore = sessionPage(3, 'session-beta', 'beta', 'sig-b1');
    delete betaRestore.html;
    betaRestore.restoreFrame = true;
    await sendPage(page, betaRestore);

    // A second rapid switch misses again: the resync gate is per
    // publication, so gamma gets its own correlated request instead of
    // staying stranded on alpha's content forever.
    const gammaRestore = sessionPage(4, 'session-gamma', 'gamma', 'sig-g1');
    delete gammaRestore.html;
    gammaRestore.restoreFrame = true;
    await sendPage(page, gammaRestore);

    const syncs = (await postedMessages(page)).filter(message =>
        message.type === 'conversation-viewer-request-sync'
    );
    assert.deepEqual(syncs, [{
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 3,
        requestId: 30,
        htmlSignature: 'sig-b1',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-beta',
    }, {
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 4,
        requestId: 40,
        htmlSignature: 'sig-g1',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-gamma',
    }]);
    // The stranded outgoing session stays on screen throughout.
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'alpha'
    );

    // The Host answers the gamma resync with the full publication: the
    // final DOM must be gamma, never the stranded alpha content.
    await sendPage(page, {
        ...sessionPage(4, 'session-gamma', 'gamma', 'sig-g1'),
        requestId: 41,
    });
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'gamma'
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 shows a lightweight loading state while a reused panel switches sessions', async t => {
    const page = await openViewerPage(t);
    const sessionPage = (generation, sessionId, marker, signature) => ({
        ...hostileConversationPage,
        requestId: generation * 10,
        subscriptionGeneration: generation,
        html: `<article data-message-id="${marker}-0" `
            + `data-interaction-id="${marker}-input"><p>${marker}</p></article>`,
        htmlSignature: signature,
        outline: [{
            interactionId: `${marker}-input`,
            userPreview: marker,
            responseState: 'complete',
        }],
        selectedInteractionId: `${marker}-input`,
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
            interactionId: `${marker}-input`,
            displayName: `${marker} session`,
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });
    const loadingNotice = (generation, sessionId) => ({
        type: 'conversation-viewer-loading',
        version: 1,
        subscriptionGeneration: generation,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId,
        },
    });
    const loadingState = () => page.evaluate(() => ({
        status: document.querySelector('[data-conversation-status]')
            .textContent,
        loading: document.body.getAttribute('data-conversation-loading'),
        busy: document.querySelector('[data-conversation-messages]')
            .getAttribute('aria-busy'),
        content: document.querySelector('[data-conversation-messages]')
            .textContent.trim(),
    }));

    await sendPage(page, sessionPage(2, 'session-alpha', 'alpha', 'sig-a1'));

    // The Host reuses the panel for a different session: the outgoing
    // content stays visible under a lightweight loading state until the
    // incoming session's first publication lands.
    await sendPage(page, loadingNotice(3, 'session-beta'));
    assert.deepEqual(await loadingState(), {
        status: 'Loading conversation…',
        loading: 'true',
        busy: 'true',
        content: 'alpha',
    });

    // Stale notices for an already-applied generation never clear or
    // re-arm the state; malformed ones are consumed without throwing.
    await sendPage(page, loadingNotice(2, 'session-alpha'));
    await sendPage(page, {
        type: 'conversation-viewer-loading',
        version: 1,
        subscriptionGeneration: 'next',
    });
    assert.deepEqual(await loadingState(), {
        status: 'Loading conversation…',
        loading: 'true',
        busy: 'true',
        content: 'alpha',
    });

    // The incoming session's first publication clears the loading state.
    await sendPage(page, sessionPage(3, 'session-beta', 'beta', 'sig-b1'));
    assert.deepEqual(await loadingState(), {
        status: '',
        loading: null,
        busy: null,
        content: 'beta',
    });
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 correlates resyncs to each page that fails', async t => {
    const page = await openViewerPage(t);
    await page.evaluate(() => {
        window.DOMPurify.sanitize = function () {
            throw new Error('sanitize unavailable');
        };
    });
    const failingPage = requestId => ({
        ...hostileConversationPage,
        requestId,
        html: '<article data-message-id="resync-0" '
            + 'data-interaction-id="input-1"><p>Resync</p></article>',
        htmlSignature: `sig-resync-${requestId}`,
        outline: [{
            interactionId: 'input-1',
            userPreview: 'Input 1',
            responseState: 'complete',
        }],
        selectedInteractionId: 'input-1',
        selectedInput: 1,
        totalInputs: 1,
        previousCursor: undefined,
        nextCursor: undefined,
    });

    await sendPage(page, failingPage(1));
    await sendPage(page, failingPage(2));

    const syncs = (await postedMessages(page)).filter(message =>
        message.type === 'conversation-viewer-request-sync'
    );
    assert.equal(syncs.length, 2,
        'each failed publication requests its own precisely correlated resync');
    assert.deepEqual(syncs, [{
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 1,
        requestId: 1,
        htmlSignature: 'sig-resync-1',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-telemetry',
        applyError: 'sanitize unavailable',
    }, {
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 1,
        requestId: 2,
        htmlSignature: 'sig-resync-2',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-telemetry',
        applyError: 'sanitize unavailable',
    }]);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 mermaid releaseExcept keeps figures under excepted nodes alive', async t => {
    const page = await openViewerPage(t, { controlledMermaid: true });
    await page.evaluate(() => {
        window.__revokedUrls = [];
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = url => {
            window.__revokedUrls.push(url);
            return revoke(url);
        };
        const messages = document.querySelector('[data-conversation-messages]');
        messages.innerHTML = '<article data-message-id="mm-a">'
            + '<section class="conversation-markdown"><pre><code '
            + 'class="language-mermaid">flowchart TB; A--&gt;B</code></pre>'
            + '</section></article>'
            + '<article data-message-id="mm-b">'
            + '<section class="conversation-markdown"><pre><code '
            + 'class="language-mermaid">flowchart TB; C--&gt;D</code></pre>'
            + '</section></article>';
        window.__mermaidController = window.__agentPivotConversation.mermaid
            .create({
                source: null,
                nonce: null,
                messages,
                scroll: document.querySelector('[data-conversation-scroll]'),
                maxDiagrams: 40,
                captureAnchor: () => null,
                restoreAnchor: () => undefined,
            });
        window.__mermaidController.render(1);
    });
    await page.waitForFunction(
        () => window.__mermaidRenders.length === 1,
        undefined,
        { timeout: 3_000 }
    );
    // Diagrams render sequentially: resolve each to unblock the next.
    await page.evaluate(() => {
        window.__mermaidRenders[0].resolve({
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>0</text></svg>',
        });
    });
    await page.waitForFunction(
        () => window.__mermaidRenders.length === 2,
        undefined,
        { timeout: 3_000 }
    );
    await page.evaluate(() => {
        window.__mermaidRenders[1].resolve({
            svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text>1</text></svg>',
        });
    });
    await page.waitForFunction(
        () => document.querySelectorAll('.conversation-mermaid-image')
            .length === 2,
        undefined,
        { timeout: 3_000 }
    );

    const outcome = await page.evaluate(() => {
        const images = Array.prototype.map.call(
            document.querySelectorAll('.conversation-mermaid-image'),
            image => image.src
        );
        const articleB = document.querySelector('[data-message-id="mm-b"]');
        // Detach B the way a stashed conversation frame would, then run a
        // global release that spares the stash.
        const stash = document.createElement('div');
        stash.appendChild(articleB);
        window.__mermaidController.releaseExcept([articleB]);
        const revokedByExcept = window.__revokedUrls.slice();
        window.__mermaidController.release(articleB);
        return {
            images,
            revokedByExcept,
            revokedTotal: window.__revokedUrls.slice(),
        };
    });

    assert.deepEqual(outcome.revokedByExcept, [outcome.images[0]],
        'only the figure outside the excepted stash is revoked');
    assert.deepEqual(outcome.revokedTotal, [
        outcome.images[0],
        outcome.images[1],
    ], 'evicting the stashed frame revokes its figure URL');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 frame restore follows a fresh navigation target instead of the stashed scroll position', async t => {
    const page = await openViewerPage(t);
    await page.addStyleTag({
        content: '.tall-block { height: 120px; margin: 0; }',
    });
    const article = index => `<article data-message-id="alpha-${index}" `
        + `data-interaction-id="alpha-input-${index}">`
        + '<section class="conversation-markdown">'
        + `<p class="tall-block">alpha block ${index}</p>`
        + '</section></article>';
    const sessionPage = (generation, sessionId, marker, signature, options = {}) => {
        const message = {
            ...hostileConversationPage,
            requestId: generation * 10,
            subscriptionGeneration: generation,
            updateKind: 'initial',
            html: `${article(0)}${article(1)}${article(2)}${article(3)}`,
            htmlSignature: signature,
            outline: [0, 1, 2, 3].map(index => ({
                interactionId: `${marker}-input-${index}`,
                userPreview: `${marker} ${index}`,
                responseState: 'complete',
            })),
            selectedInteractionId: options.selectedInteractionId
                || `${marker}-input-0`,
            selectedInput: 1,
            totalInputs: 4,
            previousCursor: undefined,
            nextCursor: undefined,
            target: {
                projectId: 'project-1',
                provider: 'codex',
                sessionId,
                interactionId: `${marker}-input-0`,
                displayName: `${marker} session`,
            },
            comments: { revision: 0, comments: [] },
            projectComments: { revision: 0, comments: [] },
            bookmarks: { revision: 0, interactionIds: [] },
        };
        if (options.restoreFrame) {
            delete message.html;
            message.restoreFrame = true;
        }
        return message;
    };

    // Session alpha stays at the top (scrollTop 0) with input-0 selected.
    await sendPage(page, sessionPage(2, 'session-alpha', 'alpha', 'sig-a1'));
    await page.evaluate(() => {
        document.querySelector('[data-conversation-scroll]').scrollTop = 0;
    });
    await sendPage(page, sessionPage(3, 'session-beta', 'beta', 'sig-b1'));

    // Returning with a new selected interaction must center that target,
    // not resurrect the stashed top-of-conversation scroll position.
    await sendPage(page, sessionPage(4, 'session-alpha', 'alpha', 'sig-a1', {
        restoreFrame: true,
        selectedInteractionId: 'alpha-input-3',
    }));

    const outcome = await page.evaluate(() => {
        const scroll = document.querySelector('[data-conversation-scroll]');
        const target = document.querySelector('[data-message-id="alpha-3"]');
        const targetBounds = target.getBoundingClientRect();
        const scrollBounds = scroll.getBoundingClientRect();
        return {
            scrollTop: scroll.scrollTop,
            targetVisible: targetBounds.bottom > scrollBounds.top
                && targetBounds.top < scrollBounds.bottom,
        };
    });
    assert.equal(outcome.targetVisible, true,
        'the freshly navigated interaction must be centered into view');
    assert.ok(outcome.scrollTop > 40,
        `the stashed scrollTop 0 must not win, got ${outcome.scrollTop}`);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 evicts the oldest frame beyond the cache budget and resyncs its restore', async t => {
    const page = await openViewerPage(t);
    const sessionPage = (generation, sessionId, marker, signature, options = {}) => {
        const message = {
            ...hostileConversationPage,
            requestId: generation * 10,
            subscriptionGeneration: generation,
            updateKind: 'initial',
            html: `<article data-message-id="${marker}-0" `
                + `data-interaction-id="${marker}-input"><p>${marker}</p></article>`,
            htmlSignature: signature,
            outline: [{
                interactionId: `${marker}-input`,
                userPreview: marker,
                responseState: 'complete',
            }],
            selectedInteractionId: `${marker}-input`,
            selectedInput: 1,
            totalInputs: 1,
            previousCursor: undefined,
            nextCursor: undefined,
            target: {
                projectId: 'project-1',
                provider: 'codex',
                sessionId,
                interactionId: `${marker}-input`,
                displayName: marker,
            },
            comments: { revision: 0, comments: [] },
            projectComments: { revision: 0, comments: [] },
            bookmarks: { revision: 0, interactionIds: [] },
        };
        if (options.restoreFrame) {
            delete message.html;
            message.restoreFrame = true;
        }
        return message;
    };

    // Six sessions through a four-frame cache: alpha and beta are evicted.
    const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
    for (let index = 0; index < ids.length; index += 1) {
        await sendPage(page, sessionPage(
            index + 2, `session-${ids[index]}`, ids[index], `sig-${ids[index]}`
        ));
    }
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'zeta'
    );

    // A restoreFrame offer for an evicted frame is answered with a resync.
    await sendPage(page, sessionPage(
        20, 'session-alpha', 'alpha', 'sig-alpha', { restoreFrame: true }
    ));
    const syncs = (await postedMessages(page)).filter(message =>
        message.type === 'conversation-viewer-request-sync'
    );
    assert.deepEqual(syncs, [{
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: 20,
        requestId: 200,
        htmlSignature: 'sig-alpha',
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-alpha',
    }]);
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'zeta',
        'the live session stays on screen until the resynced full page'
    );

    // A non-evicted recent session still restores its frame: zeta was
    // stashed during the switch that brought the alpha offer, so even its
    // full-HTML page is answered by a frame restore.
    await sendPage(page, sessionPage(21, 'session-zeta', 'zeta', 'sig-zeta'));
    assert.equal(
        (await postedMessages(page)).filter(message =>
            message.type === 'conversation-viewer-request-sync'
        ).length,
        1,
        'no second resync for a cached frame'
    );
    assert.equal(
        await page.locator('[data-conversation-messages]').innerText(),
        'zeta'
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
        await page.locator('[data-telemetry-provider]')
            .getAttribute('data-tooltip'),
        'Provider · Codex'
    );
    assert.equal(
        await page.locator('[data-telemetry-provider]').getAttribute('title'),
        null,
        'the CSS tooltip is the only pointer popup'
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
        await page.locator('[data-telemetry-context]')
            .getAttribute('data-tooltip'),
        /Context window · 25% used.*32\.0k \/ 128k tokens/s
    );
    assert.match(
        await page.locator('[data-telemetry-limit]')
            .getAttribute('data-tooltip'),
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
    options.onPanel?.(panel);
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
        readSessionStatus: options.readSessionStatus,
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
        ...(options.workspaceName !== undefined
            ? { workspaceName: options.workspaceName }
            : {}),
        ...(options.taskName !== undefined
            ? { taskName: options.taskName }
            : {}),
    });
    return panel.webview.html;
}

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 publishes content before local metadata restoration settles', async () => {
    let panel;
    let releaseCommentRestore;
    const commentRestore = new Promise(resolve => {
        releaseCommentRestore = resolve;
    });
    const opening = renderHostViewerDocument({
        onPanel: value => { panel = value; },
        commentStore: {
            load: async () => commentRestore,
            save: async () => {},
        },
        projectCommentStore: {
            load: async () => ({ revision: 0, comments: [] }),
            save: async () => {},
        },
        bookmarkStore: {
            load: async () => ({ revision: 0, interactionIds: [] }),
            save: async () => {},
        },
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.ok(panel, 'the Viewer panel is created immediately');
    const publication = decodeInitialPublication(panel.webview.html);
    assert.match(publication.html, /safe/,
        'slow optional metadata cannot delay readable conversation content');
    assert.equal(await Promise.race([
        opening.then(() => true),
        new Promise(resolve => setImmediate(() => resolve(false))),
    ]), true, 'the Host load settles before auxiliary restoration');
    releaseCommentRestore({ revision: 0, comments: [] });
});

async function openHostViewerDocument(t, options = {}) {
    const page = await browser.newPage({
        viewport: options.viewport || { width: 700, height: 500 },
    });
    t.after(() => page.close());
    const renderedHtml = options.renderedHtml
        || await renderHostViewerDocument(options);
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
        if (pathname === '/conversationRegistryScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: conversationRegistryScript,
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
                body: options.commentsScriptSource
                    || conversationCommentsScript,
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
        if (pathname === '/conversationChangesScripts.js') {
            await route.fulfill({
                contentType: 'text/javascript',
                body: options.changesScriptSource
                    || conversationChangesScript,
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

test('CONVERSATION-VIEWER-HEADER-001 renders the identity line as project · task · session and posts a rename intent on click', async t => {
    const { page } = await openHostViewerDocument(t, {
        workspaceName: 'Agent Pivot',
        taskName: 'fix-login',
    });
    assert.equal(
        await page.locator('[data-conversation-workspace-name]').innerText(),
        'Agent Pivot'
    );
    assert.equal(
        await page.locator('[data-conversation-task-name]').innerText(),
        'fix-login',
        'the task segment renders between the project and session names'
    );
    assert.equal(
        await page.locator('[data-conversation-task-separator]').isHidden(),
        false
    );
    const sessionName = page.locator('[data-conversation-display-name]');
    assert.equal(await sessionName.innerText(), 'Host document');

    await sessionName.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-rename-session',
        version: 1,
    }, 'clicking the session name asks the Host to rename the session');
});

test('CONVERSATION-VIEWER-HEADER-001 hides the task segment for group-less sessions', async t => {
    const { page } = await openHostViewerDocument(t, {
        workspaceName: 'Agent Pivot',
    });
    assert.equal(
        await page.locator('[data-conversation-task-name]').isHidden(),
        true
    );
    assert.equal(
        await page.locator('[data-conversation-task-separator]').isHidden(),
        true
    );
});

test('CONVERSATION-VIEWER-HEADER-001 applies task name updates from authoritative pages', async t => {
    const page = await openViewerPage(t);
    const target = {
        projectId: 'project-1',
        provider: 'codex',
        sessionId: 'session-telemetry',
        interactionId: 'input-4',
        displayName: 'Original session',
        workspaceName: 'Test Workspace',
    };
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 2,
        target: { ...target, taskName: 'fix-login' },
    });
    assert.equal(
        await page.locator('[data-conversation-task-name]').innerText(),
        'fix-login'
    );
    assert.equal(
        await page.locator('[data-conversation-task-name]').isHidden(),
        false
    );
    assert.equal(
        await page.locator('[data-conversation-task-separator]').isHidden(),
        false
    );

    // A later page without a group hides the segment again (e.g. the
    // session's worktree left its task group).
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 3,
        target,
    });
    assert.equal(
        await page.locator('[data-conversation-task-name]').isHidden(),
        true
    );
    assert.equal(
        await page.locator('[data-conversation-task-separator]').isHidden(),
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

    assert.deepEqual(await postedIntents(page), [
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
    await page.locator('[data-telemetry-subagents]').click();
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
    // The subagents view is restored from saved state — clicking the pill
    // again would toggle the panel closed (the pills are the switchers now).
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
    assert.match(await counter.getAttribute('data-tooltip'), /1 running of 2/);
    assert.equal(
        await rebuilt.page.locator('[data-conversation-telemetry]').isVisible(),
        true,
        'the counter must reveal the telemetry bar even without usage data'
    );
    await rebuilt.page.locator('[data-action="toggle-sidebar"]').click();
    await counter.click();
    assert.equal(
        await rebuilt.page.locator('[data-telemetry-subagents]')
            .getAttribute('aria-pressed'),
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
    await rebuilt.page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));
    // The pill doubles as the Subagents quick entry and stays visible at
    // zero instead of disappearing.
    assert.equal(await counter.isVisible(), true);
    assert.equal(await counter.innerText(), '0/0');
});
test('CONVERSATION-TELEMETRY-TOGGLE-001 telemetry subagents pill toggles the sidebar panel open and closed', async t => {
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
    }];
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 50,
        updateKind: 'initial',
        html: messageHtml('main-session-message', 2),
        subagents,
        activeSubagent: null,
    });

    const sidebar = page.locator('[data-conversation-sidebar]');
    const telemetrySubagents = page.locator('[data-telemetry-subagents]');
    const subagentsTab = page.locator('[data-telemetry-subagents]');

    // Sidebar starts closed
    assert.equal(await sidebar.isHidden(), true);

    // Click telemetry subagents pill → sidebar opens with subagents tab
    await telemetrySubagents.click();
    assert.equal(await sidebar.isVisible(), true);
    assert.equal(await subagentsTab.getAttribute('aria-pressed'), 'true');
    assert.equal(await telemetrySubagents.getAttribute('aria-pressed'), 'true');

    // Click same pill again → sidebar closes (toggle)
    await telemetrySubagents.click();
    assert.equal(await sidebar.isHidden(), true);
    assert.equal(await telemetrySubagents.getAttribute('aria-pressed'), 'false');

    // Click again → reopens, verifying the toggle is reversible
    await telemetrySubagents.click();
    assert.equal(await sidebar.isVisible(), true);
    assert.equal(await subagentsTab.getAttribute('aria-pressed'), 'true');
    assert.equal(await telemetrySubagents.getAttribute('aria-pressed'), 'true');
});


test('CONVERSATION-FOLLOW-FEEDBACK-001 shows a dismissible follow notice and clears it on the next page', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const banner = page.locator('[data-conversation-notice]');
    const bannerDisplay = () => banner.evaluate(
        element => getComputedStyle(element).display
    );

    assert.equal(
        await bannerDisplay(),
        'none',
        'the follow notice starts hidden'
    );

    await sendPage(page, {
        type: 'conversation-viewer-notice',
        text: 'This AI session has no conversation yet.',
    });
    assert.notEqual(
        await bannerDisplay(),
        'none',
        'a follow notice reveals the banner without replacing the page'
    );
    assert.equal(
        await page.locator('[data-conversation-notice-text]').innerText(),
        'This AI session has no conversation yet.'
    );
    assert.notEqual(
        await page.locator('[data-message-id]').count(),
        0,
        'the current conversation stays rendered below the banner'
    );

    // Malformed notices are dropped without touching the visible banner.
    await sendPage(page, { type: 'conversation-viewer-notice', text: 42 });
    await sendPage(page, { type: 'conversation-viewer-notice' });
    await sendPage(page, {
        type: 'conversation-viewer-notice',
        text: 'x'.repeat(2000),
    });
    assert.equal(
        await page.locator('[data-conversation-notice-text]').innerText(),
        'This AI session has no conversation yet.'
    );

    // The next applied page auto-clears the banner.
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 60,
        updateKind: 'refresh',
        html: messageHtml('after-notice', 2),
    });
    assert.equal(await bannerDisplay(), 'none');
    assert.equal(
        await page.locator('[data-message-id="after-notice-0"]').count(),
        1
    );

    // A later notice can be dismissed through the close button.
    await sendPage(page, {
        type: 'conversation-viewer-notice',
        text: 'Unable to read the AI session conversation. Click the session again to retry.',
    });
    assert.notEqual(await bannerDisplay(), 'none');
    await page.locator('[data-notice-close]').click();
    assert.equal(await bannerDisplay(), 'none');
    assert.deepEqual(
        (await postedIntents(page)).filter(
            message => message.type !== 'conversation-viewer-focus'
        ),
        [],
        'notice interactions never post messages back to the host'
    );
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
    assert.deepEqual(await postedIntents(page), initialFocus);

    await previous.evaluate(element => element.click());
    await next.evaluate(element => element.click());
    assert.deepEqual(await postedIntents(page), initialFocus);

    await latest.click();
    assert.deepEqual(await postedIntents(page), [
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
            widthUserResized: false,
            changesWidthRecommendationApplied: false,
            changesSubTab: 'files',
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

    // The telemetry pills are the view switchers (no sidebar tab row):
    // clicking the comments pill while the outline is open switches views.
    const outlinePill = page.locator('[data-conversation-position]');
    await outlinePill.focus();
    await page.locator('[data-telemetry-comments]').click();
    assert.equal(await outline.isHidden(), true);
    assert.equal(await comments.isVisible(), true);
    assert.equal(await sidebarToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await sidebar.isVisible(), true);
    assert.equal(
        await page.locator('[data-telemetry-comments]')
            .getAttribute('aria-pressed'),
        'true',
        'the active view\'s pill reads pressed'
    );
    assert.equal(
        await outlinePill.getAttribute('aria-pressed'),
        'false'
    );
    // Escape closes the panel only when focus is inside it.
    await page.locator('[data-conversation-comments] button').first().focus();
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
    await page.locator('[data-conversation-position]').click();
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
            headerHeight: searchRect.top - outlineRect.top,
            sortAlignedWithSearch:
                Math.abs(sortRect.top - searchRect.top) < 1,
            previewInset: previewRect.left - outlineRect.left,
            starInset: starRect.left - outlineRect.left,
            starOpacity: Number(getComputedStyle(star).opacity),
            selectedBackground: getComputedStyle(selectedItem).backgroundColor,
        };
    });
    assert.ok(
        outlineLayout.headerHeight <= 40,
        `the outline content should start near the panel top, got ${outlineLayout.headerHeight}px`
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
        await block.locator('[data-conversation-run-command]').count(),
        0,
        'only shell fences expose the direct Run action'
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
            unifiedSurface: getComputedStyle(header).backgroundColor
                === getComputedStyle(pre).backgroundColor
                && getComputedStyle(header).borderBottomWidth === '0px',
        };
    });
    assert.deepEqual(chrome, {
        headerAboveCode: true,
        labelInHeader: true,
        buttonInHeader: true,
        nothingOnCode: true,
        unifiedSurface: true,
    }, 'code chrome sits above the code on one unified card surface');
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

test('CONVERSATION-RUN-COMMAND-001 runs Bash blocks and selected Bash commands in the command terminal', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 900, height: 560 },
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: {
            messages: [{
                id: 'input-1:assistant:0',
                interactionId: 'input-1',
                role: 'assistant',
                markdown: 'Run this:\n\n```bash\nfind . -iname "*profile*"\n```',
            }],
        },
    });
    const command = 'find . -iname "*profile*"\n';
    const codeRun = page.locator('[data-conversation-run-command]');
    assert.equal(await codeRun.count(), 1);
    assert.equal(await codeRun.getAttribute('aria-label'), 'Run command');
    assert.equal(await codeRun.locator('svg').count(), 1);

    await codeRun.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-run-command',
        version: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        command,
    });

    const selectionBubble = page.locator('[data-add-comment]');
    const selectionRun = selectionBubble.locator(
        '[data-comment-selection-action="run"]'
    );

    await page.locator('.conversation-markdown p').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(20);
    assert.equal(await selectionRun.getAttribute('hidden'), '',
        'ordinary prose must keep the Run control hidden');

    await page.locator('.conversation-code-block pre code').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(20);
    assert.equal(await selectionBubble.isVisible(), true);
    assert.equal(await selectionRun.isVisible(), true);
    await selectionRun.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-run-command',
        version: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        command: command.trim(),
    });
});

test('CONVERSATION-RUN-COMMAND-001 keeps a long Unicode comment selection available but non-runnable', async t => {
    const emoji = '😀'.repeat(3000);
    const { page } = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageOverrides: {
            messages: [{
                id: 'input-1:assistant:0',
                interactionId: 'input-1',
                role: 'assistant',
                markdown: emoji,
            }],
        },
    });
    await page.locator('.conversation-markdown p').evaluate(element => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(20);
    const selectionBubble = page.locator('[data-add-comment]');
    const selectionRun = selectionBubble.locator(
        '[data-comment-selection-action="run"]'
    );
    assert.equal(await selectionBubble.getAttribute('hidden'), null);
    assert.equal(await selectionRun.getAttribute('hidden'), '',
        'the command UTF-16 bound does not hide comment actions');
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
        await page.locator('[data-telemetry-comments]').click();
        assert.equal(
            await page.locator('[data-conversation-comments]').isVisible(),
            true,
            `${label}: Comments should remain available`
        );
        await page.locator('[data-telemetry-subagents]').click();
        assert.equal(
            await page.locator('[data-conversation-subagents]').isVisible(),
            true,
            `${label}: Subagents should remain available`
        );
    }

    const previousViewerScript = viewerScript
        .replace(
            /\n    \/\/ Keep the first painted frame narrow:[\s\S]*?\n    }\n\n    function applyPage\(message\) \{/,
            '\n    function applyPage(message) {'
        )
        .replace(
            '        updatePosition(message);\n'
                + '        // This controller owns visible identity and actionable subagent IDs,\n'
                + '        // so it must agree with the transcript in the first painted frame.\n'
                + '        // The remaining sidebar decoration is safely deferrable below.\n'
                + '        if (subagentsController) {\n'
                + '            subagentsController.apply(\n'
                + '                message.subagents,\n'
                + '                message.activeSubagent\n'
                + '            );\n'
                + '        }\n',
            '        updatePosition(message);\n'
        )
        .replace(
            '            scheduleDeferredPagePresentation(\n'
                + '                message,\n'
                + '                renderGeneration,\n'
                + '                hasHtml || !!frame\n'
                + '            );\n'
                + '            return;',
            '            acknowledgePage(message);\n'
                + '            scheduleDeferredPagePresentation(\n'
                + '                message,\n'
                + '                renderGeneration,\n'
                + '                hasHtml || !!frame\n'
                + '            );\n'
                + '            return;'
        )
        .replace(
            '        scheduleDeferredPagePresentation(\n'
                + '            message,\n'
                + '            renderGeneration,\n'
                + '            hasHtml || !!frame\n'
                + '        );\n'
                + '    }\n\n'
                + '    function postNavigation(type) {',
            '        acknowledgePage(message);\n'
                + '        scheduleDeferredPagePresentation(\n'
                + '            message,\n'
                + '            renderGeneration,\n'
                + '            hasHtml || !!frame\n'
                + '        );\n'
                + '    }\n\n'
                + '    function postNavigation(type) {'
        )
        .replace(
            '            applyWorklogStates();\n'
                + '            state.messageIds = reconciled.ids;\n',
            '            applyWorklogStates();\n'
                + '            applyCopyButtonLabels();\n'
                + '            applyRunCommandButtonLabels();\n'
                + '            state.messageIds = reconciled.ids;\n'
        )
        .replace(
            '        saveRestoreTarget(nextRestoreTarget);\n'
                + '        hideFollowNotice();\n',
            '        saveRestoreTarget(nextRestoreTarget);\n'
                + '        outlineController.applyOutline(message);\n'
                + '        if (subagentsController) {\n'
                + '            subagentsController.apply(\n'
                + '                message.subagents,\n'
                + '                message.activeSubagent\n'
                + '            );\n'
                + '        }\n'
                + '        commentsController.updateHighlights();\n'
                + '        if (findController) findController.refresh();\n'
                + '        hideFollowNotice();\n'
        )
        .replace(
            /            scheduleDeferredPagePresentation\(\n                message,\n                renderGeneration,\n                hasHtml \|\| !!frame\n            \);\n/g,
            ''
        )
        .replace(
            '        if (!isLiveRefresh) {\n',
            '        renderMermaidDiagrams(renderGeneration);\n\n'
                + '        if (!isLiveRefresh) {\n'
        )
        .replace(
            '            reconcileController.trackEnd();\n'
                + '        }\n'
                + '        acknowledgePage(message);\n'
                + '    }\n\n'
                + '    function postNavigation(type) {\n',
            '            reconcileController.trackEnd();\n'
                + '        }\n'
                + '    }\n\n'
                + '    function postNavigation(type) {\n'
        )
        // Strips the changes-panel tooltip overlay wiring (PRD §17) and the
        // action-binding target: the previous-generation script passed
        // neither a panelRoot nor a target to the changes controller.
        .replace(
                '            post: post,\n' +
                '            target: commentTarget,\n' +
                '            panelRoot: changesRoot,\n' +
                '            telemetryChanges: telemetryChanges,\n',
                '            post: post,\n' +
                '            telemetryChanges: telemetryChanges,\n')
        .replace(
            '    var sessionCommentsTab = document.querySelector(\n'
                + "        '[data-comments-tab=\"session\"]'\n"
                + '    );\n'
                + '    var workspaceCommentsTab = document.querySelector(\n'
                + "        '[data-comments-tab=\"workspace\"]'\n"
                + '    );\n'
                + '    var sessionCommentsPane = document.querySelector(\n'
                + "        '[data-comments-panel=\"session\"]'\n"
                + '    );\n'
                + '    var workspaceCommentsPane = document.querySelector(\n'
                + "        '[data-comments-panel=\"workspace\"]'\n"
                + '    );\n',
            ''
        )
        .replace(
            '        && (!!sessionCommentsTab && !!sessionCommentsPane\n'
                + '            || !!commentsSectionSash && !!sessionCommentsCount)\n',
            '        && !!commentsSectionSash && !!sessionCommentsCount\n'
        )
        .replace(
            '        && (!!workspaceCommentsTab && !!workspaceCommentsPane\n'
                + '            || !!projectCommentsCount)\n',
            '        && !!projectCommentsCount\n'
        )
        .replace(
            '        commentsSectionSash: commentsSectionSash,\n'
                + '        projectCommentsCount: projectCommentsCount,\n'
                + '        sessionCommentsCount: sessionCommentsCount,\n'
                + '        sessionCommentsTab: sessionCommentsTab,\n'
                + '        workspaceCommentsTab: workspaceCommentsTab,\n'
                + '        sessionCommentsPane: sessionCommentsPane,\n'
                + '        workspaceCommentsPane: workspaceCommentsPane,\n',
            '        commentsSectionSash: commentsSectionSash,\n'
                + '        projectCommentsCount: projectCommentsCount,\n'
                + '        sessionCommentsCount: sessionCommentsCount,\n'
        )
        .replace(
            '        setSidebarView: sidebarController.setView,\n',
            '        setSidebarView: sidebarController.setView,\n'
                + '        updateToggle: sidebarController.updateToggle,\n'
        )
        .replace(
                '        && !!window.__agentPivotConversation.changes\n' +
                '        && validCommentTarget(commentTarget);\n',
                '        && !!window.__agentPivotConversation.changes;\n')
        // Restores the previous fold-action pair: the merged fold toggle
        // (single button with refresh/SCM moved into row 3) did not exist.
        .replace(
                '    var changesFoldToggle = document.querySelector(\n' +
                '        \'[data-changes-fold-toggle]\'\n' +
                '    );\n',
                '    var changesCollapseAll = document.querySelector(\n' +
                '        \'[data-changes-collapse-all]\'\n' +
                '    );\n' +
                '    var changesExpandAll = document.querySelector(\n' +
                '        \'[data-changes-expand-all]\'\n' +
                '    );\n')
        .replace(
                '        && !!changesFoldToggle\n',
                '        && !!changesCollapseAll && !!changesExpandAll\n')
        .replace(
                '            foldToggle: changesFoldToggle,\n',
                '            collapseAllButton: changesCollapseAll,\n' +
                '            expandAllButton: changesExpandAll,\n')
        // Strips the branch divergence display wiring: the previous
        // generation only rendered the branch name in its second row.
        .replace(
                '    var changesBranchDivergence = document.querySelector(\n' +
                "        '[data-changes-branch-divergence]'\n" +
                '    );\n',
                '')
        .replace(
                '            branchDivergence: changesBranchDivergence,\n',
                '')
        // Restores the task-summary wiring removed from the current panel.
        // The adjacent Viewer fixture predates that compaction and must stay
        // byte-identical to its checked-in historical generation.
        .replace(
                '    var changesCrossMemberGo = document.querySelector(\n' +
                "        '[data-changes-cross-member-go]'\n" +
                '    );\n' +
                "    var changesReview = document.querySelector('[data-changes-review]');\n",
                '    var changesCrossMemberGo = document.querySelector(\n' +
                "        '[data-changes-cross-member-go]'\n" +
                '    );\n' +
                "    var changesTask = document.querySelector('[data-changes-task]');\n" +
                '    var changesTaskSummary = document.querySelector(\n' +
                "        '[data-changes-task-summary]'\n" +
                '    );\n' +
                '    var changesTaskTracking = document.querySelector(\n' +
                "        '[data-changes-task-tracking]'\n" +
                '    );\n' +
                "    var changesReview = document.querySelector('[data-changes-review]');\n")
        .replace(
                '        && !!changesBranchPrefix && !!changesBranchTail && !!changesLive\n' +
                '        && !!changesReview\n',
                '        && !!changesBranchPrefix && !!changesBranchTail && !!changesLive\n' +
                '        && !!changesTask && !!changesTaskSummary && !!changesTaskTracking\n' +
                '        && !!changesReview\n')
        .replace(
                '            crossMemberGo: changesCrossMemberGo,\n' +
                '            reviewButton: changesReview,\n',
                '            crossMemberGo: changesCrossMemberGo,\n' +
                '            taskRoot: changesTask,\n' +
                '            taskSummary: changesTaskSummary,\n' +
                '            taskTracking: changesTaskTracking,\n' +
                '            reviewButton: changesReview,\n')
        // Strips the Commits sub-tab wiring (PRD §15.4): the
        // previous-generation script had no sub-tab handles, no commits
        // options, and no restoreSubTab call.
        .replace(
                '    var changesSubtabs = document.querySelector(\'[data-changes-subtabs]\');\n' +
                '    var changesFilesView = document.querySelector(\n' +
                '        \'[data-changes-files-view]\'\n' +
                '    );\n' +
                '    var changesCommitsView = document.querySelector(\n' +
                '        \'[data-changes-commits-view]\'\n' +
                '    );\n' +
                '    var changesCommitsNotice = document.querySelector(\n' +
                '        \'[data-changes-commits-notice]\'\n' +
                '    );\n' +
                '    var changesCommitsList = document.querySelector(\n' +
                '        \'[data-changes-commits-list]\'\n' +
                '    );\n' +
                '    var changesCommitsEmpty = document.querySelector(\n' +
                '        \'[data-changes-commits-empty]\'\n' +
                '    );\n' +
                '    var changesCommitsLoading = document.querySelector(\n' +
                '        \'[data-changes-commits-loading]\'\n' +
                '    );\n' +
                '    var changesCommitsError = document.querySelector(\n' +
                '        \'[data-changes-commits-error]\'\n' +
                '    );\n' +
                '    var changesCommitsRetry = document.querySelector(\n' +
                '        \'[data-changes-commits-retry]\'\n' +
                '    );\n' +
                '    var changesCommitsMore = document.querySelector(\n' +
                '        \'[data-changes-commits-more]\'\n' +
                '    );\n' +
                '    var changesCommitsFull = document.querySelector(\n' +
                '        \'[data-changes-commits-full]\'\n' +
                '    );\n',
                '')
        .replace(
                '        && !!changesSubtabs && !!changesFilesView && !!changesCommitsView\n' +
                '        && !!changesCommitsNotice && !!changesCommitsList\n' +
                '        && !!changesCommitsEmpty && !!changesCommitsLoading\n' +
                '        && !!changesCommitsError && !!changesCommitsRetry\n' +
                '        && !!changesCommitsMore && !!changesCommitsFull\n',
                '')
        .replace(
                '            subtabs: changesSubtabs,\n' +
                '            filesView: changesFilesView,\n' +
                '            commitsView: changesCommitsView,\n' +
                '            commitsNotice: changesCommitsNotice,\n' +
                '            commitsList: changesCommitsList,\n' +
                '            commitsEmpty: changesCommitsEmpty,\n' +
                '            commitsLoading: changesCommitsLoading,\n' +
                '            commitsError: changesCommitsError,\n' +
                '            commitsRetry: changesCommitsRetry,\n' +
                '            commitsMore: changesCommitsMore,\n' +
                '            commitsFull: changesCommitsFull,\n' +
                '            getChangesSubTab: sidebarController.getChangesSubTab,\n' +
                '            setChangesSubTab: sidebarController.setChangesSubTab,\n',
                '')
        .replace(
                '        if (changesController) {\n' +
                '            changesController.restoreSubTab();\n' +
                '        }\n',
                '')
        .replace(
                '        if (changesController) {\n' +
                '            changesController.resetSession(\n' +
                '                message.subscriptionGeneration,\n' +
                '                nextCommentTarget\n' +
                '            );\n',
                '        if (changesController) {\n' +
                '            changesController.resetSession(' +
                'message.subscriptionGeneration);\n')
        .replace(
            '    var copyRequestSequence = 0;\n' +
                '    var copyPending = new Map();\n' +
                '    // One resync request per failed publication. Later publications in the\n' +
                '    // same session remain independently recoverable.\n' +
                '    var resyncRequestedPublicationKey = \'\';\n' +
                '    var conversationLoading = false;\n' +
                '    // Detached conversation frames keyed by session: switching back to a\n' +
                '    // session whose content token is unchanged reattaches the already-built\n' +
                '    // DOM — no HTML transfer, sanitize, parse, or reconcile at all. Bounded\n' +
                '    // by both frame count and a total node budget so large conversations\n' +
                '    // cannot balloon Webview memory.\n' +
                '    var frameCache = new Map();\n' +
                '    var frameCacheNodes = 0;\n' +
                '    var FRAME_CACHE_LIMIT = 4;\n' +
                '    var FRAME_CACHE_NODE_BUDGET = 600;\n' +
                '    var state = {\n' +
                '        atLatest: false,\n' +
                '        initialized: false,\n',
                '    var copyRequestSequence = 0;\n' +
                '    var copyPending = new Map();\n' +
                '    var resyncRequested = false;\n' +
                '    // Recently sanitized pages keyed by session, so switching back to a\n' +
                '    // session whose content is unchanged (same htmlSignature) skips the\n' +
                '    // multi-megabyte DOMPurify pass entirely.\n' +
                '    var sanitizedPageCache = new Map();\n' +
                '    var sanitizedPageCacheBytes = 0;\n' +
                '    var SANITIZED_PAGE_CACHE_LIMIT = 16 * 1024 * 1024;\n' +
                '    var state = {\n' +
                '        atLatest: false,\n' +
                '        initialized: false,\n')
        .replace(
            "            'html', 'htmlSignature', 'restoreFrame', 'restoreFocus', 'previousCursor',\n",
            "            'html', 'htmlSignature', 'restoreFrame', 'previousCursor',\n"
        )
        .replace(
            '            && (message.restoreFrame === undefined\n'
                + "                || typeof message.restoreFrame === 'boolean')\n"
                + '            && (message.restoreFocus === undefined\n'
                + "                || typeof message.restoreFocus === 'boolean')\n",
            '            && (message.restoreFrame === undefined\n'
                + "                || typeof message.restoreFrame === 'boolean')\n"
        )
        .replace(
            "            if (selected && (message.updateKind === 'navigation'\n"
                + '                || message.restoreFocus === true)) {\n',
            "            if (selected && message.updateKind === 'navigation') {\n"
        )
        .replace(
                '        messages: messages,\n' +
                '        messageSelector: conversationMessageSelector,\n' +
                '        messageId: conversationMessageId,\n' +
                '        releaseMermaid: function (root) {\n' +
                '            if (root) {\n' +
                '                mermaidRenderer.release(root);\n' +
                '                return;\n' +
                '            }\n' +
                '            // A global release must spare stashed frames: their figures are\n' +
                '            // detached but alive and reattach on restore.\n' +
                '            var stashed = [];\n' +
                '            frameCache.forEach(function (frame) {\n' +
                '                stashed.push.apply(stashed, frame.nodes);\n' +
                '            });\n' +
                '            mermaidRenderer.releaseExcept(stashed);\n' +
                '        },\n' +
                '        preserveMermaid: preserveMermaidContent,\n' +
                '    });\n' +
                '    var outlineController;\n',
                '        messages: messages,\n' +
                '        messageSelector: conversationMessageSelector,\n' +
                '        messageId: conversationMessageId,\n' +
                '        releaseMermaid: releaseMermaidObjectUrls,\n' +
                '        preserveMermaid: preserveMermaidContent,\n' +
                '    });\n' +
                '    var outlineController;\n')
        .replace(
                '            \'totalInputs\', \'partial\', \'atLatest\', \'stale\',\n' +
                '        ];\n' +
                '        var allowedKeys = new Set(requiredKeys.concat([\n' +
                '            \'html\', \'htmlSignature\', \'restoreFrame\', \'previousCursor\',\n' +
                '            \'nextCursor\', \'subagents\', \'activeSubagent\', \'displayName\',\n' +
                '            \'target\', \'comments\', \'projectComments\', \'bookmarks\',\n' +
                '        ]));\n' +
                '        if (Object.keys(message).some(function (key) {\n' +
                '            return !allowedKeys.has(key);\n',
                '            \'totalInputs\', \'partial\', \'atLatest\', \'stale\',\n' +
                '        ];\n' +
                '        var allowedKeys = new Set(requiredKeys.concat([\n' +
                '            \'html\', \'htmlSignature\', \'previousCursor\', \'nextCursor\',\n' +
                '            \'subagents\', \'activeSubagent\', \'displayName\', \'target\',\n' +
                '            \'comments\', \'projectComments\', \'bookmarks\',\n' +
                '        ]));\n' +
                '        if (Object.keys(message).some(function (key) {\n' +
                '            return !allowedKeys.has(key);\n')
        .replace(
                '                || typeof message.htmlSignature === \'string\')\n' +
                '            && (message.html !== undefined\n' +
                '                || message.htmlSignature !== undefined)\n' +
                '            && (message.restoreFrame === undefined\n' +
                '                || typeof message.restoreFrame === \'boolean\')\n' +
                '            && typeof message.selectedInteractionId === \'string\'\n' +
                '            && validOutline(message.outline, message.selectedInteractionId)\n' +
                '            && Number.isSafeInteger(message.selectedInput)\n',
                '                || typeof message.htmlSignature === \'string\')\n' +
                '            && (message.html !== undefined\n' +
                '                || message.htmlSignature !== undefined)\n' +
                '            && typeof message.selectedInteractionId === \'string\'\n' +
                '            && validOutline(message.outline, message.selectedInteractionId)\n' +
                '            && Number.isSafeInteger(message.selectedInput)\n')
        .replace(
                '        )) {\n' +
                '            return false;\n' +
                '        }\n' +
                '        // The session is really switching: stash the outgoing conversation\n' +
                '        // as a detached frame before any state is reset, so a later switch\n' +
                '        // back can reattach it whole.\n' +
                '        stashCurrentFrame();\n' +
                '        telemetryController.resetSession(\n' +
                '            nextCommentTarget,\n' +
                '            message.subscriptionGeneration\n',
                '        )) {\n' +
                '            return false;\n' +
                '        }\n' +
                '        telemetryController.resetSession(\n' +
                '            nextCommentTarget,\n' +
                '            message.subscriptionGeneration\n')
        .replace(
                '        );\n' +
                '    }\n' +
                '\n' +
                '    function frameSessionKey(target) {\n' +
                '        if (!target) {\n' +
                '            return null;\n' +
                '        }\n',
                '        );\n' +
                '    }\n' +
                '\n' +
                '    function sanitizedPageSessionKey(target) {\n' +
                '        if (!target) {\n' +
                '            return null;\n' +
                '        }\n')
        .replace(
                '            + \'\\u0001\' + target.sessionId;\n' +
                '    }\n' +
                '\n' +
                '    // Stash the live conversation as a detached frame before a session\n' +
                '    // switch resets the viewer state. Only a fully applied page is\n' +
                '    // stashable; the content token is what makes the frame trustworthy.\n' +
                '    function stashCurrentFrame() {\n' +
                '        if (!state.initialized\n' +
                '            || typeof state.appliedHtmlSignature !== \'string\'\n' +
                '            || !commentTarget\n' +
                '            || !messages.firstChild) {\n' +
                '            return;\n' +
                '        }\n' +
                '        var key = frameSessionKey(commentTarget);\n' +
                '        if (!key) {\n' +
                '            return;\n' +
                '        }\n' +
                '        var anchor = captureReadingAnchor();\n' +
                '        var scrollTop = scroll.scrollTop;\n' +
                '        var followingEnd = reconcileController.atEnd();\n' +
                '        var nodes = Array.prototype.slice.call(messages.childNodes);\n' +
                '        // Pending mermaid renders never settle once detached (isConnected\n' +
                '        // guards drop them); resetting lets a restore re-render from source.\n' +
                '        nodes.forEach(function (node) {\n' +
                '            if (!node || node.nodeType !== 1) {\n' +
                '                return;\n' +
                '            }\n' +
                '            Array.prototype.forEach.call(\n' +
                '                node.querySelectorAll(\'pre[aria-busy="true"]\'),\n' +
                '                function (pre) {\n' +
                '                    pre.removeAttribute(\'aria-busy\');\n' +
                '                }\n' +
                '            );\n' +
                '        });\n' +
                '        var existing = frameCache.get(key);\n' +
                '        if (existing) {\n' +
                '            frameCacheNodes -= existing.nodeCount;\n' +
                '            frameCache.delete(key);\n' +
                '        }\n' +
                '        frameCache.set(key, {\n' +
                '            projectId: commentTarget.projectId,\n' +
                '            provider: commentTarget.provider,\n' +
                '            sessionId: commentTarget.sessionId,\n' +
                '            token: state.appliedHtmlSignature,\n' +
                '            nodes: nodes,\n' +
                '            nodeCount: nodes.length,\n' +
                '            messageIds: state.messageIds,\n' +
                '            messageSignatures: state.messageSignatures,\n' +
                '            worklogExpanded: state.worklogExpanded,\n' +
                '            scrollTop: scrollTop,\n' +
                '            anchor: anchor,\n' +
                '            followingEnd: followingEnd,\n' +
                '            selectedInteractionId: restoreTarget\n' +
                '                ? restoreTarget.interactionId\n' +
                '                : undefined,\n' +
                '        });\n' +
                '        frameCacheNodes += nodes.length;\n' +
                '        while ((frameCache.size > FRAME_CACHE_LIMIT\n' +
                '                || frameCacheNodes > FRAME_CACHE_NODE_BUDGET)\n' +
                '            && frameCache.size > 1) {\n' +
                '            var oldestKey = frameCache.keys().next().value;\n' +
                '            if (oldestKey === undefined || oldestKey === key) {\n' +
                '                break;\n' +
                '            }\n' +
                '            var evicted = frameCache.get(oldestKey);\n' +
                '            frameCache.delete(oldestKey);\n' +
                '            if (evicted) {\n' +
                '                frameCacheNodes -= evicted.nodeCount;\n' +
                '                evicted.nodes.forEach(function (node) {\n' +
                '                    if (node && node.nodeType === 1) {\n' +
                '                        mermaidRenderer.release(node);\n' +
                '                    }\n' +
                '                });\n' +
                '            }\n' +
                '        }\n' +
                '    }\n' +
                '\n' +
                '    // A frame is restorable only when its content token matches the page\'s\n' +
                '    // signature — the token equality proves the DOM is byte-identical to\n' +
                '    // what the Host just published. Restoring takes the frame out of the\n' +
                '    // cache: its nodes move back into the live tree.\n' +
                '    function takeRestorableFrame(message) {\n' +
                '        var key = frameSessionKey(message.target);\n' +
                '        if (!key || typeof message.htmlSignature !== \'string\') {\n' +
                '            return undefined;\n' +
                '        }\n' +
                '        var frame = frameCache.get(key);\n' +
                '        if (!frame || frame.token !== message.htmlSignature) {\n' +
                '            return undefined;\n' +
                '        }\n' +
                '        frameCacheNodes -= frame.nodeCount;\n' +
                '        frameCache.delete(key);\n' +
                '        return frame;\n' +
                '    }\n' +
                '\n' +
                '    function restoreConversationFrame(frame) {\n' +
                '        messages.replaceChildren.apply(messages, frame.nodes);\n' +
                '        state.messageIds = frame.messageIds;\n' +
                '        state.messageSignatures = frame.messageSignatures;\n' +
                '        state.worklogExpanded = frame.worklogExpanded;\n' +
                '    }\n' +
                '\n' +
                '    function acknowledgePage(message) {\n' +
                '        // The correlated applied acknowledgement: the Host may omit HTML\n' +
                '        // from a later publication only after this confirms application.\n' +
                '        // The frame inventory keeps the Host\'s restoreFrame offers truthful\n' +
                '        // about what is actually still cached here.\n' +
                '        if (typeof message.htmlSignature !== \'string\') {\n' +
                '            return;\n' +
                '        }\n' +
                '        var frames = [];\n' +
                '        frameCache.forEach(function (frame) {\n' +
                '            frames.push({\n' +
                '                projectId: frame.projectId,\n' +
                '                provider: frame.provider,\n' +
                '                sessionId: frame.sessionId,\n' +
                '                token: frame.token,\n' +
                '            });\n' +
                '        });\n' +
                '        post({\n' +
                '            type: \'conversation-viewer-applied\',\n' +
                '            version: 1,\n' +
                '            subscriptionGeneration: message.subscriptionGeneration,\n' +
                '            requestId: message.requestId,\n' +
                '            htmlSignature: message.htmlSignature,\n' +
                '            frames: frames,\n' +
                '        });\n' +
                '    }\n' +
                '\n',
                '            + \'\\u0001\' + target.sessionId;\n' +
                '    }\n' +
                '\n' +
                '    function cachedSanitizedPage(sessionKey, signature) {\n' +
                '        var entry = sanitizedPageCache.get(sessionKey);\n' +
                '        if (!entry || entry.signature !== signature) {\n' +
                '            return undefined;\n' +
                '        }\n' +
                '        sanitizedPageCache.delete(sessionKey);\n' +
                '        sanitizedPageCache.set(sessionKey, entry);\n' +
                '        return entry.clean;\n' +
                '    }\n' +
                '\n' +
                '    function cacheSanitizedPage(sessionKey, signature, clean) {\n' +
                '        var existing = sanitizedPageCache.get(sessionKey);\n' +
                '        if (existing) {\n' +
                '            sanitizedPageCacheBytes -= existing.bytes;\n' +
                '            sanitizedPageCache.delete(sessionKey);\n' +
                '        }\n' +
                '        sanitizedPageCache.set(sessionKey, {\n' +
                '            signature: signature,\n' +
                '            clean: clean,\n' +
                '            bytes: clean.length,\n' +
                '        });\n' +
                '        sanitizedPageCacheBytes += clean.length;\n' +
                '        while (sanitizedPageCacheBytes > SANITIZED_PAGE_CACHE_LIMIT\n' +
                '            && sanitizedPageCache.size > 1) {\n' +
                '            var oldestKey = sanitizedPageCache.keys().next().value;\n' +
                '            if (oldestKey === undefined || oldestKey === sessionKey) {\n' +
                '                break;\n' +
                '            }\n' +
                '            var oldest = sanitizedPageCache.get(oldestKey);\n' +
                '            if (oldest) {\n' +
                '                sanitizedPageCacheBytes -= oldest.bytes;\n' +
                '            }\n' +
                '            sanitizedPageCache.delete(oldestKey);\n' +
                '        }\n' +
                '    }\n' +
                '\n' +
                '    function sanitizeConversationPage(message) {\n' +
                '        var sessionKey = sanitizedPageSessionKey(message.target);\n' +
                '        var cacheable = sessionKey !== null\n' +
                '            && typeof message.htmlSignature === \'string\';\n' +
                '        if (cacheable) {\n' +
                '            var cached = cachedSanitizedPage(\n' +
                '                sessionKey,\n' +
                '                message.htmlSignature\n' +
                '            );\n' +
                '            if (cached !== undefined) {\n' +
                '                return cached;\n' +
                '            }\n' +
                '        }\n' +
                '        var clean = window.DOMPurify.sanitize(message.html, {\n' +
                '            ALLOWED_TAGS: allowedTags,\n' +
                '            ALLOWED_ATTR: allowedAttributes,\n' +
                '            ALLOW_DATA_ATTR: false,\n' +
                '            ALLOW_ARIA_ATTR: false,\n' +
                '        });\n' +
                '        if (cacheable) {\n' +
                '            cacheSanitizedPage(sessionKey, message.htmlSignature, clean);\n' +
                '        }\n' +
                '        return clean;\n' +
                '    }\n' +
                '\n' +
                '    function acknowledgePage(message) {\n' +
                '        // The correlated applied acknowledgement: the Host may omit HTML\n' +
                '        // from a later publication only after this confirms application.\n' +
                '        if (typeof message.htmlSignature !== \'string\') {\n' +
                '            return;\n' +
                '        }\n' +
                '        post({\n' +
                '            type: \'conversation-viewer-applied\',\n' +
                '            version: 1,\n' +
                '            subscriptionGeneration: message.subscriptionGeneration,\n' +
                '            requestId: message.requestId,\n' +
                '            htmlSignature: message.htmlSignature,\n' +
                '        });\n' +
                '    }\n' +
                '\n')
        .replace(
                '        }\n' +
                '        state.latestRequestId = message.requestId;\n' +
                '        var hasHtml = typeof message.html === \'string\';\n' +
                '        // A stashed frame whose token matches this page\'s signature is\n' +
                '        // byte-identical to what the Host published: restore it whole and\n' +
                '        // skip the sanitize, parse, and reconcile entirely.\n' +
                '        var frame = hasHtml || message.restoreFrame === true\n' +
                '            ? takeRestorableFrame(message)\n' +
                '            : undefined;\n' +
                '        if (!hasHtml && !frame) {\n' +
                '            if (message.restoreFrame === true) {\n' +
                '                // The Host believes this frame is cached but it is not (or\n' +
                '                // its token moved on): request a full resync.\n' +
                '                requestConversationResync();\n' +
                '                return;\n' +
                '            }\n' +
                '            if (message.htmlSignature !== state.appliedHtmlSignature) {\n' +
                '                // A delta that does not match the applied content cannot be\n' +
                '                // applied; request a full resync instead of staying stale.\n' +
                '                requestConversationResync();\n' +
                '                return;\n' +
                '            }\n' +
                '        }\n' +
                '        var previousScrollTop = scroll.scrollTop;\n' +
                '        var isLiveRefresh = state.initialized\n',
                '        }\n' +
                '        state.latestRequestId = message.requestId;\n' +
                '        var hasHtml = typeof message.html === \'string\';\n' +
                '        if (!hasHtml\n' +
                '            && message.htmlSignature !== state.appliedHtmlSignature) {\n' +
                '            // A delta that does not match the applied content cannot be\n' +
                '            // applied; request a full resync instead of staying stale.\n' +
                '            requestConversationResync();\n' +
                '            return;\n' +
                '        }\n' +
                '        var previousScrollTop = scroll.scrollTop;\n' +
                '        var isLiveRefresh = state.initialized\n')
        .replace(
                '        var oldSignatures = state.messageSignatures;\n' +
                '        state.renderGeneration += 1;\n' +
                '        var renderGeneration = state.renderGeneration;\n' +
                '        if (frame) {\n' +
                '            restoreConversationFrame(frame);\n' +
                '        } else if (hasHtml) {\n' +
                '            var clean = window.DOMPurify.sanitize(message.html, {\n' +
                '                ALLOWED_TAGS: allowedTags,\n' +
                '                ALLOWED_ATTR: allowedAttributes,\n' +
                '                ALLOW_DATA_ATTR: false,\n' +
                '                ALLOW_ARIA_ATTR: false,\n' +
                '            });\n' +
                '\n' +
                '            var reconciled = reconcileController.reconcile(\n' +
                '                clean,\n',
                '        var oldSignatures = state.messageSignatures;\n' +
                '        state.renderGeneration += 1;\n' +
                '        var renderGeneration = state.renderGeneration;\n' +
                '        if (hasHtml) {\n' +
                '            var clean = sanitizeConversationPage(message);\n' +
                '\n' +
                '            var reconciled = reconcileController.reconcile(\n' +
                '                clean,\n')
        .replace(
                '        if (!isLiveRefresh) {\n' +
                '            var openingAtLatest = message.atLatest\n' +
                '                && message.updateKind === \'initial\';\n' +
                '            // A frame restore carrying a fresh navigation target behaves\n' +
                '            // like that navigation, not like a return to the stashed\n' +
                '            // reading position.\n' +
                '            var resumeFramePosition = frame\n' +
                '                && message.selectedInteractionId\n' +
                '                    === frame.selectedInteractionId;\n' +
                '            if (resumeFramePosition && frame.followingEnd\n' +
                '                && message.atLatest) {\n' +
                '                reconcileController.scrollToEnd();\n' +
                '            } else if (resumeFramePosition) {\n' +
                '                restoreViewportReadingPosition(\n' +
                '                    frame.anchor,\n' +
                '                    frame.scrollTop\n' +
                '                );\n' +
                '                reconcileController.trackEnd();\n' +
                '            } else if (openingAtLatest) {\n' +
                '                reconcileController.scrollToEnd();\n' +
                '            } else if (selected) {\n' +
                '                centerInMessageViewport(selected);\n',
                '        if (!isLiveRefresh) {\n' +
                '            var openingAtLatest = message.atLatest\n' +
                '                && message.updateKind === \'initial\';\n' +
                '            if (openingAtLatest) {\n' +
                '                reconcileController.scrollToEnd();\n' +
                '            } else if (selected) {\n' +
                '                centerInMessageViewport(selected);\n')
        .replace(
                '                selected.tabIndex = -1;\n' +
                '                selected.focus({ preventScroll: true });\n' +
                '            }\n' +
                '            if (!openingAtLatest && !resumeFramePosition) {\n' +
                '                reconcileController.trackEnd();\n' +
                '            }\n' +
                '            acknowledgePage(message);\n' +
                '            return;\n' +
                '        }\n',
                '                selected.tabIndex = -1;\n' +
                '                selected.focus({ preventScroll: true });\n' +
                '            }\n' +
                '            if (!openingAtLatest) reconcileController.trackEnd();\n' +
                '            acknowledgePage(message);\n' +
                '            return;\n' +
                '        }\n')
        .replace(
            '    function acknowledgePage(message) {\n'
                + '        // The correlated applied acknowledgement: the Host may omit HTML\n'
                + '        // from a later publication only after this confirms application.\n'
                + "        if (typeof message.htmlSignature !== 'string') {\n"
                + '            return;\n'
                + '        }\n'
                + '        post({\n'
                + "            type: 'conversation-viewer-applied',\n"
                + '            version: 1,\n'
                + '            subscriptionGeneration: message.subscriptionGeneration,\n'
                + '            requestId: message.requestId,\n'
                + '            htmlSignature: message.htmlSignature,\n'
                + '        });\n'
                + '    }\n'
                + '\n'
                + '    function applyPage(message) {\n',
            '    function applyPage(message) {\n'
        )
        .replace(
            '            // A delta that does not match the applied content cannot be\n'
                + '            // applied; request a full resync instead of staying stale.\n'
                + '            requestConversationResync();\n'
                + '            return;\n',
            '            // Delta publications omit the HTML string only when it is\n'
                + '            // identical to what the webview already applied. Anything else\n'
                + '            // cannot be applied; the next full publication resynchronizes.\n'
                + '            return;\n'
        )
        .replace(
            '            if (!openingAtLatest) reconcileController.trackEnd();\n'
                + '            acknowledgePage(message);\n'
                + '            return;\n',
            '            if (!openingAtLatest) reconcileController.trackEnd();\n'
                + '            return;\n'
        )
        .replace(
            '            reconcileController.trackEnd();\n'
                + '        }\n'
                + '        acknowledgePage(message);\n'
                + '    }\n',
            '            reconcileController.trackEnd();\n'
                + '        }\n'
                + '    }\n'
        )
        .replace(
            '    var copyRequestSequence = 0;\n'
                + '    var copyPending = new Map();\n'
                + '    var resyncRequested = false;\n',
            '    var copyRequestSequence = 0;\n'
                + '    var copyPending = new Map();\n'
        )
        .replace(
            /    function requestConversationResync\(page, applyError\) \{[\s\S]*?\n    \}\n\n    window\.addEventListener\('message', function \(event\) \{\n/,
            "    window.addEventListener('message', function (event) {\n"
        )
        .replace(
            '    function requestConversationResync(page) {\n'
                + '        // Correlate the request to the page that failed to apply: the\n'
                + '        // Host rebuilds only while it still owns that generation and\n'
                + '        // session, and ignores requests stranded by a newer switch. One\n'
                + '        // request per generation; the Host bounds rebuilds per\n'
                + '        // publication, so a persistent apply failure cannot reload-loop.\n'
                + '        var generation = state.subscriptionGeneration;\n'
                + '        var target = commentTarget;\n'
                + '        if (page\n'
                + '            && Number.isSafeInteger(page.subscriptionGeneration)\n'
                + '            && page.subscriptionGeneration >= 1\n'
                + '            && validCommentTarget({\n'
                + '                projectId: page.target && page.target.projectId,\n'
                + '                provider: page.target && page.target.provider,\n'
                + '                sessionId: page.target && page.target.sessionId,\n'
                + '            })) {\n'
                + '            generation = page.subscriptionGeneration;\n'
                + '            target = page.target;\n'
                + '        }\n'
                + '        if (!target || !generation\n'
                + '            || resyncRequestedGeneration === generation) {\n'
                + '            return;\n'
                + '        }\n'
                + '        resyncRequestedGeneration = generation;\n'
                + '        // Dropped deltas must not suppress the rebuilt full publication.\n'
                + '        state.appliedHtmlSignature = undefined;\n'
                + '        post({\n'
                + "            type: 'conversation-viewer-request-sync',\n"
                + '            version: 1,\n'
                + '            subscriptionGeneration: generation,\n'
                + '            projectId: target.projectId,\n'
                + '            provider: target.provider,\n'
                + '            sessionId: target.sessionId,\n'
                + '        });\n'
                + '    }\n'
                + '\n'
                + "    window.addEventListener('message', function (event) {\n",
            "    window.addEventListener('message', function (event) {\n"
        )
        .replace(
            '        if (applyFollowNotice(event.data)) return;\n'
                + '        if (applyLoadingNotice(event.data)) return;\n'
                + '        try {\n'
                + '            applyPage(event.data);\n'
                + '        } catch (_applyError) {\n'
                + '            requestConversationResync(event.data);\n'
                + '        }\n'
                + '    });\n',
            '        if (applyFollowNotice(event.data)) return;\n'
                + '        applyPage(event.data);\n'
                + '    });\n'
        )
        .replace(
            '        var parsedInitialPage;\n'
                + '        try {\n'
                + '            parsedInitialPage = JSON.parse(initialPage);\n'
                + '            applyPage(parsedInitialPage);\n'
                + '        } catch (_error) {\n'
                + "            status.textContent = 'Conversation history unavailable.';\n"
                + '            requestConversationResync(parsedInitialPage);\n'
                + '        }\n',
            '        try {\n'
                + '            applyPage(JSON.parse(initialPage));\n'
                + '        } catch (_error) {\n'
                + "            status.textContent = 'Conversation history unavailable.';\n"
                + '        }\n'
        )
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
        )
        .replace(
            "    var sessionStatusRunning = document.querySelector(\n"
                + "        '[data-session-status-running]'\n"
                + "    );\n"
                + "    var sessionStatusRunningCount = document.querySelector(\n"
                + "        '[data-session-status-running-count]'\n"
                + "    );\n"
                + "    var sessionStatusAttention = document.querySelector(\n"
                + "        '[data-session-status-attention]'\n"
                + "    );\n"
                + "    var sessionStatusAttentionCount = document.querySelector(\n"
                + "        '[data-session-status-attention-count]'\n"
                + "    );\n"
                + "    var sessionStatusIdle = document.querySelector(\n"
                + "        '[data-session-status-idle]'\n"
                + "    );\n"
                + "    var sessionStatusIdleCount = document.querySelector(\n"
                + "        '[data-session-status-idle-count]'\n"
                + "    );\n",
            ''
        )
        .replace(
            '    [sessionStatusRunning, sessionStatusAttention, sessionStatusIdle]\n'
                + '        .forEach(function (button) {\n'
                + '            if (!button) return;\n'
                + "            button.addEventListener('click', function () {\n"
                + '                post({\n'
                + "                    type: 'conversation-viewer-cycle-status-session',\n"
                + '                    version: 1,\n'
                + "                    kind: button.getAttribute('data-session-status-cycle'),\n"
                + '                });\n'
                + '            });\n'
                + '        });\n'
                + "    // The telemetry provider icon clears the viewed session's attention\n"
                + "    // state; it is actionable only while the Host reports 'attention'.\n"
                + '    function postAcknowledgeAttention() {\n'
                + '        if (!telemetryProvider\n'
                + "            || telemetryProvider.getAttribute('data-session-state')\n"
                + "                !== 'attention') {\n"
                + '            return;\n'
                + '        }\n'
                + '        post({\n'
                + "            type: 'conversation-viewer-acknowledge-attention',\n"
                + '            version: 1,\n'
                + '        });\n'
                + '    }\n'
                + '    if (telemetryProvider) {\n'
                + "        telemetryProvider.addEventListener('click', postAcknowledgeAttention);\n"
                + "        telemetryProvider.addEventListener('keydown', function (event) {\n"
                + "            if (event.key !== 'Enter' && event.key !== ' ') {\n"
                + '                return;\n'
                + '            }\n'
                + '            event.preventDefault();\n'
                + '            postAcknowledgeAttention();\n'
                + '        });\n'
                + '    }\n',
            ''
        )
        .replace(
            "                type: 'conversation-viewer-switch-window',\n",
            "                type: 'conversation-viewer-switch-session',\n"
        )
        .replace(
            "        latestStatusRequestId: Number(document.body.getAttribute(\n"
                + "            'data-session-status-request-id'\n"
                + "        )) || 0,\n",
            ''
        )
        .replace('        state.latestStatusRequestId = 0;\n', '')
        .replace(
            "    function sessionStatusDotLabel(kind, localCount) {\n"
                + "        if (kind === 'running') {\n"
                + "            return localCount === 0\n"
                + "                ? 'No AI sessions running in this window'\n"
                + "                : localCount + ' running in this window'\n"
                + "                    + ' · click to switch to the next';\n"
                + "        }\n"
                + "        if (kind === 'attention') {\n"
                + "            return localCount === 0\n"
                + "                ? 'No AI sessions need attention in this window'\n"
                + "                : localCount + ' need attention in this window'\n"
                + "                    + ' · click to switch to the next';\n"
                + "        }\n"
                + "        return localCount === 0\n"
                + "            ? 'No idle AI sessions in this window'\n"
                + "            : localCount + ' idle in this window'\n"
                + "                + ' · click to switch to the next';\n"
                + "    }\n"
                + "    function validSessionStatus(value) {\n"
                + "        if (!value || typeof value !== 'object' || Array.isArray(value)) {\n"
                + "            return false;\n"
                + "        }\n"
                + "        var keys = Object.keys(value);\n"
                + "        return (keys.length === 5\n"
                + "                || (keys.length === 6\n"
                + "                    && keys.indexOf('currentSessionKind') !== -1))\n"
                + "            && keys.indexOf('runningSessions') !== -1\n"
                + "            && keys.indexOf('attentionSessions') !== -1\n"
                + "            && keys.indexOf('runningSessionsLocal') !== -1\n"
                + "            && keys.indexOf('attentionSessionsLocal') !== -1\n"
                + "            && keys.indexOf('idleSessionsLocal') !== -1\n"
                + "            && (keys.indexOf('currentSessionKind') === -1\n"
                + "                || value.currentSessionKind === 'running'\n"
                + "                || value.currentSessionKind === 'attention'\n"
                + "                || value.currentSessionKind === 'idle')\n"
                + "            && Number.isSafeInteger(value.runningSessions)\n"
                + "            && value.runningSessions >= 0\n"
                + "            && value.runningSessions <= 100000\n"
                + "            && Number.isSafeInteger(value.attentionSessions)\n"
                + "            && value.attentionSessions >= 0\n"
                + "            && value.attentionSessions <= 100000\n"
                + "            && Number.isSafeInteger(value.runningSessionsLocal)\n"
                + "            && value.runningSessionsLocal >= 0\n"
                + "            && value.runningSessionsLocal <= value.runningSessions\n"
                + "            && Number.isSafeInteger(value.attentionSessionsLocal)\n"
                + "            && value.attentionSessionsLocal >= 0\n"
                + "            && value.attentionSessionsLocal <= value.attentionSessions\n"
                + "            && Number.isSafeInteger(value.idleSessionsLocal)\n"
                + "            && value.idleSessionsLocal >= 0\n"
                + "            && value.idleSessionsLocal <= 100000;\n"
                + "    }\n"
                + "    function applySessionStatusDot(element, countElement, kind, localCount) {\n"
                + "        var label = sessionStatusDotLabel(kind, localCount);\n"
                + "        element.classList.toggle(\n"
                + "            'conversation-session-status-active',\n"
                + "            kind !== 'idle' && localCount > 0\n"
                + "        );\n"
                + "        element.title = label;\n"
                + "        element.setAttribute('aria-label', label);\n"
                + "        element.disabled = localCount === 0;\n"
                + "        countElement.textContent = String(localCount);\n"
                + "    }\n"
                + "    function applySessionStatusMessage(message) {\n"
                + "        if (!message || typeof message !== 'object'\n"
                + "            || message.type !== 'conversation-viewer-session-status'\n"
                + "            || message.version !== 1\n"
                + "            || !Number.isSafeInteger(message.requestId)\n"
                + "            || message.requestId < state.latestStatusRequestId\n"
                + "            || message.subscriptionGeneration !== state.subscriptionGeneration\n"
                + "            || !validSessionStatus(message.status)\n"
                + "            || !sessionStatusRunning || !sessionStatusRunningCount\n"
                + "            || !sessionStatusAttention || !sessionStatusAttentionCount\n"
                + "            || !sessionStatusIdle || !sessionStatusIdleCount) {\n"
                + "            return false;\n"
                + "        }\n"
                + "        state.latestStatusRequestId = message.requestId;\n"
                + "        applySessionStatusDot(\n"
                + "            sessionStatusRunning,\n"
                + "            sessionStatusRunningCount,\n"
                + "            'running',\n"
                + "            message.status.runningSessionsLocal\n"
                + "        );\n"
                + "        applySessionStatusDot(\n"
                + "            sessionStatusAttention,\n"
                + "            sessionStatusAttentionCount,\n"
                + "            'attention',\n"
                + "            message.status.attentionSessionsLocal\n"
                + "        );\n"
                + "        applySessionStatusDot(\n"
                + "            sessionStatusIdle,\n"
                + "            sessionStatusIdleCount,\n"
                + "            'idle',\n"
                + "            message.status.idleSessionsLocal\n"
                + "        );\n"
                + "        // The provider icon in the telemetry bar mirrors the viewed\n"
                + "        // session's lifecycle group; the Host is authoritative, so the\n"
                + "        // icon simply renders whatever kind the message carries.\n"
                + "        telemetryController.setSessionState(message.status.currentSessionKind);\n"
                + "        return true;\n"
                + "    }",
"    function sessionStatusDotLabel(kind, localCount, totalCount) {\n"
                + "        if (totalCount === 0) {\n"
                + "            return kind === 'running'\n"
                + "                ? 'No AI sessions running'\n"
                + "                : 'No AI sessions need attention';\n"
                + "        }\n"
                + "        return kind === 'running'\n"
                + "            ? localCount + ' running in this window · ' + totalCount + ' across all windows'\n"
                + "            : localCount + ' need attention in this window · ' + totalCount + ' across all windows';\n"
                + "    }\n"
                + "    function validSessionStatus(value) {\n"
                + "        if (!value || typeof value !== 'object' || Array.isArray(value)) {\n"
                + "            return false;\n"
                + "        }\n"
                + "        var keys = Object.keys(value);\n"
                + "        return keys.length === 4\n"
                + "            && keys.indexOf('runningSessions') !== -1\n"
                + "            && keys.indexOf('attentionSessions') !== -1\n"
                + "            && keys.indexOf('runningSessionsLocal') !== -1\n"
                + "            && keys.indexOf('attentionSessionsLocal') !== -1\n"
                + "            && Number.isSafeInteger(value.runningSessions)\n"
                + "            && value.runningSessions >= 0\n"
                + "            && value.runningSessions <= 100000\n"
                + "            && Number.isSafeInteger(value.attentionSessions)\n"
                + "            && value.attentionSessions >= 0\n"
                + "            && value.attentionSessions <= 100000\n"
                + "            && Number.isSafeInteger(value.runningSessionsLocal)\n"
                + "            && value.runningSessionsLocal >= 0\n"
                + "            && value.runningSessionsLocal <= value.runningSessions\n"
                + "            && Number.isSafeInteger(value.attentionSessionsLocal)\n"
                + "            && value.attentionSessionsLocal >= 0\n"
                + "            && value.attentionSessionsLocal <= value.attentionSessions;\n"
                + "    }\n"
                + "    function applySessionStatusDot(element, countElement, kind, localCount, totalCount) {\n"
                + "        var label = sessionStatusDotLabel(kind, localCount, totalCount);\n"
                + "        element.classList.toggle(\n"
                + "            'conversation-session-status-active',\n"
                + "            totalCount > 0\n"
                + "        );\n"
                + "        element.title = label;\n"
                + "        element.setAttribute('aria-label', label);\n"
                + "        countElement.textContent = localCount + '/' + totalCount;\n"
                + "    }\n"
                + "    function applySessionStatusMessage(message) {\n"
                + "        if (!message || typeof message !== 'object'\n"
                + "            || message.type !== 'conversation-viewer-session-status'\n"
                + "            || message.version !== 1\n"
                + "            || !Number.isSafeInteger(message.requestId)\n"
                + "            || message.requestId < state.latestStatusRequestId\n"
                + "            || message.subscriptionGeneration !== state.subscriptionGeneration\n"
                + "            || !validSessionStatus(message.status)\n"
                + "            || !sessionStatusRunning || !sessionStatusRunningCount\n"
                + "            || !sessionStatusAttention || !sessionStatusAttentionCount) {\n"
                + "            return false;\n"
                + "        }\n"
                + "        state.latestStatusRequestId = message.requestId;\n"
                + "        applySessionStatusDot(\n"
                + "            sessionStatusRunning,\n"
                + "            sessionStatusRunningCount,\n"
                + "            'running',\n"
                + "            message.status.runningSessionsLocal,\n"
                + "            message.status.runningSessions\n"
                + "        );\n"
                + "        applySessionStatusDot(\n"
                + "            sessionStatusAttention,\n"
                + "            sessionStatusAttentionCount,\n"
                + "            'attention',\n"
                + "            message.status.attentionSessionsLocal,\n"
                + "            message.status.attentionSessions\n"
                + "        );\n"
                + "        return true;\n"
                + "    }"
        )
        .replace(
            '        if (applySessionStatusMessage(event.data)) return;\n',
            ''
        )
        .replace(
            '    var copyRequestSequence = 0;\n'
                + '    var copyPending = new Map();\n'
                + '    // Recently sanitized pages keyed by session, so switching back to a\n'
                + '    // session whose content is unchanged (same htmlSignature) skips the\n'
                + '    // multi-megabyte DOMPurify pass entirely.\n'
                + '    var sanitizedPageCache = new Map();\n'
                + '    var sanitizedPageCacheBytes = 0;\n'
                + '    var SANITIZED_PAGE_CACHE_LIMIT = 16 * 1024 * 1024;\n',
            '    var copyRequestSequence = 0;\n'
                + '    var copyPending = new Map();\n'
        )
        .replace(
            "    function sanitizedPageSessionKey(target) {\n"
                + '        if (!target) {\n'
                + '            return null;\n'
                + '        }\n'
                + "        return target.projectId + '\\u0001' + target.provider\n"
                + "            + '\\u0001' + target.sessionId;\n"
                + '    }\n'
                + '\n'
                + '    function cachedSanitizedPage(sessionKey, signature) {\n'
                + '        var entry = sanitizedPageCache.get(sessionKey);\n'
                + '        if (!entry || entry.signature !== signature) {\n'
                + '            return undefined;\n'
                + '        }\n'
                + '        sanitizedPageCache.delete(sessionKey);\n'
                + '        sanitizedPageCache.set(sessionKey, entry);\n'
                + '        return entry.clean;\n'
                + '    }\n'
                + '\n'
                + '    function cacheSanitizedPage(sessionKey, signature, clean) {\n'
                + '        var existing = sanitizedPageCache.get(sessionKey);\n'
                + '        if (existing) {\n'
                + '            sanitizedPageCacheBytes -= existing.bytes;\n'
                + '            sanitizedPageCache.delete(sessionKey);\n'
                + '        }\n'
                + '        sanitizedPageCache.set(sessionKey, {\n'
                + '            signature: signature,\n'
                + '            clean: clean,\n'
                + '            bytes: clean.length,\n'
                + '        });\n'
                + '        sanitizedPageCacheBytes += clean.length;\n'
                + '        while (sanitizedPageCacheBytes > SANITIZED_PAGE_CACHE_LIMIT\n'
                + '            && sanitizedPageCache.size > 1) {\n'
                + '            var oldestKey = sanitizedPageCache.keys().next().value;\n'
                + '            if (oldestKey === undefined || oldestKey === sessionKey) {\n'
                + '                break;\n'
                + '            }\n'
                + '            var oldest = sanitizedPageCache.get(oldestKey);\n'
                + '            if (oldest) {\n'
                + '                sanitizedPageCacheBytes -= oldest.bytes;\n'
                + '            }\n'
                + '            sanitizedPageCache.delete(oldestKey);\n'
                + '        }\n'
                + '    }\n'
                + '\n'
                + '    function sanitizeConversationPage(message) {\n'
                + '        var sessionKey = sanitizedPageSessionKey(message.target);\n'
                + '        var cacheable = sessionKey !== null\n'
                + "            && typeof message.htmlSignature === 'string';\n"
                + '        if (cacheable) {\n'
                + '            var cached = cachedSanitizedPage(\n'
                + '                sessionKey,\n'
                + '                message.htmlSignature\n'
                + '            );\n'
                + '            if (cached !== undefined) {\n'
                + '                return cached;\n'
                + '            }\n'
                + '        }\n'
                + '        var clean = window.DOMPurify.sanitize(message.html, {\n'
                + '            ALLOWED_TAGS: allowedTags,\n'
                + '            ALLOWED_ATTR: allowedAttributes,\n'
                + '            ALLOW_DATA_ATTR: false,\n'
                + '            ALLOW_ARIA_ATTR: false,\n'
                + '        });\n'
                + '        if (cacheable) {\n'
                + '            cacheSanitizedPage(sessionKey, message.htmlSignature, clean);\n'
                + '        }\n'
                + '        return clean;\n'
                + '    }\n'
                + '\n'
                + '    function applyPage(message) {\n',
            '    function applyPage(message) {\n'
        )
        .replace(
            '        if (hasHtml) {\n'
                + '            var clean = sanitizeConversationPage(message);\n'
                + '\n'
                + '            var reconciled = reconcileController.reconcile(\n',
            '        if (hasHtml) {\n'
                + '            var clean = window.DOMPurify.sanitize(message.html, {\n'
                + '                ALLOWED_TAGS: allowedTags,\n'
                + '                ALLOWED_ATTR: allowedAttributes,\n'
                + '                ALLOW_DATA_ATTR: false,\n'
                + '                ALLOW_ARIA_ATTR: false,\n'
                + '            });\n'
                + '\n'
                + '            var reconciled = reconcileController.reconcile(\n'
        )
        .replace(
            '        renderGeneration: 0,\n        appliedHtmlSignature: undefined,\n',
            '        renderGeneration: 0,\n'
        )
        .replace(
            "            'updateKind', 'outline', 'selectedInteractionId', 'selectedInput',\n",
            "            'updateKind', 'html', 'outline', 'selectedInteractionId', 'selectedInput',\n"
        )
        .replace(
            "            'html', 'htmlSignature', 'previousCursor', 'nextCursor',\n"
                + "            'subagents', 'activeSubagent', 'displayName', 'target',\n"
                + "            'comments', 'projectComments', 'bookmarks',\n",
            "            'previousCursor', 'nextCursor', 'subagents', 'activeSubagent',\n"
                + "            'displayName', 'target', 'comments', 'projectComments',\n"
                + "            'bookmarks',\n"
        )
        .replace(
            '            && (message.html === undefined\n'
                + "                || typeof message.html === 'string')\n"
                + '            && (message.htmlSignature === undefined\n'
                + "                || typeof message.htmlSignature === 'string')\n"
                + '            && (message.html !== undefined\n'
                + '                || message.htmlSignature !== undefined)\n'
                + "            && typeof message.selectedInteractionId === 'string'\n",
            "            && typeof message.html === 'string'\n"
                + "            && typeof message.selectedInteractionId === 'string'\n"
        )
        .replace(
            '        state.worklogExpanded = new Map();\n'
                + '        state.appliedHtmlSignature = undefined;\n'
                + '        copyPending = new Map();\n',
            '        state.worklogExpanded = new Map();\n'
                + '        copyPending = new Map();\n'
        )
        .replace(
            '        state.latestRequestId = message.requestId;\n'
                + "        var hasHtml = typeof message.html === 'string';\n"
                + '        if (!hasHtml\n'
                + '            && message.htmlSignature !== state.appliedHtmlSignature) {\n'
                + '            // Delta publications omit the HTML string only when it is\n'
                + '            // identical to what the webview already applied. Anything else\n'
                + '            // cannot be applied; the next full publication resynchronizes.\n'
                + '            return;\n'
                + '        }\n'
                + '        var previousScrollTop = scroll.scrollTop;\n',
            '        state.latestRequestId = message.requestId;\n'
                + '        var previousScrollTop = scroll.scrollTop;\n'
        )
        .replace(
            '        if (hasHtml) {\n'
                + '            var clean = window.DOMPurify.sanitize(message.html, {\n'
                + '                ALLOWED_TAGS: allowedTags,\n'
                + '                ALLOWED_ATTR: allowedAttributes,\n'
                + '                ALLOW_DATA_ATTR: false,\n'
                + '                ALLOW_ARIA_ATTR: false,\n'
                + '            });\n'
                + '\n'
                + '            var reconciled = reconcileController.reconcile(\n'
                + '                clean,\n'
                + '                isLiveRefresh,\n'
                + '                oldSignatures\n'
                + '            );\n'
                + '            Array.prototype.forEach.call(\n'
                + "                messages.querySelectorAll('img'),\n"
                + '                function (image) {\n'
                + "                    image.loading = 'lazy';\n"
                + "                    image.decoding = 'async';\n"
                + "                    image.referrerPolicy = 'no-referrer';\n"
                + '                }\n'
                + '            );\n'
                + '            applyWorklogStates();\n'
                + '            applyCopyButtonLabels();\n'
                + '            state.messageIds = reconciled.ids;\n'
                + '            state.messageSignatures = reconciled.signatures;\n'
                + '        }\n'
                + "        if (typeof message.htmlSignature === 'string') {\n"
                + '            state.appliedHtmlSignature = message.htmlSignature;\n'
                + '        }\n',
            '        var clean = window.DOMPurify.sanitize(message.html, {\n'
                + '            ALLOWED_TAGS: allowedTags,\n'
                + '            ALLOWED_ATTR: allowedAttributes,\n'
                + '            ALLOW_DATA_ATTR: false,\n'
                + '            ALLOW_ARIA_ATTR: false,\n'
                + '        });\n'
                + '\n'
                + '        var reconciled = reconcileController.reconcile(\n'
                + '            clean,\n'
                + '            isLiveRefresh,\n'
                + '            oldSignatures\n'
                + '        );\n'
                + '        Array.prototype.forEach.call(\n'
                + "            messages.querySelectorAll('img'),\n"
                + '            function (image) {\n'
                + "                image.loading = 'lazy';\n"
                + "                image.decoding = 'async';\n"
                + "                image.referrerPolicy = 'no-referrer';\n"
                + '            }\n'
                + '        );\n'
                + '        applyWorklogStates();\n'
                + '        applyCopyButtonLabels();\n'
                + '        var nextIds = reconciled.ids;\n'
                + '        var nextSignatures = reconciled.signatures;\n'
                + '        state.messageIds = nextIds;\n'
                + '        state.messageSignatures = nextSignatures;\n'
        )
        .replace(
            '    // A reused panel keeps the outgoing conversation on screen while the\n'
                + "    // incoming session loads. The Host's loading notice arms a lightweight\n"
                + '    // indicator — status text plus a dimmed, aria-busy message list —\n'
                + '    // which the first applied page of the incoming generation clears.\n'
                + '    function applyLoadingNotice(message) {\n'
                + "        if (!message || typeof message !== 'object'\n"
                + "            || message.type !== 'conversation-viewer-loading') {\n"
                + '            return false;\n'
                + '        }\n'
                + '        if (message.version !== 1\n'
                + '            || !Number.isSafeInteger(message.subscriptionGeneration)\n'
                + '            || message.subscriptionGeneration < 1\n'
                + '            || !validCommentTarget({\n'
                + '                projectId: message.target && message.target.projectId,\n'
                + '                provider: message.target && message.target.provider,\n'
                + '                sessionId: message.target && message.target.sessionId,\n'
                + '            })) {\n'
                + '            return true;\n'
                + '        }\n'
                + '        if (message.subscriptionGeneration <= state.subscriptionGeneration\n'
                + '            || (commentTarget\n'
                + '                && message.target.projectId === commentTarget.projectId\n'
                + '                && message.target.provider === commentTarget.provider\n'
                + '                && message.target.sessionId === commentTarget.sessionId)) {\n'
                + '            // Stale or same-session notices never dim the live content.\n'
                + '            return true;\n'
                + '        }\n'
                + '        conversationLoading = true;\n'
                + "        document.body.setAttribute('data-conversation-loading', 'true');\n"
                + "        messages.setAttribute('aria-busy', 'true');\n"
                + "        status.textContent = 'Loading conversation…';\n"
                + '        return true;\n'
                + '    }\n'
                + '\n'
                + '    function clearConversationLoading() {\n'
                + '        if (!conversationLoading) {\n'
                + '            return;\n'
                + '        }\n'
                + '        conversationLoading = false;\n'
                + "        document.body.removeAttribute('data-conversation-loading');\n"
                + "        messages.removeAttribute('aria-busy');\n"
                + '        // The applied page recomputes the status line right below.\n'
                + '    }\n'
                + '\n'
                + '    function applySessionGeneration(message) {\n',
            '    function applySessionGeneration(message) {\n'
        )
        .replace(
            '        state.atLatest = message.atLatest;\n'
                + '        state.initialized = true;\n'
                + '        clearConversationLoading();\n',
            '        state.atLatest = message.atLatest;\n'
                + '        state.initialized = true;\n'
        )
        // Strips for the project · task · session header additions
        // (CONVERSATION-VIEWER-HEADER-001): the task segment, its page-target
        // plumbing, and the click-to-rename binding.
        .replace(
            '    var conversationWorkspaceName = document.querySelector(\n'
                + "        '[data-conversation-workspace-name]'\n"
                + '    );\n'
                + '    var conversationTaskName = document.querySelector(\n'
                + "        '[data-conversation-task-name]'\n"
                + '    );\n'
                + '    var conversationTaskSeparator = document.querySelector(\n'
                + "        '[data-conversation-task-separator]'\n"
                + '    );\n'
                + "    var telemetryRoot = document.querySelector('[data-conversation-telemetry]');\n",
            '    var conversationWorkspaceName = document.querySelector(\n'
                + "        '[data-conversation-workspace-name]'\n"
                + '    );\n'
                + "    var telemetryRoot = document.querySelector('[data-conversation-telemetry]');\n"
        )
        .replace(
            "        allowed.add('workspaceName');\n"
                + "        allowed.add('taskName');\n",
            "        allowed.add('workspaceName');\n"
        )
        .replace(
            '            && (value.duplicateDisplayName === undefined\n'
                + "                || typeof value.duplicateDisplayName === 'boolean')\n"
                + '            && (value.taskName === undefined\n'
                + "                || (typeof value.taskName === 'string'\n"
                + '                    && value.taskName.length <= 640));\n'
                + '    }\n'
                + '\n'
                + '    // The identity line reads project · task · session; the task segment\n'
                + '    // only renders when the session belongs to a worktree task group.\n'
                + '    function applyConversationTaskName(target) {\n'
                + "        var taskName = target && typeof target.taskName === 'string'\n"
                + '            ? target.taskName\n'
                + "            : '';\n"
                + '        if (conversationTaskName) {\n'
                + '            conversationTaskName.textContent = taskName;\n'
                + '            conversationTaskName.hidden = !taskName;\n'
                + '        }\n'
                + '        if (conversationTaskSeparator) {\n'
                + '            conversationTaskSeparator.hidden = !taskName;\n'
                + '        }\n'
                + '    }\n'
                + '\n'
                + '    function validCommentSnapshot(value) {\n',
            '            && (value.duplicateDisplayName === undefined\n'
                + "                || typeof value.duplicateDisplayName === 'boolean');\n"
                + '    }\n'
                + '\n'
                + '    function validCommentSnapshot(value) {\n'
        )
        .replace(
            '        if (validPageTarget(message.target)) {\n'
                + '            applyConversationTaskName(message.target);\n'
                + '        }\n'
                + '        return true;\n',
            '        return true;\n'
        )
        .replace(
            '        if (validPageTarget(message.target)) {\n'
                + '            applyConversationTaskName(message.target);\n'
                + '        }\n'
                + '        updatePosition(message);\n',
            '        updatePosition(message);\n'
        )
        .replace(
            '    });\n'
                + '    if (conversationDisplayName) {\n'
                + "        conversationDisplayName.addEventListener('click', function () {\n"
                + '            post({\n'
                + "                type: 'conversation-viewer-rename-session',\n"
                + '                version: 1,\n'
                + '            });\n'
                + '        });\n'
                + '    }\n'
                + '    if (sidebarUiAvailable) {\n',
            '    });\n'
                + '    if (sidebarUiAvailable) {\n'
        )
        // Strips the direct command action. The adjacent Viewer generation
        // predates its sanitizer allowlist, icon helpers, and click routing.
        .replace(
            "        'data-interaction-id', 'data-conversation-run-command',\n",
            "        'data-interaction-id',\n"
        )
        .replace(
            '    function isRunnableTerminalCommand(command) {\n'
                + "        return typeof command === 'string'\n"
                + '            && command.length > 0\n'
                + '            && command.length <= 4000\n'
                + '            && !!command.trim()\n'
                + '            && !/[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/.test(command);\n'
                + '    }\n\n'
                + '    function postRunCommand(command) {\n'
                + '        if (!copyUiAvailable || !isRunnableTerminalCommand(command)) return;\n'
                + '        post({\n'
                + "            type: 'conversation-viewer-run-command',\n"
                + '            version: 1,\n'
                + '            subscriptionGeneration: state.subscriptionGeneration,\n'
                + '            projectId: commentTarget.projectId,\n'
                + '            provider: commentTarget.provider,\n'
                + '            sessionId: commentTarget.sessionId,\n'
                + '            command: command,\n'
                + '        });\n'
                + '    }\n\n',
            ''
        )
        .replace(
            '    function createTerminalIconElement() {\n'
                + "        var icon = document.createElementNS(copyIconNamespace, 'svg');\n"
                + "        icon.setAttribute('viewBox', '0 0 24 24');\n"
                + "        icon.setAttribute('width', '14');\n"
                + "        icon.setAttribute('height', '14');\n"
                + "        icon.setAttribute('aria-hidden', 'true');\n"
                + "        icon.setAttribute('fill', 'none');\n"
                + "        icon.setAttribute('stroke', 'currentColor');\n"
                + "        icon.setAttribute('stroke-width', '2');\n"
                + "        icon.setAttribute('stroke-linecap', 'round');\n"
                + "        icon.setAttribute('stroke-linejoin', 'round');\n"
                + "        var prompt = document.createElementNS(copyIconNamespace, 'path');\n"
                + "        prompt.setAttribute('d', 'm8 9 3 3-3 3M13 15h3');\n"
                + "        var frame = document.createElementNS(copyIconNamespace, 'rect');\n"
                + "        frame.setAttribute('x', '3');\n"
                + "        frame.setAttribute('y', '4');\n"
                + "        frame.setAttribute('width', '18');\n"
                + "        frame.setAttribute('height', '16');\n"
                + "        frame.setAttribute('rx', '2');\n"
                + '        icon.appendChild(prompt);\n'
                + '        icon.appendChild(frame);\n'
                + '        return icon;\n'
                + '    }\n\n',
            ''
        )
        .replace(
            '    function applyRunCommandButtonLabels() {\n'
                + '        Array.prototype.forEach.call(\n'
                + "            messages.querySelectorAll('[data-conversation-run-command]'),\n"
                + '            function (button) {\n'
                + "                button.setAttribute('title', 'Run command');\n"
                + "                button.setAttribute('aria-label', 'Run command');\n"
                + "                if (!button.querySelector('svg')) {\n"
                + '                    button.appendChild(createTerminalIconElement());\n'
                + '                }\n'
                + '            }\n'
                + '        );\n'
                + '    }\n\n',
            ''
        )
        .replace(
            '            applyCopyButtonLabels();\n'
                + '            applyRunCommandButtonLabels();\n',
            '            applyCopyButtonLabels();\n'
        )
        .replace(
            "    messages.addEventListener('click', function (event) {\n"
                + '        var codeRun = event.target && event.target.closest\n'
                + "            ? event.target.closest('[data-conversation-run-command]')\n"
                + '            : null;\n'
                + '        if (codeRun && messages.contains(codeRun)) {\n'
                + "            var runBlock = codeRun.closest('.conversation-code-block');\n"
                + "            var runCode = runBlock ? runBlock.querySelector('pre code') : null;\n"
                + '            if (!runCode) return;\n'
                + "            postRunCommand(runCode.textContent || '');\n"
                + '            return;\n'
                + '        }\n',
            "    messages.addEventListener('click', function (event) {\n"
        )
        // Restores the pre-delta page application path used by the adjacent
        // Viewer generation, including its local signature variables.
        .replace(
            '        if (hasHtml) {\n'
                + '            var clean = window.DOMPurify.sanitize(message.html, {\n'
                + '                ALLOWED_TAGS: allowedTags,\n'
                + '                ALLOWED_ATTR: allowedAttributes,\n'
                + '                ALLOW_DATA_ATTR: false,\n'
                + '                ALLOW_ARIA_ATTR: false,\n'
                + '            });\n\n'
                + '            var reconciled = reconcileController.reconcile(\n'
                + '                clean,\n'
                + '                isLiveRefresh,\n'
                + '                oldSignatures\n'
                + '            );\n'
                + '            Array.prototype.forEach.call(\n'
                + "                messages.querySelectorAll('img'),\n"
                + '                function (image) {\n'
                + "                    image.loading = 'lazy';\n"
                + "                    image.decoding = 'async';\n"
                + "                    image.referrerPolicy = 'no-referrer';\n"
                + '                }\n'
                + '            );\n'
                + '            applyWorklogStates();\n'
                + '            applyCopyButtonLabels();\n'
                + '            state.messageIds = reconciled.ids;\n'
                + '            state.messageSignatures = reconciled.signatures;\n'
                + '        }\n'
                + "        if (typeof message.htmlSignature === 'string') {\n"
                + '            state.appliedHtmlSignature = message.htmlSignature;\n'
                + '        }\n',
            '        var clean = window.DOMPurify.sanitize(message.html, {\n'
                + '            ALLOWED_TAGS: allowedTags,\n'
                + '            ALLOWED_ATTR: allowedAttributes,\n'
                + '            ALLOW_DATA_ATTR: false,\n'
                + '            ALLOW_ARIA_ATTR: false,\n'
                + '        });\n\n'
                + '        var reconciled = reconcileController.reconcile(\n'
                + '            clean,\n'
                + '            isLiveRefresh,\n'
                + '            oldSignatures\n'
                + '        );\n'
                + '        Array.prototype.forEach.call(\n'
                + "            messages.querySelectorAll('img'),\n"
                + '            function (image) {\n'
                + "                image.loading = 'lazy';\n"
                + "                image.decoding = 'async';\n"
                + "                image.referrerPolicy = 'no-referrer';\n"
                + '            }\n'
                + '        );\n'
                + '        applyWorklogStates();\n'
                + '        applyCopyButtonLabels();\n'
                + '        var nextIds = reconciled.ids;\n'
                + '        var nextSignatures = reconciled.signatures;\n'
                + '        state.messageIds = nextIds;\n'
                + '        state.messageSignatures = nextSignatures;\n'
        )
        .replace(
            '        acknowledgePage(message);\n'
                + '        scheduleDeferredPagePresentation(\n'
                + '            message,\n'
                + '            renderGeneration,\n'
                + '            hasHtml || !!frame\n'
                + '        );\n'
                + '    }\n\n'
                + '    function postNavigation(type) {\n',
            '    }\n\n'
                + '    function postNavigation(type) {\n'
        );
    const previousViewerScriptWithoutAuxiliarySnapshots = previousViewerScript
        .replace(
            '        // A content-first Host load delivers restored side state later in a\n'
                + '        // same-generation, HTML-free refresh. These snapshots are still\n'
                + '        // authoritative and must update without resetting the transcript.\n'
                + '        if (message.bookmarks !== undefined\n'
                + "            && typeof outlineController.applyBookmarksSnapshot === 'function') {\n"
                + '            outlineController.applyBookmarksSnapshot(message.bookmarks);\n'
                + '        }\n'
                + '        if (message.comments !== undefined\n'
                + "            && typeof commentsController.applySnapshots === 'function') {\n"
                + '            commentsController.applySnapshots(\n'
                + '                message.comments,\n'
                + '                message.projectComments\n'
                + '            );\n'
                + '        }\n',
            ''
        )
        .replace(
            "        if (messages.querySelector('.conversation-deferred-messages')) {\n"
                + "            statusMessages.push('Loading earlier messages.');\n"
                + '        }\n',
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
        )
        .replace(
            '                applyBookmarksSnapshot(initialBookmarks);\n',
            '                state.bookmarkRevision = initialBookmarks.revision;\n'
                + '                state.bookmarkIds = new Set(initialBookmarks.interactionIds);\n'
                + '                renderBookmarkState();\n'
        )
        .replace(
            '\n        function applyBookmarksSnapshot(bookmarks) {\n'
                + '            if (!validBookmarkSnapshot(bookmarks)) return false;\n'
                + '            state.bookmarkRevision = bookmarks.revision;\n'
                + '            state.bookmarkIds = new Set(bookmarks.interactionIds);\n'
                + '            renderBookmarkState();\n'
                + '            if (sidebarUiAvailable) filterOutline();\n'
                + '            return true;\n'
                + '        }\n',
            ''
        )
        .replace(
            '            applyBookmarksSnapshot: applyBookmarksSnapshot,\n',
            ''
        );
    const sha256 = source => crypto.createHash('sha256')
        .update(source)
        .digest('hex');
    assert.equal(
        sha256(previousViewerScriptWithoutAuxiliarySnapshots),
        '12480eccea0518e9e134be1bd485460986570da5c7c5de9c46b3c89f0f281ab5',
        'the previous Viewer fixture must stay byte-exact'
    );
    assert.equal(
        sha256(previousOutlineScript),
        'bf9c914c932eb222ebbc2134d80c2625740fdd04ac3ee89ea0438b9941484c0c',
        'the previous Outline fixture must stay byte-exact'
    );
    const previousCommentsScript = fs.readFileSync(
        path.join(
            __dirname,
            'fixtures/previousConversationCommentsScripts.js'
        ),
        'utf8'
    );
    assert.equal(
        sha256(previousCommentsScript),
        'eae6747466b532101f8a9d2c6975ab43b10a681cb4891f4e76bcbf7830667faa',
        'the previous Comments fixture must stay byte-exact'
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

    const legacyCommentsDomErrors = [];
    const legacyCommentsDom = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageErrors: legacyCommentsDomErrors,
        viewerScriptSource: previousViewerScript,
        outlineScriptSource: previousOutlineScript,
        transformHostDocument(html) {
            return html.replace(
                /<div class="conversation-comments-tabs"[\s\S]*?<\/div>\s*<div class="conversation-comments-body"/,
                '<div class="conversation-comments-filter-bar" hidden></div>'
                    + '<div class="conversation-comments-body"'
            ).replace(/ data-comments-panel="(session|workspace)"/g, '');
        },
    });
    await assertPanelViews(legacyCommentsDom.page, 'legacy Comments DOM');
    assert.deepEqual(legacyCommentsDomErrors, []);

    const previousCommentsErrors = [];
    const previousComments = await openHostViewerDocument(t, {
        interactionIds: ['input-1'],
        interactionId: 'input-1',
        pageErrors: previousCommentsErrors,
        commentsScriptSource: previousCommentsScript,
    });
    await assertPanelViews(previousComments.page, 'previous Comments script');
    await previousComments.page.locator('[data-telemetry-comments]').click();
    await previousComments.page.locator(
        '[data-project-comments-header]'
            + ' [data-project-comment-action="open-composer"]'
    ).click();
    assert.equal(
        await previousComments.page
            .locator('[data-project-comment-composer]')
            .isVisible(),
        true,
        'the previous Comments script must keep Workspace capture usable'
    );
    assert.deepEqual(previousCommentsErrors, []);

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
            ).replace(
                /<div class="conversation-session-status"[\s\S]*?<\/div>/,
                '<div class="conversation-session-status"'
                    + ' data-conversation-session-status role="group"'
                    + ' aria-label="Global AI session status">'
                    + '<span class="conversation-session-status-dot'
                    + ' conversation-session-status-running"'
                    + ' data-session-status-running role="img"></span>'
                    + '<span class="conversation-session-status-count"'
                    + ' data-session-status-running-count>0/2</span>'
                    + '<span class="conversation-session-status-dot'
                    + ' conversation-session-status-attention"'
                    + ' data-session-status-attention role="img"></span>'
                    + '<span class="conversation-session-status-count"'
                    + ' data-session-status-attention-count>0/0</span>'
                    + '</div>'
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
    assert.equal(
        await previousDocument.page.locator('[data-session-status-idle]').count(),
        0,
        'the previous document fixture must not expose the idle status button'
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

    const renderedHtml = await renderHostViewerDocument();
    const initialPublication = decodeInitialPublication(renderedHtml);
    const { page } = await openHostViewerDocument(t, {
        initialWebviewState: {
            conversationCommentsPanel: {
                open: true,
                width: 240,
                view: 'comments',
            },
        },
        renderedHtml,
    });
    const [comments, bookmarks] = await Promise.all([
        commentStore.load(next),
        bookmarkStore.load(next),
    ]);
    await sendPage(page, {
        ...initialPublication,
        requestId: initialPublication.requestId + 1,
        updateKind: 'refresh',
        html: undefined,
        comments,
        bookmarks,
    });
    await page.locator('[data-comment-id="rebound-comment"]').waitFor();

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
            widthUserResized: true,
            changesWidthRecommendationApplied: false,
            changesSubTab: 'files',
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
            widthUserResized: true,
            changesWidthRecommendationApplied: false,
            changesSubTab: 'files',
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

test('WORKTREE-CHANGES-PANEL-001 recommends 320px once on the first Changes open', async t => {
    const options = {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 900, height: 600 },
    };

    // New state: the first explicit Changes open recommends 320px exactly
    // once and records that the recommendation was consumed (PRD §15.6).
    const first = await openHostViewerDocument(t, options);
    await sendChanges(first.page, changesFixture());
    await first.page.locator('[data-telemetry-changes]').click();
    assert.equal(
        await first.page.locator('[data-comments-resizer]')
            .getAttribute('aria-valuenow'),
        '320');
    assert.deepEqual(
        await first.page.evaluate(() =>
            window.__webviewState.conversationSidebar),
        {
            open: true,
            width: 320,
            view: 'changes',
            query: '',
            subagentsRunningOnly: false,
            widthUserResized: false,
            changesWidthRecommendationApplied: true,
            changesSubTab: 'files',
        }
    );

    // An explicit drag permanently wins over the recommendation.
    const resizer = first.page.locator('[data-comments-resizer]');
    const box = await resizer.boundingBox();
    await first.page.mouse.move(
        box.x + box.width / 2, box.y + box.height / 2);
    await first.page.mouse.down();
    await first.page.mouse.move(box.x + box.width / 2 - 40,
        box.y + box.height / 2);
    await first.page.mouse.up();
    const dragged = await first.page.evaluate(() =>
        window.__webviewState.conversationSidebar);
    assert.ok(dragged.width > 320 && dragged.width <= 370,
        `explicit drag widened the panel from 320 to ${dragged.width}`);
    assert.equal(dragged.widthUserResized, true);
    assert.equal(dragged.changesWidthRecommendationApplied, true);

    // Legacy state has neither explicit flag. It represents an existing
    // layout preference, so it must never receive the one-time nudge.
    const legacy = await openHostViewerDocument(t, {
        ...options,
        initialWebviewState: {
            conversationSidebar: {
                open: false,
                width: 240,
                view: 'changes',
                query: '',
                subagentsRunningOnly: false,
            },
        },
    });
    await sendChanges(legacy.page, changesFixture());
    await legacy.page.locator('[data-telemetry-changes]').click();
    assert.equal(
        await legacy.page.locator('[data-comments-resizer]')
            .getAttribute('aria-valuenow'),
        '240');
    const legacyState = await legacy.page.evaluate(() =>
        window.__webviewState.conversationSidebar);
    assert.equal('widthUserResized' in legacyState, false);
    assert.equal('changesWidthRecommendationApplied' in legacyState, false);

    // New-code state that was persisted before ever opening Changes still
    // consumes the recommendation when Changes first becomes visible.
    const deferred = await openHostViewerDocument(t, {
        ...options,
        initialWebviewState: {
            conversationSidebar: {
                open: false,
                width: 240,
                view: 'outline',
                query: '',
                subagentsRunningOnly: false,
                widthUserResized: false,
                changesWidthRecommendationApplied: false,
                changesSubTab: 'files',
            },
        },
    });
    await sendChanges(deferred.page, changesFixture());
    await deferred.page.locator('[data-telemetry-changes]').click();
    assert.equal(
        await deferred.page.locator('[data-comments-resizer]')
            .getAttribute('aria-valuenow'),
        '320');
    assert.equal(await deferred.page.evaluate(() =>
        window.__webviewState.conversationSidebar
            .changesWidthRecommendationApplied), true);
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
        '[data-session-comments-header] [data-comment-action="send"]'
    );
    const pill = page.locator('[data-telemetry-comments]');
    assert.equal(await toolbarSend.isDisabled(), true);
    assert.equal(await pill.isVisible(), true);
    assert.equal(await pill.innerText(), '0 · 0');

    await page.locator('[data-telemetry-comments]').click();
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
    await sendPage(page, commentSettlement(addRequest, [comment]));

    assert.equal(await toolbarSend.isDisabled(), false);
    assert.equal(
        await toolbarSend.getAttribute('title'),
        'Send 1 open comment to the session input'
    );
    assert.equal(await pill.isVisible(), true);
    assert.equal(await pill.innerText(), '1 · 0');

    await page.locator('[data-conversation-position]').click();
    await pill.click();
    assert.equal(
        await page.locator('[data-telemetry-comments]')
            .getAttribute('aria-pressed'),
        'true'
    );
    await toolbarSend.click();
    const sendRequest = (await postedMessages(page)).at(-1);
    assert.equal(sendRequest.type, 'conversation-viewer-send-comments');
    assert.equal(sendRequest.operation, 'sendComments');
});

function commentSettlement(request, comments, overrides = {}) {
    return {
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
        comments,
        ...overrides,
    };
}

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

test('CONVERSATION-COMMENTS-TABS-001 PROJECT-COMMENTS-UI-001 captures, tags, filters, and dispatches project notes', async t => {
    const interactionId = 'input-project-notes';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 700, height: 860 },
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationCommentsActiveTab: 'workspace',
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

    await page.locator('[data-telemetry-comments]').click();
    const projectSection = page.locator('[data-project-comments]');
    const projectHeader = page.locator('[data-project-comments-header]');
    const sessionTab = page.locator('[data-comments-tab="session"]');
    const workspaceTab = page.locator('[data-comments-tab="workspace"]');
    const sessionPane = page.locator('[data-comments-panel="session"]');
    const workspacePane = page.locator('[data-comments-panel="workspace"]');
    assert.equal(await projectSection.isVisible(), true);
    assert.equal(await workspacePane.isVisible(), true);
    assert.equal(await sessionPane.isVisible(), false);
    assert.equal(
        await workspaceTab.getAttribute('aria-selected'),
        'true'
    );
    assert.equal(await sessionTab.getAttribute('aria-selected'), 'false');
    assert.equal(await workspaceTab.getAttribute('aria-controls'), 'conversation-comments-pane-workspace');
    assert.equal(await workspacePane.getAttribute('aria-labelledby'), 'conversation-comments-tab-workspace');
    assert.equal(await workspaceTab.getAttribute('tabindex'), '0');
    assert.equal(await sessionTab.getAttribute('tabindex'), '-1');
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
    // Tags and the status chip live on their own row at the bottom of the
    // card, keeping the heading row to the drag handle + icon actions.
    assert.equal(
        await cards.first().evaluate(element =>
            element.lastElementChild.className
        ),
        'conversation-comment-tags-row'
    );
    assert.equal(
        await cards.first().locator(
            '[data-project-comment-action="toggle-status"]'
        ).innerText(),
        'Open'
    );
    assert.equal(await input.inputValue(), '');
    assert.equal(await composer.isVisible(), false);
    const filterChips = page.locator(
        '[data-comments-filter-bar] button'
    );
    assert.deepEqual(
        await filterChips.allInnerTexts(),
        ['All · 1', 'Open · 1', 'Done · 0', 'bug · 1']
    );
    assert.deepEqual(
        await page.evaluate(() => {
            const headerElement = document.querySelector(
                '[data-project-comments-header]'
            );
            const header = headerElement.getBoundingClientRect();
            const filter = document.querySelector(
                '[data-comments-filter-bar]'
            ).getBoundingClientRect();
            const card = document.querySelector(
                '[data-project-comment-id]'
            ).getBoundingClientRect();
            const toolbarButtons = Array.from(headerElement.querySelectorAll(
                'button'
            )).map(button => button.getBoundingClientRect());
            const panel = document.querySelector(
                '[data-conversation-comments]'
            ).getBoundingClientRect();
            return {
                toolbarEdgesFlush:
                    Math.abs(header.left - panel.left) <= 1
                    && Math.abs(header.right - panel.right) <= 1,
                toolbarButtonsInset:
                    toolbarButtons[0].left >= header.left + 6
                    && toolbarButtons.at(-1).right
                        <= header.right - 6,
                toolbarWiderThanCards: header.left < card.left - 1
                    && header.right > card.right + 1,
                filterPinnedBelowCards:
                    filter.top >= card.bottom
                    && Math.abs(filter.bottom - panel.bottom) <= 1,
            };
        }),
        {
            toolbarEdgesFlush: true,
            toolbarButtonsInset: true,
            toolbarWiderThanCards: true,
            filterPinnedBelowCards: true,
        }
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
        projectCommentSettlement(addSecond, [noteTwo, noteOne], {
            revision: 2,
        })
    );
    assert.equal(await cards.count(), 2);
    assert.equal(
        await cards.first().getAttribute('data-project-comment-id'),
        'note-2'
    );

    // Tab labels carry the same live open counts as the telemetry pill.
    assert.equal(
        await workspaceTab.locator('[data-comments-tab-count]').innerText(),
        '· 2'
    );
    assert.equal(
        await sessionTab.locator('[data-comments-tab-count]').innerText(),
        '· 0'
    );

    // Tag filtering narrows the list and toggles back off.
    await filterChips.nth(3).click();
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
            noteTwo,
            {
                ...noteOne,
                dispatches: [{
                    provider: 'codex',
                    sessionId: 'session-host-document',
                    at: 3000,
                }],
            },
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
            '[data-project-comment-action="toggle-status"]'
        ).innerText(),
        'Open'
    );

    const dispatchedNoteOne = {
        ...noteOne,
        dispatches: [{
            provider: 'codex',
            sessionId: 'session-host-document',
            at: 3000,
        }],
    };

    // Workspace cards reorder by drag, persisting through the Host. The
    // drop lands on the lower half of the target body so it counts as an
    // 'after' placement.
    const noteOneCard = projectSection
        .locator('[data-project-comment-id="note-1"]');
    const noteOneCardBox = await noteOneCard.boundingBox();
    await projectSection.locator('[data-project-comment-id="note-2"]')
        .locator('[data-project-comment-drag-handle]')
        .dragTo(noteOneCard, {
            targetPosition: {
                x: Math.floor(noteOneCardBox.width / 2),
                y: Math.max(1, Math.floor(noteOneCardBox.height) - 6),
            },
        });
    const reorderRequest = (await postedMessages(page)).at(-1);
    assert.equal(
        reorderRequest.type,
        'conversation-viewer-project-comment-mutation'
    );
    assert.equal(reorderRequest.operation, 'reorder');
    assert.deepEqual(reorderRequest.payload, {
        orderedCommentIds: ['note-1', 'note-2'],
    });
    await sendPage(page, projectCommentSettlement(
        reorderRequest,
        [dispatchedNoteOne, noteTwo],
        { revision: 4 }
    ));
    assert.equal(
        await cards.first().getAttribute('data-project-comment-id'),
        'note-1'
    );

    // Alt+ArrowDown on the drag handle moves a card down one position.
    await projectSection.locator('[data-project-comment-id="note-1"]')
        .locator('[data-project-comment-drag-handle]')
        .focus();
    await page.keyboard.press('Alt+ArrowDown');
    const keyboardReorder = (await postedMessages(page)).at(-1);
    assert.equal(keyboardReorder.operation, 'reorder');
    assert.deepEqual(keyboardReorder.payload, {
        orderedCommentIds: ['note-2', 'note-1'],
    });
    await sendPage(page, projectCommentSettlement(
        keyboardReorder,
        [noteTwo, dispatchedNoteOne],
        { revision: 5 }
    ));
    assert.equal(
        await cards.first().getAttribute('data-project-comment-id'),
        'note-2'
    );

    // The Workspace header sends every open note with one click.
    await projectHeader.locator(
        '[data-project-comment-action="send-all"]'
    ).click();
    const sendAllRequest = (await postedMessages(page)).at(-1);
    assert.equal(
        sendAllRequest.type,
        'conversation-viewer-send-project-comment'
    );
    assert.equal(sendAllRequest.operation, 'sendProjectComments');
    assert.deepEqual(sendAllRequest.payload, {});
    await sendPage(page, projectCommentSettlement(
        sendAllRequest,
        [
            {
                ...noteTwo,
                dispatches: [{
                    provider: 'codex',
                    sessionId: 'session-host-document',
                    at: 4000,
                }],
            },
            {
                ...dispatchedNoteOne,
                dispatches: [
                    ...dispatchedNoteOne.dispatches,
                    {
                        provider: 'codex',
                        sessionId: 'session-host-document',
                        at: 4000,
                    },
                ],
            },
        ],
        { revision: 6 }
    ));
    // Tabs own the full panel height; switching is keyboard-accessible and
    // persisted independently from either stack's filter.
    await sessionTab.click();
    assert.equal(await sessionPane.isVisible(), true);
    assert.equal(await workspacePane.isVisible(), false);
    assert.equal(
        await sessionTab.locator('[data-comments-tab-count]').innerText(),
        '· 0'
    );
    assert.equal(
        await page.evaluate(() =>
            window.__webviewState.conversationCommentsActiveTab
        ),
        'session'
    );
    await sessionTab.press('ArrowRight');
    assert.equal(await workspacePane.isVisible(), true);
    assert.equal(
        await page.evaluate(() => document.activeElement),
        await workspaceTab.evaluate(element => element)
    );
    await workspaceTab.press('Home');
    assert.equal(await sessionPane.isVisible(), true);
    assert.equal(
        await page.evaluate(() => document.activeElement),
        await sessionTab.evaluate(element => element)
    );
});

test('PROJECT-COMMENTS-UI-001 keeps the workspace composer fully visible when the group is full', async t => {
    const interactionId = 'input-project-notes-full-group';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 700, height: 860 },
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationCommentsActiveTab: 'workspace',
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

    await page.locator('[data-telemetry-comments]').click();
    const projectSection = page.locator('[data-project-comments]');
    const projectHeader = page.locator('[data-project-comments-header]');

    // Capture one note so the Host settlement can seed a group whose card
    // list is taller than the region the group is allowed to occupy.
    await projectHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    const input = projectSection.locator('[data-project-comment-input]');
    await input.fill('seed');
    await input.press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    const notes = Array.from({ length: 16 }, (_, index) => ({
        id: `note-${index + 1}`,
        text: `Workspace note ${index + 1} with enough text to wrap onto a second line inside the narrow sidebar`,
        tags: [],
        status: 'open',
        createdAt: 1000 + index,
        dispatches: [],
    }));
    await sendPage(page, projectCommentSettlement(addRequest, notes));
    assert.equal(
        await projectSection.locator('[data-project-comment-id]').count(),
        16
    );

    // Reopening the composer in the full group must keep its whole form
    // (label, textarea, actions row) rendered at full height at the top of
    // the group; the overflowing card list scrolls underneath it instead of
    // flex-shrinking the composer into a clipped sliver.
    await projectHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    assert.deepEqual(
        await page.evaluate(() => {
            const section = document.querySelector(
                '[data-project-comments-content]'
            );
            const composer = document.querySelector(
                '[data-project-comment-composer]'
            );
            const actions = composer.querySelector(
                '.conversation-comment-actions'
            );
            const firstCard = document.querySelector(
                '[data-project-comment-id]'
            );
            const sectionBounds = section.getBoundingClientRect();
            const composerBounds = composer.getBoundingClientRect();
            const actionsBounds = actions.getBoundingClientRect();
            const firstCardBounds = firstCard.getBoundingClientRect();
            return {
                groupOverflows:
                    section.scrollHeight > section.clientHeight,
                contentUnclipped:
                    composer.scrollHeight <= composer.clientHeight,
                actionsContained:
                    actionsBounds.top >= composerBounds.top
                    && actionsBounds.bottom <= composerBounds.bottom,
                composerInsideGroup:
                    composerBounds.top >= sectionBounds.top
                    && composerBounds.bottom <= sectionBounds.bottom,
                clearOfFirstCard:
                    composerBounds.bottom <= firstCardBounds.top,
            };
        }),
        {
            groupOverflows: true,
            contentUnclipped: true,
            actionsContained: true,
            composerInsideGroup: true,
            clearOfFirstCard: true,
        }
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
            conversationCommentsActiveTab: 'workspace',
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
    await card.locator('[data-project-comment-action="toggle-status"]').click();
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
        await page.locator('[data-comments-tab="workspace"]')
            .locator('[data-comments-tab-count]').innerText(),
        '· 0'
    );
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
    await card.locator('[data-project-comment-action="toggle-status"]').click();
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

    // The Workspace header sweeps done notes with clear-done.
    const workspaceHeader = page.locator('[data-project-comments-header]');
    await workspaceHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    await projectSection.locator('[data-project-comment-input]')
        .fill('会被清扫的已完成笔记');
    await projectSection.locator('[data-project-comment-action="add"]')
        .click();
    const readdRequest = (await postedMessages(page)).at(-1);
    const doneNote = {
        id: 'note-2',
        text: '会被清扫的已完成笔记',
        tags: [],
        status: 'done',
        createdAt: 3000,
        doneAt: 4000,
        dispatches: [],
    };
    await sendPage(page, projectCommentSettlement(
        readdRequest,
        [doneNote],
        { revision: 8 }
    ));
    await workspaceHeader.locator(
        '[data-project-comment-action="clear-done"]'
    ).click();
    const clearDoneRequest = (await postedMessages(page)).at(-1);
    assert.equal(clearDoneRequest.operation, 'clearDone');
    assert.deepEqual(clearDoneRequest.payload, {});
    await sendPage(page, projectCommentSettlement(
        clearDoneRequest,
        [],
        { revision: 9 }
    ));
    assert.equal(
        await projectSection.locator('[data-project-comment-id]').count(),
        0
    );

    // Clear-all on the Workspace header asks for a confirming second click.
    await workspaceHeader.locator(
        '[data-project-comment-action="open-composer"]'
    ).click();
    await projectSection.locator('[data-project-comment-input]')
        .fill('等着被清空的笔记');
    await projectSection.locator('[data-project-comment-action="add"]')
        .click();
    const readdSecond = (await postedMessages(page)).at(-1);
    await sendPage(page, projectCommentSettlement(
        readdSecond,
        [{
            id: 'note-3',
            text: '等着被清空的笔记',
            tags: [],
            status: 'open',
            createdAt: 5000,
            dispatches: [],
        }],
        { revision: 10 }
    ));
    const clearAll = workspaceHeader.locator(
        '[data-project-comment-action="clear-all"]'
    );
    await clearAll.click();
    assert.equal(await clearAll.getAttribute('data-confirming'), 'true');
    assert.equal(
        (await postedMessages(page)).at(-1).requestId,
        readdSecond.requestId,
        'the first clear-all click must not post a mutation'
    );
    await clearAll.click();
    const clearAllRequest = (await postedMessages(page)).at(-1);
    assert.equal(clearAllRequest.operation, 'clearAll');
    assert.deepEqual(clearAllRequest.payload, {});
    await sendPage(page, projectCommentSettlement(
        clearAllRequest,
        [],
        { revision: 11 }
    ));
    assert.equal(
        await projectSection.locator('[data-project-comment-id]').count(),
        0
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
    await sendPage(page, commentSettlement(request, [comment]));

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
        viewport: { width: 850, height: 1000 },
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
        await sendPage(page, commentSettlement(
            request,
            authoritativeComments,
            {
                revision,
                ...(success ? {} : { success: false, error: 'failed' }),
            }
        ));
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

    const thirdCard = page.locator('[data-comment-id="comment-third"]');
    const thirdCardBox = await thirdCard.boundingBox();
    await page.locator('[data-comment-id="comment-first"]')
        .locator('[data-comment-drag-handle]')
        .dragTo(
            thirdCard,
            {
                targetPosition: {
                    x: Math.floor(thirdCardBox.width / 2),
                    y: Math.max(1, Math.floor(thirdCardBox.height) - 6),
                },
            }
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

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 OPEN-WINDOW-CYCLE-RAILS-001 renders ghost window-switch rails that post exact switch intents', async t => {
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
                label: 'Previous window',
                iconOnly: true,
            },
            {
                direction: 'next',
                label: 'Next window',
                iconOnly: true,
            },
        ],
        'window rails must be two icon-only buttons'
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
        'window rails must render as compact translucent circles'
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
    ), '1', 'window rails must become fully opaque on hover');

    await next.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-switch-window',
        version: 1,
        direction: 'next',
    });
    await page.locator('[data-session-nav="previous"]').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-switch-window',
        version: 1,
        direction: 'previous',
    });
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 OPEN-WINDOW-CYCLE-RAILS-001 keeps window rails inside the conversation column when the side panel is open', async t => {
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
        await sendPage(page, commentSettlement(request, comments, {
            revision,
        }));
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
        await selectionBubble.locator('button:not([hidden])').evaluateAll(buttons =>
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
        await selectionBubble.locator('button:not([hidden])').evaluateAll(buttons =>
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

    // Read mode renders the full comment without a textarea; short
    // comments stay unclamped (no clamp class, no toggle).
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
        await body.evaluate(element =>
            element.classList.contains('is-clamped')
        ),
        false,
        'short comments must not be clamped'
    );
    assert.equal(
        await card.locator('[data-comment-clamp-toggle]').count(),
        0,
        'short comments never render a clamp toggle'
    );
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
    await sendPage(page, commentSettlement(failedUpdate, comments, {
        success: false,
        revision: 2,
        error: 'failed',
    }));
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
        await card.locator('[data-comment-status-chip]').textContent(),
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
        await card.locator('[data-comment-status-chip]').textContent(),
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
    await sendPage(page, commentSettlement(
        addRequest,
        [{ ...comment, quote: '   ' }]
    ));
    assert.equal(
        await page.locator('[data-conversation-comments]')
            .getAttribute('aria-busy'),
        'true',
        'a whitespace-only quote settlement must be rejected'
    );
    await sendPage(page, commentSettlement(addRequest, [comment]));

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
        await sendPage(page, commentSettlement(request, comments, {
            revision,
            ...(operation ? { operation } : {}),
        }));
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

    // The group actions live in the Session header as one row of three
    // icon buttons: send, clear done, clear all.
    const toolbar = page.locator('[data-session-comments-header]');
    assert.equal(await toolbar.locator('[data-comment-action]').count(), 4);
    assert.deepEqual(
        (await toolbar.locator('[data-comment-action]').evaluateAll(buttons =>
            Array.from(new Set(buttons.map(button =>
                Math.round(button.getBoundingClientRect().top)
            )))
        )).length,
        1,
        'session header buttons must share a single row'
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

    // Telemetry pill reports session · workspace open counts.
    assert.equal(
        await page.locator('[data-telemetry-comments]').innerText(),
        '2 · 0'
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
    assert.deepEqual(
        await page.evaluate(() =>
            window.__webviewState.conversationCommentsPanelFilter
        ),
        {
            session: { type: 'status', value: 'done' },
            workspace: null,
        }
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
    await page.locator(
        '[data-session-comments-header] [data-comment-action="send"]'
    )
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
        '0 · 0'
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
    await page.evaluate(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
    ));
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
        '0 · 0'
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
        await sendPage(page, commentSettlement(request, comments, {
            revision,
        }));
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
        '2 · 0',
        'the telemetry pill carries the session · workspace open counts'
    );
    const commentToolbar = page.locator('[data-session-comments-header]');
    assert.equal(await commentToolbar.count(), 1);
    assert.equal(
        await commentToolbar.locator('[data-comment-action]').count(),
        4
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
        await page.locator(
            '[data-comment-id] [data-comment-status-chip]'
        ).allTextContents(),
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
        '1 · 0',
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
        await page.locator(
            '[data-comment-id] [data-comment-status-chip]'
        ).allTextContents(),
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

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 keeps plan and question cards visible when completed-turn work collapses', async t => {
    const page = await openViewerPage(t, {});
    const turnHtml = `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Refactor the parser</p></section>
    </article>`
        + `<article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle">
            <span class="conversation-worklog-label">Worked for 12s</span>
        </button>
    </article>`
        + `<article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <details class="conversation-tool-call">
            <summary><span class="conversation-tool-name">Shell</span> Shell ls</summary>
            <pre class="conversation-tool-detail"><code>out</code></pre>
        </details>
    </article>`
        + `<article class="conversation-message conversation-message-plan"
            data-message-id="input-4:plan:0"
            data-conversation-message-id="input-4%3Aplan%3A0"
            data-interaction-id="input-4">
        <section class="conversation-plan">
            <section class="conversation-plan-header">
                <span class="conversation-plan-label">Plan</span>
                <span class="conversation-plan-path">/plans/rollout.md</span>
            </section>
            <section class="conversation-markdown"><h1>Rollout Plan</h1></section>
        </section>
    </article>`
        + `<article class="conversation-message conversation-message-question"
            data-message-id="input-4:question:0"
            data-conversation-message-id="input-4%3Aquestion%3A0"
            data-interaction-id="input-4">
        <section class="conversation-question">
            <section class="conversation-question-top">
                <span class="conversation-question-source">Plan approval</span>
                <span class="conversation-question-outcome conversation-question-outcome-approved">Approved</span>
            </section>
            <section class="conversation-question-item">
                <section class="conversation-question-title">
                    <span class="conversation-question-header">Plan</span>
                    <span class="conversation-question-text">Approve this plan</span>
                </section>
                <ul class="conversation-question-options">
                    <li class="conversation-question-option conversation-question-option-selected">
                        <span class="conversation-question-option-check">\u2713</span>
                        <span class="conversation-question-option-label">Full refactor</span>
                    </li>
                    <li class="conversation-question-option">
                        <span class="conversation-question-option-check"></span>
                        <span class="conversation-question-option-label">Reject</span>
                    </li>
                </ul>
            </section>
        </section>
    </article>`
        + `<article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>On it.</p></section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 60,
        updateKind: 'initial',
        html: turnHtml,
    });

    assert.equal(
        await page.locator('.conversation-message-tool').isHidden(),
        true,
        'completed-turn tool work starts collapsed'
    );
    const plan = page.locator('.conversation-message-plan');
    const question = page.locator('.conversation-message-question');
    assert.equal(await plan.isVisible(), true, 'plan stays visible');
    assert.equal(await question.isVisible(), true, 'question stays visible');
    assert.match(await plan.innerText(), /Rollout Plan/);
    assert.match(await question.innerText(), /Approve this plan/);
    assert.match(await question.innerText(), /Approved/);
    assert.equal(
        await page.locator('.conversation-question-option-selected').count(),
        1,
        'the settled option survives sanitizing'
    );

    await page.locator('.conversation-worklog-toggle').click();
    assert.equal(
        await page.locator('.conversation-message-tool').isVisible(),
        true,
        'expanding the worklog reveals tool work'
    );
    assert.equal(await plan.isVisible(), true, 'plan stays put');
    assert.equal(await question.isVisible(), true, 'question stays put');
});

test('CONVERSATION-DIFF-VISIBILITY-001 renders diff cards with sanitized markup inside the collapsible tool entry', async t => {
    const page = await openViewerPage(t, {});
    await page.addStyleTag({ content: viewerCss });
    const toolArticle = `<article class="conversation-message conversation-message-tool"
            data-message-id="input-4:tool:0"
            data-conversation-message-id="input-4%3Atool%3A0"
            data-interaction-id="input-4">
        <details class="conversation-tool-call">
            <summary><span class="conversation-tool-name">fileChange</span> fileChange update src/a.ts <span class="conversation-diff-totals"><span class="conversation-diff-count-add">+1</span> <span class="conversation-diff-count-del">−1</span></span></summary>
            <section class="conversation-diff">
                <section class="conversation-diff-file">
                    <section class="conversation-diff-file-header">
                        <span class="conversation-diff-path" onclick="window.__pwned = true">src/a.ts</span>
                        <span class="conversation-diff-kind conversation-diff-kind-update">update</span>
                        <span class="conversation-diff-counts"><span class="conversation-diff-count-add">+1</span> <span class="conversation-diff-count-del">−1</span></span>
                    </section>
                    <pre class="conversation-diff-hunks"><code><span class="conversation-diff-line conversation-diff-line-hunk">@@ -3 +3 @@</span><span class="conversation-diff-line conversation-diff-line-del">-const a = 1;</span><span class="conversation-diff-line conversation-diff-line-add">+const a = 2;</span></code></pre>
                </section>
            </section>
        </details>
    </article>`;
    const turnHtml = `<article class="conversation-message conversation-message-user"
            data-message-id="input-4:user"
            data-conversation-message-id="input-4%3Auser"
            data-interaction-id="input-4">
        <span class="conversation-role">User</span>
        <section class="conversation-markdown"><p>Apply the patch</p></section>
    </article>`
        + `<article class="conversation-message conversation-message-worklog"
            data-message-id="input-4:worklog"
            data-conversation-message-id="input-4%3Aworklog"
            data-interaction-id="input-4">
        <button class="conversation-worklog-toggle">
            <span class="conversation-worklog-label">Worked for 3s</span>
        </button>
    </article>`
        + toolArticle
        + `<article class="conversation-message conversation-message-assistant"
            data-message-id="input-4:assistant:0"
            data-conversation-message-id="input-4%3Aassistant%3A0"
            data-interaction-id="input-4">
        <span class="conversation-role">Assistant</span>
        <section class="conversation-markdown"><p>Done.</p></section>
    </article>`;
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 60,
        updateKind: 'initial',
        html: turnHtml,
    });

    const tool = page.locator('.conversation-message-tool');
    assert.equal(await tool.isHidden(), true, 'tool work starts collapsed');
    await page.locator('.conversation-worklog-toggle').click();
    assert.equal(await tool.isVisible(), true, 'expanding reveals the diff entry');

    const path = page.locator('.conversation-diff-path');
    assert.equal(await path.count(), 1, 'diff path survives sanitizing');
    assert.equal(
        await path.evaluate(element => element.hasAttribute('onclick')),
        false,
        'event handlers are stripped from diff markup'
    );
    const addLine = page.locator('.conversation-diff-line-add');
    assert.equal(await addLine.count(), 1);
    // The diff lives inside a closed <details> until the user expands it.
    const details = page.locator('details.conversation-tool-call');
    assert.equal(await details.evaluate(element => element.open), false);
    await page.locator('.conversation-tool-call summary').click();
    assert.equal(await details.evaluate(element => element.open), true);
    assert.equal(await addLine.isVisible(), true);
    assert.match(await addLine.innerText(), /\+const a = 2;/);
    assert.match(
        await page.locator('.conversation-diff-line-hunk').innerText(),
        /@@ -3 \+3 @@/
    );
    const addStyle = await addLine.evaluate(element => {
        const style = getComputedStyle(element);
        return {
            color: style.color,
            background: style.backgroundColor,
            borderLeft: style.borderLeftColor,
        };
    });
    const delStyle = await page.locator('.conversation-diff-line-del')
        .evaluate(element => {
            const style = getComputedStyle(element);
            return {
                color: style.color,
                background: style.backgroundColor,
                borderLeft: style.borderLeftColor,
            };
        });
    assert.notEqual(
        addStyle.color,
        'rgba(0, 0, 0, 0)',
        'added lines get visible text color'
    );
    assert.notEqual(
        addStyle.borderLeft,
        'rgba(0, 0, 0, 0)',
        'added lines get an accent bar'
    );
    assert.notEqual(
        addStyle.color,
        delStyle.color,
        'add and del lines use different colors'
    );
    assert.notEqual(
        addStyle.background,
        delStyle.background,
        'add and del lines use different backgrounds'
    );
    const preText = await page.locator('.conversation-diff-hunks code')
        .evaluate(element => element.textContent);
    assert.equal(
        /\n/.test(preText),
        false,
        'block diff lines must not carry newline text nodes (blank lines)'
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
        const textNode = code.firstChild;
        const indentStart = textNode.nodeValue.indexOf('\n  sourceKind') + 1;
        const indentRange = new Range();
        indentRange.setStart(textNode, indentStart);
        indentRange.setEnd(textNode, indentStart + 2);
        const charRange = new Range();
        charRange.setStart(textNode, indentStart + 2);
        charRange.setEnd(textNode, indentStart + 3);
        const preStyle = getComputedStyle(pre);
        const codeStyle = getComputedStyle(code);
        return {
            text: code.textContent,
            indentation: indentRange.getBoundingClientRect().width,
            characterWidth: charRange.getBoundingClientRect().width,
            guideSpans: code.querySelectorAll('.conversation-code-indent')
                .length,
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
    assert.equal(presentation.guideSpans, 0,
        'reading surfaces render no indent guide markup');
    assert.ok(
        presentation.indentation >= presentation.characterWidth * 1.75
            && presentation.indentation <= presentation.characterWidth * 2.25,
        'two source spaces render as two columns'
    );
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

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 renders protobuf indentation at source width without guide markup', async t => {
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
    assert.equal(
        await code.locator('.conversation-code-indent').count(),
        0,
        'reading surfaces render no indent guide markup'
    );
    const presentation = await code.evaluate(element => {
        const textNode = element.firstChild;
        const start = textNode.nodeValue.indexOf('\n  rpc') + 1;
        const indentRange = new Range();
        indentRange.setStart(textNode, start);
        indentRange.setEnd(textNode, start + 2);
        const charRange = new Range();
        charRange.setStart(textNode, start + 2);
        charRange.setEnd(textNode, start + 3);
        return {
            width: indentRange.getBoundingClientRect().width,
            characterWidth: charRange.getBoundingClientRect().width,
        };
    });
    assert.ok(
        presentation.width >= presentation.characterWidth * 1.75
            && presentation.width <= presentation.characterWidth * 2.25,
        'two source spaces render as two columns'
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-CODE-HIGHLIGHT-001 renders highlighted code at source width without guide markup', async t => {
    const page = await openViewerPage(t);
    await page.addStyleTag({ content: viewerCss });
    const source = 'def foo():\n    if x:\n        print(x)';
    await sendPage(page, {
        ...hostileConversationPage,
        html: `<article data-message-id="highlighted-code"
            data-interaction-id="input-4">
            <section class="conversation-markdown">
                <section class="conversation-code-block">
                    <pre><code class="hljs language-python"><span class="hljs-keyword">def</span> foo():
    <span class="hljs-keyword">if</span> x:
        print(x)</code></pre>
                </section>
            </section>
        </article>`,
    });

    const code = page.locator('pre > code.language-python');
    assert.equal(await code.textContent(), source);
    assert.equal(
        await code.locator('.conversation-code-indent').count(),
        0,
        'no indent guide spans decorate or rewrite highlighted code'
    );
    assert.ok(
        await code.locator('.hljs-keyword').count() >= 2,
        'hljs keyword spans render untouched'
    );
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

    // Warm frame restore: switching away stashes the built DOM; switching
    // back with the same content token reattaches it within budget.
    const switchPage = (generation, sessionId, signature, htmlValue) => {
        const message = {
            ...hostileConversationPage,
            requestId: generation * 10,
            subscriptionGeneration: generation,
            updateKind: 'initial',
            outline: [{
                interactionId: `${sessionId}-input`,
                userPreview: sessionId,
                responseState: 'complete',
            }],
            selectedInteractionId: `${sessionId}-input`,
            selectedInput: 1,
            totalInputs: 1,
            previousCursor: undefined,
            nextCursor: undefined,
            target: {
                projectId: 'project-1',
                provider: 'codex',
                sessionId,
                interactionId: `${sessionId}-input`,
                displayName: sessionId,
            },
            comments: { revision: 0, comments: [] },
            projectComments: { revision: 0, comments: [] },
            bookmarks: { revision: 0, interactionIds: [] },
            htmlSignature: signature,
        };
        if (htmlValue !== undefined) {
            message.html = htmlValue;
        } else {
            delete message.html;
            message.restoreFrame = true;
        }
        return message;
    };
    await measurePublication({
        ...switchPage(2, 'warm-a', 'sig-warm-a1', initialHtml),
        requestId: 20,
    });
    // Switch away: the large page's frame is stashed.
    await measurePublication(
        switchPage(3, 'warm-b', 'sig-warm-b1', largeMessageHtml(2, 200))
    );
    const restoreMs = await measurePublication(
        switchPage(4, 'warm-a', 'sig-warm-a1', undefined)
    );
    assert.ok(
        restoreMs <= conversationPerformanceBudgets.webviewWarmFrameRestoreMs,
        `warm frame restore ${restoreMs}ms exceeds `
            + `${conversationPerformanceBudgets.webviewWarmFrameRestoreMs}ms`
    );
    assert.equal(
        await page.locator('[data-conversation-messages] > article').count(),
        100,
        'the restored frame brings back the full session DOM'
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

test('CONVERSATION-VIEWER-BROWSER-NAVIGATION-002 anchors and focuses the Host-selected interaction after navigation or document recovery', async t => {
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

    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 3,
        updateKind: 'initial',
        html,
        outline: Array.from({ length: 6 }, (_, index) => ({
            interactionId: `selected-${index}`,
            userPreview: `Selected input ${index + 1}`,
            responseState: 'complete',
        })),
        selectedInteractionId: 'selected-4',
        selectedInput: 5,
        restoreFocus: true,
    });
    assert.equal(await page.evaluate(() =>
        document.activeElement
            && document.activeElement.getAttribute('data-interaction-id')
    ), 'selected-4',
    'a recovered document returns focus to the selected interaction');
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
    assert.equal(await page.locator('[data-conversation-workspace-name]').innerText(), 'Test Workspace');
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
        await page.waitForFunction(requestId => window.__postedMessages.some(
            message => message.type === 'conversation-viewer-applied'
                && message.requestId === requestId
        ), publications.initial.requestId);
        const scroll = page.locator('[data-conversation-scroll]');
        await scroll.evaluate((element, offset) => {
            element.scrollTop = element.scrollHeight
                - element.clientHeight
                - offset;
        }, distance);
        const before = await scroll.evaluate(element => element.scrollTop);

        await sendPage(page, publications.refresh);
        await page.waitForFunction(requestId => window.__postedMessages.some(
            message => message.type === 'conversation-viewer-applied'
                && message.requestId === requestId
        ), publications.refresh.requestId);

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
    await page.locator('[data-telemetry-subagents]').click();
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
            await page.locator('[data-telemetry-provider]').getAttribute('data-provider'),
            fixture.provider
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

test('CONVERSATION-SESSION-STATUS-001 renders clickable reduced-motion-safe local Session status buttons in the bottom session-navigation row', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        readSessionStatus: () => ({
            runningSessions: 2,
            attentionSessions: 1,
            runningSessionsLocal: 1,
            attentionSessionsLocal: 1,
            idleSessionsLocal: 2,
        }),
    });
    const running = page.locator('[data-session-status-running]');
    const attention = page.locator('[data-session-status-attention]');
    const idle = page.locator('[data-session-status-idle]');
    const runningCount = page.locator('[data-session-status-running-count]');
    const attentionCount = page.locator(
        '[data-session-status-attention-count]'
    );
    const idleCount = page.locator('[data-session-status-idle-count]');

    assert.deepEqual(
        await page.locator('[data-conversation-session-status] button').evaluateAll(
            elements => elements.map(element => element.getAttribute('data-session-status-cycle'))
        ),
        ['attention', 'running', 'idle'],
        'the bottom status buttons prioritize attention before running and idle'
    );

    assert.equal(
        await running.getAttribute('title'),
        '1 running in this window · click to switch to the next'
    );
    assert.equal(await runningCount.textContent(), '1');
    assert.equal(await attentionCount.textContent(), '1');
    assert.equal(await idleCount.textContent(), '2');
    assert.equal(
        await attention.getAttribute('aria-label'),
        '1 need attention in this window · click to switch to the next'
    );
    assert.equal(
        await idle.getAttribute('title'),
        '2 idle in this window · click to switch to the next'
    );
    assert.equal(await running.evaluate(element =>
        element.classList.contains('conversation-session-status-active')
    ), true);
    assert.equal(await idle.evaluate(element =>
        element.classList.contains('conversation-session-status-active')
    ), false, 'idle sessions never pulse');
    assert.equal(await running.evaluate(element => element.disabled), false);
    assert.notEqual(await running.evaluate(element =>
        getComputedStyle(element).animationName
    ), 'none');

    // Clicking a status button submits the local cycle intent for its kind.
    const cycleIntents = async () => (await postedMessages(page))
        .filter(message =>
            message.type === 'conversation-viewer-cycle-status-session'
        );
    await attention.click();
    await idle.click();
    assert.deepEqual(await cycleIntents(), [
        {
            type: 'conversation-viewer-cycle-status-session',
            version: 1,
            kind: 'attention',
        },
        {
            type: 'conversation-viewer-cycle-status-session',
            version: 1,
            kind: 'idle',
        },
    ]);

    const correlation = await page.evaluate(() => ({
        generation: Number(document.body.getAttribute(
            'data-subscription-generation'
        )),
        requestId: Number(document.body.getAttribute(
            'data-session-status-request-id'
        )),
    }));
    await sendPage(page, {
        type: 'conversation-viewer-session-status',
        version: 1,
        requestId: correlation.requestId,
        subscriptionGeneration: correlation.generation,
        status: {
            runningSessions: 0,
            attentionSessions: 3,
            runningSessionsLocal: 0,
            attentionSessionsLocal: 3,
            idleSessionsLocal: 0,
        },
    });
    assert.equal(
        await running.getAttribute('title'),
        'No AI sessions running in this window'
    );
    assert.equal(await runningCount.textContent(), '0');
    assert.equal(
        await running.evaluate(element => element.disabled),
        true,
        'an empty kind disables its button'
    );
    assert.equal(await running.evaluate(element =>
        element.classList.contains('conversation-session-status-active')
    ), false);
    assert.equal(
        await attention.getAttribute('title'),
        '3 need attention in this window · click to switch to the next'
    );
    assert.equal(await attentionCount.textContent(), '3');
    assert.equal(await idleCount.textContent(), '0');
    assert.equal(await idle.evaluate(element => element.disabled), true);

    // A disabled button never emits another cycle intent.
    await page.evaluate(() => {
        document.querySelector('[data-session-status-running]').click();
    });
    assert.equal((await cycleIntents()).length, 2);

    await sendPage(page, {
        type: 'conversation-viewer-session-status',
        version: 1,
        requestId: correlation.requestId - 1,
        subscriptionGeneration: correlation.generation,
        status: {
            runningSessions: 9,
            attentionSessions: 9,
            runningSessionsLocal: 9,
            attentionSessionsLocal: 9,
            idleSessionsLocal: 9,
        },
    });
    await sendPage(page, {
        type: 'conversation-viewer-session-status',
        version: 1,
        requestId: correlation.requestId + 1,
        subscriptionGeneration: correlation.generation + 1,
        status: {
            runningSessions: 9,
            attentionSessions: 9,
            runningSessionsLocal: 9,
            attentionSessionsLocal: 9,
            idleSessionsLocal: 9,
        },
    });
    assert.equal(
        await attention.getAttribute('title'),
        '3 need attention in this window · click to switch to the next',
        'stale requestIds and foreign generations must be ignored'
    );

    const layout = await page.evaluate(() => {
        const layer = document.querySelector(
            '.conversation-session-nav-layer'
        ).getBoundingClientRect();
        const statusGroup = document.querySelector(
            '[data-conversation-session-status]'
        ).getBoundingClientRect();
        const navPrevious = document.querySelector(
            '[data-session-nav="previous"]'
        ).getBoundingClientRect();
        return {
            centered: Math.abs(
                (statusGroup.left + statusGroup.width / 2)
                    - (layer.left + layer.width / 2)
            ) <= 2,
            sameRow: Math.abs(
                (statusGroup.top + statusGroup.height / 2)
                    - (navPrevious.top + navPrevious.height / 2)
            ) <= 4,
        };
    });
    assert.equal(layout.centered, true,
        'session status must stay centered in the session-navigation row');
    assert.equal(layout.sameRow, true,
        'session status must share the previous/next active session row');
    for (const width of [700, 240]) {
        await page.setViewportSize({ width, height: 500 });
        const fitsViewport = await page.locator(
            '[data-conversation-session-status]'
        ).evaluate(element => {
            const bounds = element.getBoundingClientRect();
            return bounds.left >= 0
                && bounds.right <= document.documentElement.clientWidth;
        });
        assert.equal(fitsViewport, true,
            `session status fits at ${width}px`);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await attention.evaluate(element =>
        getComputedStyle(element).animationName
    ), 'none');
});

test('CONVERSATION-SESSION-STATUS-002 mirrors the viewed session kind on the telemetry provider icon and clears attention on activation', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        readSessionStatus: () => ({
            runningSessions: 1,
            attentionSessions: 1,
            runningSessionsLocal: 1,
            attentionSessionsLocal: 1,
            idleSessionsLocal: 1,
            currentSessionKind: 'attention',
        }),
    });
    const provider = page.locator('[data-telemetry-provider]');
    const acknowledgeIntents = async () => (await postedMessages(page))
        .filter(message =>
            message.type === 'conversation-viewer-acknowledge-attention'
        );

    // The Host-rendered document carries the viewed session's kind.
    assert.equal(
        await provider.getAttribute('data-session-state'),
        'attention'
    );
    assert.equal(
        await provider.getAttribute('data-tooltip'),
        'Provider · Codex · Needs attention — click to clear'
    );
    assert.equal(await provider.getAttribute('aria-label'),
        'Provider · Codex · Needs attention — click to clear');
    assert.notEqual(
        await provider.evaluate(element =>
            getComputedStyle(element).animationName
        ),
        'none',
        'the attention ring must pulse'
    );
    assert.notEqual(
        await provider.evaluate(element =>
            getComputedStyle(element).boxShadow
        ),
        'none',
        'the attention ring must draw around the provider icon'
    );
    assert.equal(await provider.getAttribute('role'), 'button',
        'the attention state is exposed as an actionable button');

    // Clicking and keyboard activation both ask the Host to clear it.
    await provider.click();
    assert.deepEqual(await acknowledgeIntents(), [{
        type: 'conversation-viewer-acknowledge-attention',
        version: 1,
    }]);
    await provider.press('Enter');
    await provider.press(' ');
    assert.equal((await acknowledgeIntents()).length, 3,
        'Enter and Space must post the same acknowledge intent');

    const correlation = await page.evaluate(() => ({
        generation: Number(document.body.getAttribute(
            'data-subscription-generation'
        )),
        requestId: Number(document.body.getAttribute(
            'data-session-status-request-id'
        )),
    }));
    const statusMessage = (requestId, currentSessionKind) => ({
        type: 'conversation-viewer-session-status',
        version: 1,
        requestId,
        subscriptionGeneration: correlation.generation,
        status: {
            runningSessions: 1,
            attentionSessions: 0,
            runningSessionsLocal: 1,
            attentionSessionsLocal: 0,
            idleSessionsLocal: 2,
            ...(currentSessionKind ? { currentSessionKind } : {}),
        },
    });

    // Authoritative updates drive the icon: running marks it but stays
    // inert, and a cleared kind removes the ring entirely.
    await sendPage(page, statusMessage(correlation.requestId, 'running'));
    assert.equal(
        await provider.getAttribute('data-session-state'),
        'running'
    );
    assert.equal(
        await provider.getAttribute('data-tooltip'),
        'Provider · Codex · Running'
    );
    await provider.click();
    assert.equal((await acknowledgeIntents()).length, 3,
        'running must stay inert');

    await sendPage(page, statusMessage(correlation.requestId + 1, 'idle'));
    assert.equal(
        await provider.getAttribute('data-session-state'),
        'idle'
    );
    await provider.click();
    assert.equal((await acknowledgeIntents()).length, 3,
        'idle must stay inert');
    assert.equal(await provider.getAttribute('role'), null,
        'inert states are not exposed as buttons');

    // An invalid kind in an otherwise valid message must fail validation
    // and leave the current state untouched.
    await sendPage(page, {
        ...statusMessage(correlation.requestId + 2, undefined),
        status: {
            runningSessions: 1,
            attentionSessions: 0,
            runningSessionsLocal: 1,
            attentionSessionsLocal: 0,
            idleSessionsLocal: 2,
            currentSessionKind: 'busy',
        },
    });
    assert.equal(
        await provider.getAttribute('data-session-state'),
        'idle',
        'an unknown kind must be rejected, not applied'
    );

    // A sixth key other than currentSessionKind must fail validation too.
    await sendPage(page, {
        ...statusMessage(correlation.requestId + 3, undefined),
        status: {
            runningSessions: 1,
            attentionSessions: 0,
            runningSessionsLocal: 1,
            attentionSessionsLocal: 0,
            idleSessionsLocal: 2,
            spoofed: 'attention',
        },
    });
    assert.equal(
        await provider.getAttribute('data-session-state'),
        'idle',
        'an unknown extra key must be rejected, not applied'
    );

    await sendPage(page, statusMessage(correlation.requestId + 4));
    assert.equal(
        await provider.getAttribute('data-session-state'),
        null,
        'a missing kind removes the ring'
    );
    assert.equal(
        await provider.getAttribute('data-tooltip'),
        'Provider · Codex'
    );
    assert.equal(await provider.getAttribute('role'), null,
        'a missing kind removes the button role');
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
    await page.waitForTimeout(250);
    const tooltipBeforeDelay = await page.locator(
        '[data-telemetry-context]'
    ).evaluate(element => {
        const style = getComputedStyle(element, '::after');
        return { opacity: style.opacity, visibility: style.visibility };
    });
    assert.equal(tooltipBeforeDelay.opacity, '0',
        'brief pointer passes must not immediately show telemetry hints');
    await page.waitForTimeout(300);
    const tooltipState = await page.locator(
        '[data-telemetry-context]'
    ).evaluate(element => {
        const style = getComputedStyle(element, '::after');
        return {
            content: style.content,
            opacity: style.opacity,
            visibility: style.visibility,
        };
    });
    assert.equal(tooltipState.visibility, 'visible');
    assert.equal(tooltipState.opacity, '1');
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
        'telemetry must follow model, usage, then quick-entry order'
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




test('CONVERSATION-COMMENTS-TABS-001 preserves per-tab filters and returns after cross-tab composer cancellation', async t => {
    const interactionId = 'input-comments-tabs';
    const sessionComment = {
        id: 'comment-done',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Already reviewed.',
        status: 'done',
        createdAt: 1000,
    };
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 700 },
        initialWebviewState: {
            conversationCommentsActiveTab: 'workspace',
            conversationCommentsPanelFilter: {
                type: 'status',
                value: 'done',
            },
            conversationSidebar: {
                open: true,
                width: 280,
                view: 'comments',
                query: '',
            },
        },
        markdown: 'Alpha beta gamma.',
        interactionIds: [interactionId],
        interactionId,
        commentStore: {
            load: async () => ({
                revision: 1,
                comments: [sessionComment],
            }),
            save: async () => {},
        },
        projectCommentStore: {
            load: async () => ({
                revision: 1,
                comments: [{
                    id: 'note-done',
                    text: 'Workspace follow-up.',
                    tags: [],
                    status: 'done',
                    createdAt: 1000,
                    doneAt: 2000,
                    dispatches: [],
                }],
            }),
            save: async () => {},
        },
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
    });

    const sessionPane = page.locator('[data-comments-panel="session"]');
    const workspacePane = page.locator(
        '[data-comments-panel="workspace"]'
    );

    // The legacy single-filter value migrates to Session only. Workspace
    // starts unfiltered even while Session has a persisted filter.
    assert.equal(await workspacePane.isVisible(), true);
    assert.equal(
        await page.evaluate(() => {
            const tabRow = document.querySelector(
                '[data-comments-tabs]'
            ).getBoundingClientRect();
            const tabs = Array.from(document.querySelectorAll(
                '[data-comments-tab]'
            ));
            const first = tabs[0].getBoundingClientRect();
            const last = tabs.at(-1).getBoundingClientRect();
            return Math.abs(first.width - last.width) <= 1
                && Math.abs(
                    first.left - tabRow.left - (tabRow.right - last.right)
                ) <= 1;
        }),
        true,
        'the Session/Workspace tabs must fill the row equally'
    );
    await page.setViewportSize({ width: 192, height: 700 });
    assert.deepEqual(
        await page.evaluate(() => {
            const panel = document.querySelector(
                '[data-conversation-comments]'
            );
            const tabs = Array.from(document.querySelectorAll(
                '[data-comments-tab]'
            ));
            const panelBounds = panel.getBoundingClientRect();
            return {
                panelVisible: panelBounds.left >= 0
                    && panelBounds.right <= window.innerWidth,
                tabsFillRowEqually: (() => {
                    const tabRow = document.querySelector(
                        '[data-comments-tabs]'
                    ).getBoundingClientRect();
                    const first = tabs[0].getBoundingClientRect();
                    const last = tabs.at(-1).getBoundingClientRect();
                    return Math.abs(first.width - last.width) <= 1
                        && Math.abs(
                            first.left - tabRow.left
                                - (tabRow.right - last.right)
                        ) <= 1;
                })(),
                tabLabelsUnclipped: tabs.every(tab =>
                    tab.scrollWidth <= tab.clientWidth + 1
                ),
                tabsInsidePanel: tabs.every(tab => {
                    const bounds = tab.getBoundingClientRect();
                    return bounds.left >= panelBounds.left
                        && bounds.right <= panelBounds.right;
                }),
            };
        }),
        {
            panelVisible: true,
            tabsFillRowEqually: true,
            tabLabelsUnclipped: true,
            tabsInsidePanel: true,
        }
    );
    await page.setViewportSize({ width: 850, height: 700 });
    assert.equal(
        await page.locator('[data-comment-filter="all"]')
            .getAttribute('aria-pressed'),
        'true'
    );
    await page.locator('[data-comments-tab="session"]').click();
    assert.equal(await sessionPane.isVisible(), true);
    assert.equal(
        await page.locator('[data-comment-filter="done"]')
            .getAttribute('aria-pressed'),
        'true'
    );
    assert.deepEqual(
        await page.evaluate(() =>
            window.__webviewState.conversationCommentsPanelFilter
        ),
        {
            session: { type: 'status', value: 'done' },
            workspace: null,
        }
    );

    async function selectBeta() {
        await page.locator('.conversation-markdown').evaluate(element => {
            const node = element.querySelector('p').firstChild;
            const start = node.nodeValue.indexOf('beta');
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 'beta'.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.dispatchEvent(
                new MouseEvent('mouseup', { bubbles: true })
            );
        });
    }

    // A Session composer opened from Workspace returns to Workspace when
    // cancelled; confirmation would intentionally remain on Session.
    await page.locator('[data-comments-tab="workspace"]').click();
    await selectBeta();
    await page.locator('[data-comment-selection-action="comment"]').click();
    assert.equal(await sessionPane.isVisible(), true);
    assert.equal(
        await page.locator('[data-comment-composer]').isVisible(),
        true
    );
    await page.keyboard.press('Escape');
    assert.equal(await workspacePane.isVisible(), true);
    assert.equal(
        await page.locator('[data-comment-composer]').isVisible(),
        false
    );

    // The opposite direction has the same return-on-cancel contract.
    await page.locator('[data-comments-tab="session"]').click();
    await selectBeta();
    await page.locator('[data-comment-selection-action="project"]').click();
    assert.equal(await workspacePane.isVisible(), true);
    assert.equal(
        await page.locator('[data-project-comment-composer]').isVisible(),
        true
    );
    await page.keyboard.press('Escape');
    assert.equal(await sessionPane.isVisible(), true);
    assert.equal(
        await page.locator('[data-project-comment-composer]').isVisible(),
        false
    );
});





test('CONVERSATION-COMMENTS-UI-001 PROJECT-COMMENTS-UI-001 keeps status and tag chips scoped to the active tab', async t => {
    const sessionComment = {
        id: 'comment-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: '只改 CSS，别动 TS。',
        status: 'open',
    };
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 800 },
        initialWebviewState: {
            conversationSidebar: {
                open: true,
                width: 280,
                view: 'comments',
                query: '',
            },
        },
        interactionIds: ['input-unified'],
        interactionId: 'input-unified',
        pageOverrides: {
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        },
        commentStore: {
            load: async () => ({ revision: 1, comments: [sessionComment] }),
            save: async () => {},
        },
    });

    // The saved state restores the open comments view; clicking the
    // comments pill here would toggle the panel closed.
    const card = page.locator('[data-comment-id="comment-1"]');

    // Session cards carry the same bottom tags row: a display-only status
    // chip plus an add-tag affordance, and no heading status pill.
    const tagsRow = card.locator('.conversation-comment-tags-row');
    assert.equal(
        await tagsRow.locator('[data-comment-status-chip]').innerText(),
        'Open'
    );
    assert.equal(
        await tagsRow.locator('[data-comment-status-chip]')
            .evaluate(element => element.tagName),
        'SPAN'
    );
    assert.equal(
        await card.locator('.conversation-comment-heading')
            .locator('.conversation-comment-status').count(),
        0
    );

    // Adding a tag goes through the Host-authoritative mutation protocol.
    await tagsRow.locator('[data-comment-action="open-tag-editor"]').click();
    const tagInput = card.locator('[data-comment-tag-input]');
    await tagInput.fill('convention');
    await tagInput.press('Enter');
    const tagRequest = (await postedMessages(page)).at(-1);
    assert.equal(
        tagRequest.type,
        'conversation-viewer-comment-mutation'
    );
    assert.equal(tagRequest.operation, 'addTag');
    assert.deepEqual(tagRequest.payload, {
        commentId: 'comment-1',
        tag: 'convention',
    });
    await sendPage(page, commentSettlement(tagRequest, [{
        id: 'comment-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: '只改 CSS，别动 TS。',
        status: 'open',
        tags: ['convention'],
    }], { revision: 2 }));
    assert.deepEqual(
        await tagsRow.locator('.conversation-project-comment-tag')
            .allInnerTexts(),
        ['convention\n×']
    );

    // Removing it posts the paired mutation.
    await tagsRow.locator('[data-comment-action="remove-tag"]').click();
    const removeRequest = (await postedMessages(page)).at(-1);
    assert.equal(removeRequest.operation, 'removeTag');
    assert.deepEqual(removeRequest.payload, {
        commentId: 'comment-1',
        tag: 'convention',
    });
});

test('CONVERSATION-COMMENTS-TABS-001 clears stale hidden-tab filters and spent composer returns', async t => {
    const interactionId = 'input-tab-review-fixes';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 850, height: 700 },
        markdown: 'Alpha beta gamma.',
        interactionIds: [interactionId],
        interactionId,
        initialWebviewState: {
            conversationCommentsActiveTab: 'workspace',
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

    async function selectBeta() {
        await page.locator('.conversation-markdown').evaluate(element => {
            const node = element.querySelector('p').firstChild;
            const start = node.nodeValue.indexOf('beta');
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 'beta'.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            element.dispatchEvent(
                new MouseEvent('mouseup', { bubbles: true })
            );
        });
    }

    // A confirmed cross-tab composer must not poison a later, ordinary
    // Session-note cancellation with its expired return target.
    await selectBeta();
    await page.locator('[data-comment-selection-action="comment"]').click();
    await page.locator('[data-comment-input]').fill('Confirmed cross-tab.');
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    await sendPage(page, commentSettlement(addRequest, [{
        id: 'confirmed-comment',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Confirmed cross-tab.',
        status: 'open',
        createdAt: 1000,
    }]));
    await page.locator('[data-comment-action="new"]').click();
    assert.equal(
        await page.locator('[data-comments-panel="session"]').isVisible(),
        true
    );
    await page.keyboard.press('Escape');
    assert.equal(
        await page.locator('[data-comments-panel="session"]').isVisible(),
        true,
        'a later ordinary composer cancel must stay on Session'
    );

    // If a Workspace tag disappears while that tab is hidden, switching back
    // must render the authoritative all-notes list, not the stale empty list.
    await page.locator('[data-comments-tab="workspace"]').click();
    await page.locator(
        '[data-project-comments-header]'
            + ' [data-project-comment-action="open-composer"]'
    ).click();
    await page.locator('[data-project-comment-input]').fill('Tagged note.');
    await page.locator('[data-project-comment-action="add-draft-tag"]')
        .click();
    await page.locator('[data-project-comment-draft-tag-input]')
        .fill('stale');
    await page.locator('[data-project-comment-draft-tag-input]')
        .press('Enter');
    await page.locator('[data-project-comment-input]')
        .press('Control+Enter');
    const noteAdd = (await postedMessages(page)).at(-1);
    const note = {
        id: 'tagged-note',
        text: 'Tagged note.',
        tags: ['stale'],
        status: 'open',
        createdAt: 1000,
        dispatches: [],
    };
    await sendPage(page, projectCommentSettlement(noteAdd, [note]));
    await page.locator(
        '[data-comments-filter-bar] [data-tag="stale"]'
    ).click();
    await page.locator(
        '[data-project-comment-id="tagged-note"]'
            + ' [data-project-comment-action="remove-tag"]'
    ).click();
    const removeTag = (await postedMessages(page)).at(-1);
    await page.locator('[data-comments-tab="session"]').click();
    await sendPage(page, projectCommentSettlement(removeTag, [{
        ...note,
        tags: [],
    }]));
    await page.locator('[data-comments-tab="workspace"]').click();
    assert.equal(
        await page.locator('[data-project-comment-id]').count(),
        1,
        'clearing a vanished hidden-tab tag filter must restore its card'
    );
    assert.equal(
        await page.locator('[data-project-comment-empty]').isHidden(),
        true
    );
});

function changesFixture(overrides = {}) {
    return {
        kind: 'ready',
        aggregate: {
            completeness: 'complete', workingItemCount: 4,
            workingPartial: false, aheadCount: 2,
            aheadPartial: false, allUnreadable: false,
        },
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: 'agent-pivot/fix-login', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 3,
            aheadCount: 2, taskFileCount: 5, truncated: false,
        }, {
            memberId: 'm-web', repoLabel: 'web',
            branchName: 'agent-pivot/fix-login-ui', worktreePath: '/wt/web',
            availability: 'available', workingItemCount: 1,
            aheadCount: 0, truncated: false,
        }],
        selectedMemberId: 'm-api',
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2, taskFileCount: 5,
            items: [
                { group: 'changes', xy: ' M', path: 'src/auth/login.ts' },
                { group: 'staged', xy: 'M ', path: 'src/auth/session.ts' },
                { group: 'untracked', xy: '??', path: 'src/auth/login.test.ts' },
            ],
            truncated: false,
        },
        collectedAt: 1724000000000,
        ...overrides,
    };
}

// Changes action intents are bound to the authoritative target identity and
// subscription generation — the host drops intents stranded by a session
// switch. The host document fixture always opens this identity.
function changesActionBinding(overrides) {
    return {
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-host-document',
        ...overrides,
    };
}

async function sendChanges(page, changes, generationOverride) {
    const generation = generationOverride || await page.evaluate(() =>
        Number(document.body.getAttribute('data-subscription-generation')));
    await sendPage(page, {
        type: 'conversation-viewer-changes',
        version: 1,
        subscriptionGeneration: generation,
        changes,
    });
}

test('WORKTREE-CHANGES-PANEL-001 renders the telemetry button, sidebar tab, groups, and posts intents', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const changesButton = page.locator('[data-telemetry-changes]');

    assert.equal(await changesButton.isVisible(), false,
        'the Changes button stays hidden before the first state');

    await sendChanges(page, changesFixture());

    assert.equal(await changesButton.isVisible(), true);
    assert.equal(
        await page.locator('[data-telemetry-changes-value]').innerText(),
        '4 · 2',
        'the button carries bare numbers — no arrows or dashes'
    );
    const tooltip = await changesButton.getAttribute('data-tooltip');
    assert.equal(await changesButton.getAttribute('title'), null,
        'no native title — the custom tooltip is the single popup');
    assert.ok(tooltip.includes('api (agent-pivot/fix-login)'));
    assert.ok(tooltip.includes('Task result: 5 files · 2 commits since start'));
    assert.ok(tooltip.includes('Uncommitted: 3'));
    assert.ok(tooltip.includes('/wt/api'),
        'hover reveals the worktree path');
    assert.ok(tooltip.includes('web (agent-pivot/fix-login-ui)'));

    // The button opens the sidebar on the Changes tab, like its siblings.
    await changesButton.click();
    assert.equal(
        await page.locator('[data-conversation-changes]').isVisible(), true);
    assert.equal(
        await changesButton.getAttribute('aria-pressed'), 'true');

    // Member dropdown lists both worktrees as plain repo + branch —
    // counts and arrows carry no weight here (they live in the tooltip).
    const options = await page.locator(
        '[data-changes-member-select] option').allInnerTexts();
    assert.deepEqual(options, [
        'api · ⎇ agent-pivot/fix-login',
        'web · ⎇ agent-pivot/fix-login-ui',
    ]);

    // Cross-member hint: a clickable button naming the action and the
    // target repo (PRD §15.1) — the old bare '+N in <repos>' text is gone.
    assert.equal(
        await page.locator('[data-changes-cross-member]').innerText(),
        '1 more change in web · Go to web');

    // The compact Review icon owns the former task and tracking details.
    const review = page.locator('[data-changes-review]');
    assert.equal(await review.isVisible(), true);
    assert.ok((await review.getAttribute('data-tooltip'))
        .includes('Since start · 5 files · 2 commits'));
    assert.equal(await page.locator('[data-changes-task]').count(), 0);

    // Working groups render in SCM order; Untracked merges into Changes —
    // the U badge already marks untracked rows, so a separate section only
    // repeats information. Group headers are fold buttons carrying a
    // chevron and the item-row count (PRD §15.3).
    const groupHeaders = await page.locator(
        '.conversation-changes-group-header').allInnerTexts();
    assert.deepEqual(groupHeaders, ['▾ Staged Changes · 1', '▾ Changes · 2']);
    const rows = await page.locator('.conversation-changes-file').allInnerTexts();
    assert.equal(rows.length, 3);
    // Tree view: file rows show basenames; single-child directory chains
    // compress into one row (src/auth), like Source Control.
    assert.ok(rows.some(row => row.includes('login.test.ts')));

    const changesGroup = page.locator('.conversation-changes-group', {
        has: page.locator('.conversation-changes-group-header', {
            hasText: /^▾ Changes · 2$/,
        }),
    });
    const folders = await changesGroup.locator(
        '.conversation-changes-folder').allInnerTexts();
    assert.equal(folders.length, 1,
        'the src/auth chain compresses into a single folder row');
    assert.ok(folders[0].includes('src/auth'));
    const untrackedBadge = changesGroup.locator(
        '.conversation-changes-file[data-tooltip="src/auth/login.test.ts"] '
            + '.conversation-changes-file-status-untracked');
    assert.equal(await untrackedBadge.innerText(), 'U',
        'the untracked row keeps its badge inside the merged section');

    // Collapsing a folder hides its files without losing the row state.
    const authFolder = changesGroup.locator('.conversation-changes-folder', {
        hasText: 'src/auth',
    });
    const loginRow = changesGroup.locator(
        '.conversation-changes-file[data-tooltip="src/auth/login.ts"]');
    await authFolder.click();
    assert.equal(await loginRow.isVisible(), false);
    await authFolder.click();
    assert.equal(await loginRow.isVisible(), true);

    // Clicking a file posts the exact open-file intent.
    await page.locator('.conversation-changes-file', {
        hasText: 'login.ts',
    }).first().click();
    const openFile = (await postedMessages(page)).at(-1);
    assert.deepEqual(openFile, {
        type: 'conversation-viewer-changes-open-file',
        version: 1,
        memberId: 'm-api',
        group: 'changes',
        xy: ' M',
        path: 'src/auth/login.ts',
        originalPath: undefined,
        ...changesActionBinding(),
    });

    // Review + refresh + SCM + member switch intents.
    await review.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-review', version: 1, memberId: 'm-api',
        ...changesActionBinding(),
    });
    await page.locator('[data-changes-refresh]').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-refresh', version: 1,
        ...changesActionBinding(),
    });
    await page.locator('[data-changes-open-scm]').click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-open-scm', version: 1, memberId: 'm-api',
        ...changesActionBinding(),
    });
    await page.locator('[data-changes-member-select]').selectOption('m-web');
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select', version: 1, memberId: 'm-web',
        ...changesActionBinding(),
    });
});

test('WORKTREE-CHANGES-PANEL-001 accepts member headSha and the upstream three-state union', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const changesButton = page.locator('[data-telemetry-changes]');
    const state = changesFixture();
    state.members[0].headSha = 'c'.repeat(40);
    state.members[0].upstream = {
        status: 'tracked',
        fullRef: 'refs/remotes/origin/agent-pivot/fix-login',
        sha: 'd'.repeat(40),
        ahead: 2,
        behind: 1,
    };
    state.members[1].headSha = 'e'.repeat(40);
    state.members[1].upstream = { status: 'none' };
    state.members.push({
        memberId: 'm-infra', repoLabel: 'infra',
        branchName: 'agent-pivot/infra', worktreePath: '/wt/infra',
        availability: 'baselineUnavailable', workingItemCount: 0,
        truncated: false, upstream: { status: 'unknown' },
    });
    await sendChanges(page, state);

    // The state passes validMember's whitelist and renders normally.
    assert.equal(await changesButton.isVisible(), true);
    assert.equal(
        await page.locator('[data-telemetry-changes-value]').innerText(),
        '4 · 2');
    await changesButton.click();
    assert.deepEqual(
        await page.locator('[data-changes-member-select] option')
            .allInnerTexts(),
        [
            'api · ⎇ agent-pivot/fix-login',
            'web · ⎇ agent-pivot/fix-login-ui',
            'infra · ⎇ agent-pivot/infra',
        ]);
    const branch = page.locator('[data-changes-branch]');
    const divergence = page.locator('[data-changes-branch-divergence]');
    assert.equal(await divergence.innerText(), '2↑ 1↓',
        'the branch row exposes the selected worktree’s remote divergence');
    assert.equal(await branch.getAttribute('aria-label'),
        'agent-pivot/fix-login, 2 commits ahead and 1 commit behind '
            + 'origin/agent-pivot/fix-login');
    assert.ok((await branch.getAttribute('data-tooltip')).includes(
        'Tracking origin/agent-pivot/fix-login · 2 ahead · 1 behind'));
    const review = page.locator('[data-changes-review]');
    assert.ok((await review.getAttribute('data-tooltip')).includes(
        'Tracking origin/agent-pivot/fix-login · 2 ahead · 1 behind'));

    // exactKeys discipline: a member carrying a key the webview does not
    // know invalidates the whole state — the panel never half-renders.
    const forged = changesFixture();
    forged.members[0].upstreamSha = 'f'.repeat(40);
    await sendChanges(page, forged);
    assert.deepEqual(
        await page.locator('[data-changes-member-select] option')
            .allInnerTexts(),
        [
            'api · ⎇ agent-pivot/fix-login',
            'web · ⎇ agent-pivot/fix-login-ui',
            'infra · ⎇ agent-pivot/infra',
        ],
        'a member with an unrecognized key drops the whole state message');
    assert.ok((await review.getAttribute('data-tooltip')).includes(
        'Tracking origin/agent-pivot/fix-login · 2 ahead · 1 behind'),
    'the rejected state leaves the Review hint untouched');

    await sendChanges(page, {
        ...state,
        selectedMemberId: 'm-web',
        detail: {
            memberId: 'm-web', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 0, taskFileCount: 1,
            items: [], truncated: false,
        },
    });
    assert.equal(await divergence.isHidden(), true,
        'a worktree without a tracking branch has no fabricated 0↑ 0↓');
});

test('WORKTREE-CHANGES-PANEL-001 keeps an adjacent version-1 script usable through dual-state publication', async t => {
    const previousChangesScript = conversationChangesScript
        .replace(`], ['aheadCount', 'taskFileCount', 'detached', 'headSha',
                'upstream'])`, `], ['aheadCount', 'taskFileCount', 'detached'])`)
        .replace(`|| (message.version !== 1 && message.version !== 2)`,
            `|| message.version !== 1`);
    assert.notEqual(previousChangesScript, conversationChangesScript);
    const { page } = await openHostViewerDocument(t, {
        changesScriptSource: previousChangesScript,
    });
    const full = changesFixture();
    full.members[0] = {
        ...full.members[0],
        headSha: 'c'.repeat(40),
        upstream: { status: 'none' },
    };
    const legacy = {
        ...full,
        members: full.members.map(({ headSha, upstream, ...member }) => member),
    };
    const generation = await page.evaluate(() =>
        Number(document.body.getAttribute('data-subscription-generation')));
    await sendPage(page, {
        type: 'conversation-viewer-changes',
        version: 1,
        subscriptionGeneration: generation,
        changes: legacy,
    });
    await sendPage(page, {
        type: 'conversation-viewer-changes',
        version: 2,
        subscriptionGeneration: generation,
        changes: full,
    });
    await page.locator('[data-telemetry-changes]').click();
    assert.equal(
        await page.locator('.conversation-changes-file').count(), 3,
        'the legacy version-1 payload remains applied after the version-2 payload is rejected');
});

test('WORKTREE-CHANGES-PANEL-001 ignores replayed lower versions after adopting version 2', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const full = changesFixture();
    full.members[0] = {
        ...full.members[0], upstream: { status: 'none' },
    };
    const legacy = {
        ...full,
        members: full.members.map(({ headSha, upstream, ...member }) => member),
    };
    const sendVersion = (version, changes) => page.evaluate(payload => {
        window.dispatchEvent(new MessageEvent('message', { data: payload }));
    }, {
        type: 'conversation-viewer-changes',
        version,
        subscriptionGeneration: 1,
        changes,
    });
    await sendVersion(2, full);
    await sendVersion(1, legacy);
    await page.locator('[data-telemetry-changes]').click();
    const review = page.locator('[data-changes-review]');
    await review.focus();
    await sendVersion(2, full);
    await sendVersion(1, legacy);
    assert.equal(await review.isVisible(), true,
        'the legacy replay cannot remove Review after version 2 adoption');
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-review]')), true,
        'the legacy replay cannot steal focus from Review');
});

test('WORKTREE-CHANGES-PANEL-001 compresses single-child directory chains like Source Control', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 0, taskFileCount: 2,
            items: [
                { group: 'changes', xy: ' M', path: 'com/xhs/reddb/service/impl/Foo.java' },
                { group: 'changes', xy: ' M', path: 'com/xhs/reddb/App.java' },
            ],
            truncated: false,
        },
    }));
    await page.locator('[data-telemetry-changes]').click();

    const folders = await page.locator('.conversation-changes-folder')
        .allInnerTexts();
    assert.deepEqual(
        folders.map(text => text.replace(/[▾▸]/gu, '').trim()),
        ['com/xhs/reddb', 'service/impl'],
        'com → xhs → reddb and service → impl render as two compressed rows'
    );
    const fooRow = page.locator(
        '.conversation-changes-file[data-tooltip="com/xhs/reddb/service/impl/Foo.java"]');
    assert.equal(await fooRow.isVisible(), true);
    assert.equal(
        await fooRow.evaluate(element => element.style.paddingLeft),
        '1.6rem',
        'Foo.java indents two levels (compressed rows), not five'
    );

    // Compression keeps collapse state on the chain's final directory.
    await page.locator('.conversation-changes-folder', {
        hasText: 'service/impl',
    }).click();
    assert.equal(await fooRow.isVisible(), false);
    await page.locator('.conversation-changes-folder', {
        hasText: 'service/impl',
    }).click();
    assert.equal(await fooRow.isVisible(), true);
});

test('WORKTREE-CHANGES-PANEL-001 never rebuilds the member dropdown while it is open', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();
    const select = page.locator('[data-changes-member-select]');
    await select.focus();
    await page.evaluate(() => {
        window.__firstOption = document
            .querySelector('[data-changes-member-select]').options[0];
    });

    // Repeated state pushes while the dropdown has focus (i.e. is open)
    // must leave its DOM untouched — rebuilding closes the native popup.
    await sendChanges(page, changesFixture({
        collectedAt: 1724000005000,
    }));
    await sendChanges(page, changesFixture({
        collectedAt: 1724000010000,
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: 'agent-pivot/fix-login', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 9,
            aheadCount: 2, taskFileCount: 5, truncated: false,
        }, {
            memberId: 'm-web', repoLabel: 'web',
            branchName: 'agent-pivot/fix-login-ui', worktreePath: '/wt/web',
            availability: 'available', workingItemCount: 1,
            aheadCount: 0, truncated: false,
        }],
    }));
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-changes-member-select]').options[0]
            === window.__firstOption), true,
        'option element identity is preserved while the dropdown is focused');
    assert.equal(await page.evaluate(() =>
        document.activeElement === document
            .querySelector('[data-changes-member-select]')), true);

    // Once the dropdown loses focus, a changed member set rebuilds.
    await page.locator('[data-changes-refresh]').focus();
    await sendChanges(page, changesFixture({
        collectedAt: 1724000015000,
        members: [{
            memberId: 'm-api', repoLabel: 'api-renamed',
            branchName: 'agent-pivot/fix-login', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 9,
            aheadCount: 2, taskFileCount: 5, truncated: false,
        }, {
            memberId: 'm-web', repoLabel: 'web',
            branchName: 'agent-pivot/fix-login-ui', worktreePath: '/wt/web',
            availability: 'available', workingItemCount: 1,
            aheadCount: 0, truncated: false,
        }],
    }));
    assert.equal(await page.evaluate(() =>
        document.querySelector('[data-changes-member-select]').options[0]
            === window.__firstOption), false,
        'after blur a changed member set rebuilds the options');
    assert.equal((await select.inputValue()), 'm-api');
    // The visible label of the select overlay tracks the rebuilt options.
    assert.equal(
        await page.locator('[data-changes-repo-name]').innerText(),
        'api-renamed');
});

test('WORKTREE-CHANGES-PANEL-001 renders a two-row member header with a repo picker overlay and a branch row', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const state = changesFixture();
    state.members.push({
        memberId: 'm-infra', repoLabel: 'infra',
        branchName: 'agent-pivot/infra', worktreePath: '/wt/infra',
        availability: 'available', workingItemCount: 0,
        aheadCount: 0, truncated: false,
    });
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();

    // Row 1: ‹ › icon buttons with accessible names and overlay hints,
    // always shown while more than one member exists.
    const prev = page.locator('[data-changes-prev]');
    const next = page.locator('[data-changes-next]');
    assert.equal(await prev.isVisible(), true);
    assert.equal(await prev.getAttribute('aria-label'), 'Previous repository');
    assert.equal(await prev.getAttribute('data-tooltip'), 'Previous repository');
    assert.equal(await next.isVisible(), true);
    assert.equal(await next.getAttribute('aria-label'), 'Next repository');
    assert.equal(await next.getAttribute('data-tooltip'), 'Next repository');

    // Row 1 middle: a visible repo label under a transparent native
    // <select> overlay — the closed state is custom DOM (repo name + ▾),
    // the popup stays native. The label's tooltip carries the full
    // worktree path (PRD §15.1).
    assert.equal(
        await page.locator('[data-changes-repo-name]').innerText(), 'api');
    assert.equal(
        await page.locator('[data-changes-repo-label]')
            .getAttribute('data-tooltip'),
        '/wt/api');
    const select = page.locator('[data-changes-member-select]');
    assert.equal(await select.inputValue(), 'm-api');
    assert.equal(await select.getAttribute('data-tooltip'), '/wt/api',
        'the overlaying select reveals the worktree path on hover/focus');
    const overlayStyle = await select.evaluate(element => ({
        opacity: getComputedStyle(element).opacity,
        position: getComputedStyle(element).position,
    }));
    assert.equal(overlayStyle.opacity, '0',
        'the native select is a transparent overlay over the label');
    assert.equal(overlayStyle.position, 'absolute');

    // (i/n) position indicator, shown whenever n > 1 (PRD §14.2).
    const position = page.locator('[data-changes-position]');
    assert.equal(await position.isVisible(), true);
    assert.equal(await position.innerText(), '(1/3)');

    // The live region announces the position for screen readers.
    const live = page.locator('[data-changes-live]');
    assert.equal(await live.getAttribute('aria-live'), 'polite');
    assert.equal(await live.innerText(), 'api, 1 of 3');

    // No detached marker for an in-workspace member.
    assert.equal(
        await page.locator('[data-changes-outside]').isHidden(), true);

    // Row 2: the branch owns the row — prefix elides, the last segment
    // stays visible (two-span middle ellipsis, PRD §15.1).
    const branch = page.locator('[data-changes-branch]');
    assert.equal(
        await page.locator('[data-changes-branch-prefix]').innerText(),
        'agent-pivot/');
    assert.equal(
        await page.locator('[data-changes-branch-tail]').innerText(),
        'fix-login');
    const branchTooltip = await branch.getAttribute('data-tooltip');
    assert.ok(branchTooltip.includes('agent-pivot/fix-login'));
    assert.ok(branchTooltip.includes('/wt/api'));

    // Source Control occupies row 2's leading icon slot, matching the
    // previous-repository slot above it. The branch label therefore begins
    // at the same x coordinate as the repository label. Refresh and the
    // folded action remain in row 3.
    assert.equal(
        await page.locator('.conversation-changes-branch-row '
            + '[data-changes-refresh]').count(),
        0);
    assert.equal(
        await page.locator('.conversation-changes-branch-row '
            + '[data-changes-open-scm]').count(),
        1);
    assert.equal(
        await page.locator('.conversation-changes-fold '
            + '[data-changes-open-scm]').count(),
        0);
    assert.equal(
        await page.locator('.conversation-changes-branch-icon').count(),
        0, 'the SCM action is the branch row’s sole leading icon');
    assert.equal(await page.locator('[data-changes-branch]').evaluate(
        (branch, selector) => branch.getBoundingClientRect().x
            === document.querySelector(selector).getBoundingClientRect().x,
        '[data-changes-repo-picker]'), true,
    'branch and repository labels share the same leading text alignment');
    assert.equal(
        await page.locator('.conversation-changes-fold '
            + '[data-changes-fold-toggle]').count(),
        1, 'one merged fold toggle replaces the collapse/expand pair');
    assert.equal(
        await page.locator('.conversation-changes-fold '
            + '[data-changes-refresh]').count(),
        1);
    assert.equal(
        await page.locator('[data-changes-open-scm] svg circle').count(),
        3,
        'the SCM button carries the three-node Source Control glyph');
    assert.equal(
        await page.locator('[data-changes-fold-toggle] svg path').count(),
        2, 'the fold glyph uses one light chevron for each toggle state');
});

test('WORKTREE-CHANGES-PANEL-001 cycles members with ‹ ›, wraps at the ends, announces the position, and keeps focus', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const state = changesFixture();
    state.members.push({
        memberId: 'm-infra', repoLabel: 'infra',
        branchName: 'agent-pivot/infra', worktreePath: '/wt/infra',
        availability: 'available', workingItemCount: 2,
        aheadCount: 0, truncated: false,
    });
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();

    const next = page.locator('[data-changes-next]');
    const prev = page.locator('[data-changes-prev]');
    const position = page.locator('[data-changes-position]');
    const live = page.locator('[data-changes-live]');
    const select = page.locator('[data-changes-member-select]');
    const detailFor = memberId => ({
        memberId, availability: 'available',
        baselineSha: 'a'.repeat(40), aheadCount: 0, taskFileCount: 1,
        items: [], truncated: false,
    });
    const selectMember = async memberId => {
        await sendChanges(page, {
            ...state,
            selectedMemberId: memberId,
            detail: detailFor(memberId),
        });
    };

    // › posts the existing select intent for the next manifest-order member.
    await next.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...changesActionBinding(),
        memberId: 'm-web',
    });
    await selectMember('m-web');
    assert.equal(
        await page.locator('[data-changes-repo-name]').innerText(), 'web');
    assert.equal(await select.inputValue(), 'm-web',
        'the native select value syncs with the cycled selection');
    assert.equal(await position.innerText(), '(2/3)');
    assert.equal(await live.innerText(), 'web, 2 of 3',
        'aria-live announces the new position');

    // Focus stays on › after the re-render, so Enter cycles again.
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-next]')), true,
        '‹ › keep focus across the state push (PRD §15.2)');
    await page.keyboard.press('Enter');
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...changesActionBinding(),
        memberId: 'm-infra',
    });
    await selectMember('m-infra');
    assert.equal(await position.innerText(), '(3/3)');

    // Wrapping: › at the last member selects the first.
    await next.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...changesActionBinding(),
        memberId: 'm-api',
    });
    await selectMember('m-api');
    assert.equal(await position.innerText(), '(1/3)');
    assert.equal(await live.innerText(), 'api, 1 of 3');

    // ‹ at the first member wraps to the last.
    await prev.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...changesActionBinding(),
        memberId: 'm-infra',
    });

    // Two more rapid activations happen before either authoritative
    // acknowledgement; the pending cursor advances instead of repeating.
    await next.click();
    await next.click();
    assert.deepEqual(
        (await postedIntents(page)).slice(-2).map(message => message.memberId),
        ['m-api', 'm-web'],
        'rapid cycling advances a pending cursor instead of repeating one member');
});

test('WORKTREE-CHANGES-PANEL-001 degrades a single member to a static repo title without a select', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture({
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: 'agent-pivot/fix-login', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 3,
            aheadCount: 2, taskFileCount: 5, truncated: false,
        }],
        selectedMemberId: 'm-api',
    }));
    await page.locator('[data-telemetry-changes]').click();

    // ‹ › stay visible but disabled for a single member — row 1 keeps one
    // consistent look across member counts; (i/n) still hides and no
    // select is rendered at all — the repo name is a plain text title,
    // not a disabled dropdown (PRD §15.1/§16).
    assert.equal(
        await page.locator('[data-changes-prev]').isVisible(), true);
    assert.equal(
        await page.locator('[data-changes-prev]').isDisabled(), true);
    assert.equal(
        await page.locator('[data-changes-next]').isVisible(), true);
    assert.equal(
        await page.locator('[data-changes-next]').isDisabled(), true);
    assert.equal(
        await page.locator('[data-changes-position]').isHidden(), true);
    assert.equal(
        await page.locator('[data-changes-member-select]').count(), 0,
        'single-member sessions render no select element');
    const title = page.locator('[data-changes-repo-title]');
    assert.equal(await title.isVisible(), true);
    assert.equal(await title.innerText(), 'api');
    assert.equal(await title.getAttribute('data-tooltip'), '/wt/api');

    // The branch row stays visible for a single member (PRD §16).
    assert.equal(
        await page.locator('[data-changes-branch-tail]').innerText(),
        'fix-login');

    // An unmanaged synthetic member without a branch falls back to a
    // stated placeholder instead of a blank row.
    await sendChanges(page, changesFixture({
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: '', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 3,
            aheadCount: 2, taskFileCount: 5, truncated: false,
        }],
        selectedMemberId: 'm-api',
    }));
    assert.equal(
        await page.locator('[data-changes-branch-tail]').innerText(),
        '(no branch)');
    assert.equal(
        await page.locator('[data-changes-branch-prefix]').innerText(), '');
    assert.equal(
        await page.locator('[data-changes-branch]')
            .getAttribute('data-tooltip'),
        '/wt/api',
        'no branch name to reveal — the tooltip keeps the worktree path');
});

test('WORKTREE-CHANGES-PANEL-001 marks detached members in the closed label and keeps the option suffix', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const state = changesFixture();
    state.members[0].detached = true;
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();

    // Closed state: an independent muted element next to the label
    // (PRD §15.1 detached 双承载).
    const outside = page.locator('[data-changes-outside]');
    assert.equal(await outside.isVisible(), true);
    assert.equal(await outside.innerText(), 'Outside workspace');

    // Popup: the option keeps its (outside workspace) suffix so other
    // detached members are recognizable before selection.
    assert.deepEqual(
        await page.locator('[data-changes-member-select] option')
            .allInnerTexts(),
        [
            'api · ⎇ agent-pivot/fix-login (outside workspace)',
            'web · ⎇ agent-pivot/fix-login-ui',
        ]);

    // Selecting the non-detached member hides the badge again.
    await sendChanges(page, {
        ...state,
        selectedMemberId: 'm-web',
        detail: {
            memberId: 'm-web', availability: 'available',
            baselineSha: 'b'.repeat(40), aheadCount: 0, taskFileCount: 1,
            items: [], truncated: false,
        },
    });
    assert.equal(await outside.isHidden(), true);
});

test('WORKTREE-CHANGES-PANEL-001 cross-member hint counts readable members and jumps to the next one with changes', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const member = (memberId, repoLabel, workingItemCount, extra = {}) => ({
        memberId, repoLabel,
        branchName: 'task/x', worktreePath: `/wt/${repoLabel}`,
        availability: 'available', workingItemCount,
        aheadCount: 0, truncated: false, ...extra,
    });
    const detailFor = memberId => ({
        memberId, availability: 'available',
        baselineSha: 'a'.repeat(40), aheadCount: 0, taskFileCount: 1,
        items: [], truncated: false,
    });
    const hint = page.locator('[data-changes-cross-member]');

    // Count and jump target come from the same set: readable members
    // (availability !== 'unreadable') other than the selected one.
    await sendChanges(page, changesFixture({
        members: [
            member('m-api', 'api', 3),
            member('m-web', 'web', 1),
            member('m-infra', 'infra', 2),
        ],
        selectedMemberId: 'm-api',
        detail: detailFor('m-api'),
    }));
    await page.locator('[data-telemetry-changes]').click();
    assert.equal(await hint.evaluate(element => element.tagName), 'BUTTON',
        'the hint is a clickable button, not bare text');
    assert.equal(
        await hint.innerText(),
        '3 more changes in web, infra · Go to web');
    assert.equal(
        await hint.getAttribute('data-tooltip'),
        'web: 1\ninfra: 2',
        'the full per-repo breakdown rides the tooltip overlay');
    await hint.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...changesActionBinding(),
        memberId: 'm-web',
    });

    // The jump target is the NEXT member with changes in fixed manifest
    // order starting after the selected one — not the first in the list.
    await sendChanges(page, changesFixture({
        members: [
            member('m-web', 'web', 1),
            member('m-api', 'api', 3),
            member('m-infra', 'infra', 2),
        ],
        selectedMemberId: 'm-api',
        detail: detailFor('m-api'),
    }));
    assert.equal(
        await hint.innerText(),
        '3 more changes in web, infra · Go to infra');
    await hint.click();
    assert.deepEqual((await postedMessages(page)).at(-1), {
        type: 'conversation-viewer-changes-select',
        version: 1,
        ...changesActionBinding(),
        memberId: 'm-infra',
    });

    // More than two repos truncate to "<a>, <b> +M more".
    await sendChanges(page, changesFixture({
        members: [
            member('m-api', 'api', 3),
            member('m-web', 'web', 1),
            member('m-infra', 'infra', 1),
            member('m-db', 'db', 1),
        ],
        selectedMemberId: 'm-api',
        detail: detailFor('m-api'),
    }));
    assert.equal(
        await hint.innerText(),
        '3 more changes in web, infra +1 more · Go to web');
    assert.equal(
        await hint.getAttribute('data-tooltip'),
        'web: 1\ninfra: 1\ndb: 1');

    // Unreadable members never enter the count or the jump candidates —
    // unknown is never counted as zero, nor as a clickable target.
    await sendChanges(page, changesFixture({
        members: [
            member('m-api', 'api', 3),
            member('m-web', 'web', 5, { availability: 'unreadable' }),
            member('m-infra', 'infra', 2),
        ],
        selectedMemberId: 'm-api',
        detail: detailFor('m-api'),
    }));
    assert.equal(
        await hint.innerText(),
        '2 more changes in infra · Go to infra');

    // All changes from the current member → no hint at all.
    await sendChanges(page, changesFixture({
        members: [
            member('m-api', 'api', 3),
            member('m-web', 'web', 0),
            member('m-infra', 'infra', 0),
        ],
        selectedMemberId: 'm-api',
        detail: detailFor('m-api'),
    }));
    assert.equal(await hint.isHidden(), true);
});

test('WORKTREE-CHANGES-PANEL-001 puts selected-member tracking facts in the Review tooltip', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const state = changesFixture();
    state.members[0].upstream = {
        status: 'tracked',
        fullRef: 'refs/remotes/origin/agent-pivot/fix-login',
        sha: 'd'.repeat(40),
        ahead: 2,
        behind: 1,
    };
    state.members[1].upstream = { status: 'none' };
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();
    const review = page.locator('[data-changes-review]');

    // tracked: short upstream + fork counts; full ref and the no-fetch
    // caveat on the tooltip overlay (PRD §14.1).
    assert.equal(
        (await review.getAttribute('data-tooltip')).includes(
            'Tracking origin/agent-pivot/fix-login · 2 ahead · 1 behind'), true);
    await review.hover();
    const overlay = page.locator('.conversation-tooltip-overlay');
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.ok((await overlay.innerText()).includes(
        'Tracking origin/agent-pivot/fix-login · 2 ahead · 1 behind'));

    // The line follows the selected member: web has no tracking branch —
    // a stated fact in neutral descriptionForeground, never a warning.
    await sendChanges(page, {
        ...state,
        selectedMemberId: 'm-web',
        detail: {
            memberId: 'm-web', availability: 'available',
            baselineSha: 'b'.repeat(40), aheadCount: 0, taskFileCount: 1,
            items: [], truncated: false,
        },
    });
    assert.ok((await review.getAttribute('data-tooltip')).includes(
        'No tracking branch'));
    assert.equal(await overlay.isHidden(), true,
        'a state refresh closes a visible hint instead of leaving stale details');
    await page.mouse.move(0, 0);
    await review.hover();
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.ok((await overlay.innerText()).includes('No tracking branch'),
        'the next hover reads the refreshed selected member');
    assert.equal((await overlay.innerText()).includes('origin/agent-pivot'),
        false, 'the next hover never restores the previous member details');

    // unknown: the query failed — never rendered as a fact.
    const unknownState = {
        ...state,
        selectedMemberId: 'm-web',
        detail: {
            memberId: 'm-web', availability: 'available',
            baselineSha: 'b'.repeat(40), aheadCount: 0, taskFileCount: 1,
            items: [], truncated: false,
        },
    };
    unknownState.members = state.members.map((member, index) =>
        index === 1 ? { ...member, upstream: { status: 'unknown' } } : member);
    await sendChanges(page, unknownState);
    assert.ok((await review.getAttribute('data-tooltip')).includes(
        'Tracking unknown'));

    // A member without upstream data (unreadable) renders no line at all.
    const bareState = changesFixture();
    await sendChanges(page, bareState);
    assert.equal(await review.isVisible(), true);
    assert.equal((await review.getAttribute('data-tooltip')).includes('Tracking'),
        false, 'members without upstream data do not invent a tracking line');
});

test('WORKTREE-CHANGES-PANEL-001 hides Review when task facts are unknown and never zero-washes counts', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const state = changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2,
            items: [{ group: 'changes', xy: ' M', path: 'src/a.ts' }],
            truncated: false,
        },
    });
    state.members[0] = { ...state.members[0], upstream: { status: 'none' } };
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();
    const review = page.locator('[data-changes-review]');
    assert.equal(await review.isVisible(), false,
        'Review has no meaningful target until the task file count is known');

    await sendChanges(page, changesFixture({
        ...state,
        detail: {
            ...state.detail,
            taskFileCount: 5,
            aheadCount: undefined,
        },
    }));
    assert.ok((await review.getAttribute('data-tooltip')).includes(
        'Since start · 5 files · ? commits'));
    assert.ok((await review.getAttribute('data-tooltip')).includes(
        'No tracking branch'));
});

test('WORKTREE-CHANGES-PANEL-001 clears old member data on terminal and reset states', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();
    assert.equal(await page.locator('.conversation-changes-file').count(), 3);

    await sendChanges(page, changesFixture({
        kind: 'retired',
        aggregate: {
            completeness: 'unavailable', workingItemCount: 0,
            workingPartial: false, aheadPartial: false, allUnreadable: true,
        },
        members: [],
        selectedMemberId: undefined,
        detail: undefined,
    }));
    assert.equal(
        await page.locator('[data-changes-branch-tail]').textContent(), '',
        'retired state cannot retain the previous branch');
    assert.equal(await page.locator('[data-changes-branch]').isHidden(), true,
        'the focusable branch row leaves the tab order with no member');
    assert.equal(
        await page.locator('[data-changes-refresh]').isDisabled(), true,
        'refresh has no active member to collect');
    assert.equal(
        await page.locator('[data-changes-open-scm]').isDisabled(), true,
        'SCM has no active member to reveal');
    assert.equal(await page.locator('.conversation-changes-file').count(), 0);
    assert.equal(
        await page.locator('[data-changes-cross-member]').isHidden(), true);
    assert.equal(await page.locator('[data-changes-review]').isHidden(), true);
    assert.ok((await page.locator('[data-changes-unavailable]').innerText())
        .includes('deleted'));

    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();
    const generation = await page.evaluate(() =>
        Number(document.body.getAttribute('data-subscription-generation')));
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 100,
        subscriptionGeneration: generation + 1,
        updateKind: 'initial',
        html: messageHtml('next-session', 1),
        outline: [{
            interactionId: 'next-session-0',
            userPreview: 'next session',
            responseState: 'complete',
        }],
        selectedInteractionId: 'next-session-0',
        selectedInput: 1,
        totalInputs: 1,
        target: {
            projectId: 'project-1', provider: 'codex',
            sessionId: 'session-next',
            interactionId: 'next-session-0',
            displayName: 'Next session',
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });
    assert.equal(
        await page.locator('[data-changes-branch-tail]').textContent(), '',
        'session reset cannot retain repository metadata while replacement state loads');
    assert.equal(await page.locator('.conversation-changes-file').count(), 0);
});

test('WORKTREE-CHANGES-PANEL-001 keeps the header tab order: ‹ → select → › → SCM → branch → hint → sub-tab → fold toggle → refresh → Review → content', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();

    await page.locator('[data-changes-prev]').focus();
    const stops = [
        '[data-changes-member-select]',
        '[data-changes-next]',
        '[data-changes-open-scm]',
        '[data-changes-branch]',
        '[data-changes-cross-member]',
        // Row 3's left slot: the selected sub-tab is the tablist's single
        // Tab stop (PRD §15.4); the fold toggle and refresh follow.
        '[data-changes-subtab="files"]',
        '[data-changes-fold-toggle]',
        '[data-changes-refresh]',
        '[data-changes-review]',
    ];
    for (const selector of stops) {
        await page.keyboard.press('Tab');
        assert.equal(
            await page.evaluate(expected =>
                document.activeElement
                    === document.querySelector(expected), selector),
            true,
            `Tab from the header should land on ${selector}`);
    }

    // Without a cross-member hint the stop is skipped entirely.
    await sendChanges(page, changesFixture({
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: 'agent-pivot/fix-login', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 3,
            aheadCount: 2, taskFileCount: 5, truncated: false,
        }, {
            memberId: 'm-web', repoLabel: 'web',
            branchName: 'agent-pivot/fix-login-ui', worktreePath: '/wt/web',
            availability: 'available', workingItemCount: 0,
            aheadCount: 0, truncated: false,
        }],
        selectedMemberId: 'm-api',
    }));
    await page.locator('[data-changes-branch]').focus();
    await page.keyboard.press('Tab');
    assert.equal(
        await page.evaluate(() =>
            document.activeElement
                === document.querySelector('[data-changes-subtab="files"]')),
        true,
        'with no hint rendered, the branch tabs into the sub-tab stop');
    await page.keyboard.press('Tab');
    assert.equal(
        await page.evaluate(() =>
            document.activeElement
                === document.querySelector('[data-changes-fold-toggle]')),
        true,
        'the sub-tab stop leads into the fold toggle');
    await page.keyboard.press('Tab');
    assert.equal(
        await page.evaluate(() =>
            document.activeElement
                === document.querySelector('[data-changes-refresh]')),
        true,
        'refresh follows the fold toggle');
    await page.keyboard.press('Tab');
    assert.equal(
        await page.evaluate(() =>
            document.activeElement
                === document.querySelector('[data-changes-review]')),
        true,
        'refresh leads into Review');
});

test('WORKTREE-CHANGES-PANEL-001 renders group headers as collapsible buttons with item-row counts', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();

    const stagedHeader = page.locator('.conversation-changes-group-header', {
        hasText: 'Staged Changes',
    });
    // A native button exposes the fold state through aria-expanded; the
    // count follows the item-row reference frame (a file staged and
    // unstaged counts twice), never a file count (PRD §15.3).
    assert.equal(
        await stagedHeader.evaluate(element => element.tagName), 'BUTTON');
    assert.equal(await stagedHeader.getAttribute('type'), 'button');
    assert.equal(await stagedHeader.getAttribute('aria-expanded'), 'true');
    assert.equal(await stagedHeader.innerText(), '▾ Staged Changes · 1');
    assert.equal(await stagedHeader.getAttribute('title'), null,
        'no native title anywhere (PRD §17)');
    // The empty Merge group never renders at all (unchanged Part I rule).
    assert.equal(
        await page.locator('.conversation-changes-group-header', {
            hasText: 'Merge Changes',
        }).count(),
        0);

    // Clicking the header folds the whole section; the count stays.
    const sessionRow = page.locator(
        '.conversation-changes-file[data-tooltip="src/auth/session.ts"]');
    assert.equal(await sessionRow.isVisible(), true);
    await stagedHeader.click();
    assert.equal(await stagedHeader.getAttribute('aria-expanded'), 'false');
    assert.equal(await stagedHeader.innerText(), '▸ Staged Changes · 1',
        'the count stays visible on the collapsed header');
    assert.equal(await sessionRow.isVisible(), false,
        'the section list hides with the group');
    await stagedHeader.click();
    assert.equal(await stagedHeader.getAttribute('aria-expanded'), 'true');
    assert.equal(await stagedHeader.innerText(), '▾ Staged Changes · 1');
    assert.equal(await sessionRow.isVisible(), true);
});

test('WORKTREE-CHANGES-PANEL-001 collapses and expands every group and folder from the row-3 action slot', async t => {
    const { page } = await openHostViewerDocument(t, {
        viewport: { width: 192, height: 500 },
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();

    // Row 3: the sub-tabs on the left plus one merged fold toggle and
    // refresh on the right — a light single-chevron fold glyph with
    // aria-label and overlay tooltip, never a native title (PRD §17).
    const foldToggle = page.locator('[data-changes-fold-toggle]');
    assert.equal(await foldToggle.isVisible(), true);
    assert.equal(await foldToggle.isEnabled(), true);
    assert.equal(await foldToggle.getAttribute('aria-label'),
        'Collapse all');
    assert.equal(await foldToggle.getAttribute('data-tooltip'),
        'Collapse all');
    assert.equal(await foldToggle.getAttribute('title'), null);
    assert.equal(await foldToggle.locator('svg[aria-hidden="true"]').count(),
        1, 'the glyph is decorative — the name rides aria-label');
    // Anything expanded ⇒ Collapse all; the icons swap with the label.
    const visibleIcons = () => foldToggle.locator(
        '[data-fold-icon]').evaluateAll(icons => icons
            .filter(icon => icon.style.display !== 'none')
            .map(icon => icon.getAttribute('data-fold-icon')));
    assert.deepEqual(await visibleIcons(), ['collapse']);

    // Extremely narrow panel: the row stays on one line without
    // overflowing or compressing the buttons (PRD §16).
    const row3 = await page.locator('[data-changes-actions]')
        .evaluate(element => ({
            overflow: element.scrollWidth - element.clientWidth,
            tops: Array.from(element.querySelectorAll(
                '.conversation-changes-fold button'))
                .map(button => button.offsetTop),
            widths: Array.from(element.querySelectorAll(
                '.conversation-changes-fold button'))
                .map(button => button.getBoundingClientRect().width),
        }));
    assert.ok(row3.overflow <= 0,
        `row 3 never overflows horizontally, overflow=${row3.overflow}`);
    assert.equal(row3.tops[0], row3.tops[1],
        'the fold buttons stay on one line');
    assert.ok(row3.widths.every(width => width >= 22),
        'the icon buttons are never compressed');

    // Collapse all: only the group header rows remain, and the toggle
    // flips to Expand all.
    await foldToggle.click();
    assert.deepEqual(
        await page.locator('.conversation-changes-group-header')
            .allInnerTexts(),
        ['▸ Staged Changes · 1', '▸ Changes · 2'],
        'both groups collapse to their header rows');
    assert.equal(
        await page.locator('.conversation-changes-folder:visible').count(),
        0, 'every folder row folds away');
    assert.equal(
        await page.locator('.conversation-changes-file:visible').count(),
        0, 'every file row folds away');
    assert.equal(
        await page.locator('.conversation-changes-group-header[aria-expanded="false"]').count(),
        2);
    assert.equal(await foldToggle.getAttribute('aria-label'), 'Expand all',
        'fully collapsed flips the toggle to Expand all');
    assert.deepEqual(await visibleIcons(), ['expand']);

    // Expand all restores groups, folders, and files.
    await foldToggle.click();
    assert.deepEqual(
        await page.locator('.conversation-changes-group-header')
            .allInnerTexts(),
        ['▾ Staged Changes · 1', '▾ Changes · 2']);
    assert.equal(
        await page.locator('.conversation-changes-folder:visible').count(),
        2);
    assert.equal(
        await page.locator('.conversation-changes-file:visible').count(),
        3);

    assert.equal(await foldToggle.getAttribute('aria-label'),
        'Collapse all', 'expanding flips the toggle back');

    // No-changes empty state disables the toggle (PRD §15.3).
    await sendChanges(page, changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 0, taskFileCount: 0,
            items: [], truncated: false,
        },
    }));
    assert.equal(await foldToggle.isDisabled(), true);
    await sendChanges(page, changesFixture());
    assert.equal(await foldToggle.isEnabled(), true,
        'the toggle wakes up with the next non-empty state');
});

test('WORKTREE-CHANGES-PANEL-001 keeps folder clicks and authoritative refreshes in sync', async t => {
    const { page } = await openHostViewerDocument(t, {});
    const state = changesFixture();
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();
    const folder = page.locator('.conversation-changes-folder').first();
    await folder.click();
    assert.equal(await folder.getAttribute('aria-expanded'), 'false');
    await folder.click();
    assert.equal(await folder.getAttribute('aria-expanded'), 'true');

    await sendChanges(page, changesFixture({
        ...state,
        detail: { ...state.detail },
    }));
    assert.equal(await folder.getAttribute('aria-expanded'), 'true',
        'the second click must update remembered state, not toggle the stale render-time closure');
});

test('WORKTREE-CHANGES-PANEL-001 safely builds trees from reserved directory names', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2, taskFileCount: 2,
            items: [
                { group: 'changes', xy: ' M', path: '__proto__/file.ts' },
                { group: 'untracked', xy: '??', path: 'constructor/new.ts' },
            ],
            truncated: false,
        },
    }));
    await page.locator('[data-telemetry-changes]').click();
    assert.deepEqual(
        await page.locator('.conversation-changes-folder').allInnerTexts(),
        ['▾__proto__', '▾constructor']);
    assert.equal(
        await page.locator('.conversation-changes-file').count(), 2);
});

test('WORKTREE-CHANGES-PANEL-001 remembers fold state and scroll position per member', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const apiItems = [
        { group: 'staged', xy: 'M ', path: 'src/auth/session.ts' },
        ...Array.from({ length: 60 }, (_unused, index) => ({
            group: 'changes',
            xy: ' M',
            path: `src/deeply/nested/directory/structure/file-${String(index).padStart(2, '0')}.ts`,
        })),
    ];
    const webItems = Array.from({ length: 5 }, (_unused, index) => ({
        group: 'changes',
        xy: ' M',
        path: `lib/widgets/widget-${index}.ts`,
    }));
    const detailFor = (memberId, items) => ({
        memberId, availability: 'available',
        baselineSha: 'a'.repeat(40), aheadCount: 0, taskFileCount: 1,
        items, truncated: false,
    });
    const state = changesFixture({ detail: detailFor('m-api', apiItems) });
    await sendChanges(page, state);
    await page.locator('[data-telemetry-changes]').click();

    const groups = page.locator('[data-changes-groups]');
    // m-api: collapse one folder (the group itself stays open) and scroll.
    await page.locator('.conversation-changes-folder', {
        hasText: 'src/auth',
    }).click();
    assert.equal(
        await page.locator('.conversation-changes-file'
            + '[data-tooltip="src/auth/session.ts"]').isVisible(),
        false);
    await groups.evaluate(element => {
        element.scrollTop = 120;
    });

    // m-web starts fully expanded at the top; collapse its only group.
    await sendChanges(page, {
        ...state,
        selectedMemberId: 'm-web',
        detail: detailFor('m-web', webItems),
    });
    const webGroupHeader = page.locator(
        '.conversation-changes-group-header');
    assert.equal(await webGroupHeader.count(), 1);
    assert.equal(await webGroupHeader.getAttribute('aria-expanded'), 'true',
        'a member never inherits another member\'s folds');
    assert.equal(await groups.evaluate(element => element.scrollTop), 0);
    await webGroupHeader.click();
    assert.equal(await webGroupHeader.getAttribute('aria-expanded'), 'false');

    // Back to m-api: the collapsed folder, the expanded group, and the
    // scroll position all come back (PRD §15.2).
    await sendChanges(page, {
        ...state,
        selectedMemberId: 'm-api',
        detail: detailFor('m-api', apiItems),
    });
    const stagedHeader = page.locator('.conversation-changes-group-header', {
        hasText: 'Staged Changes',
    });
    assert.equal(await stagedHeader.getAttribute('aria-expanded'), 'true',
        'only the folder was collapsed, never its group');
    assert.equal(
        await page.locator('.conversation-changes-file'
            + '[data-tooltip="src/auth/session.ts"]').isVisible(),
        false,
        'm-api keeps its collapsed folder');
    assert.equal(await groups.evaluate(element => element.scrollTop), 120,
        'm-api scroll position is restored');

    // m-web again: its collapsed group is remembered too.
    await sendChanges(page, {
        ...state,
        selectedMemberId: 'm-web',
        detail: detailFor('m-web', webItems),
    });
    assert.equal(await page.locator('.conversation-changes-group-header')
        .getAttribute('aria-expanded'), 'false',
        'm-web keeps its own collapsed group');
});

test('WORKTREE-CHANGES-PANEL-001 implements the Files tree keyboard model', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();

    const rows = page.locator(
        '.conversation-changes-group-header, '
        + '.conversation-changes-folder, .conversation-changes-file');
    const tabStops = await rows.evaluateAll(elements => elements
        .filter(element => element.tabIndex >= 0)
        .map(element => element.textContent.trim()));
    assert.deepEqual(tabStops, ['▾ Staged Changes · 1'],
        'the Files tree exposes one roving Tab stop, not one stop per row');

    // ↓ walks the visible depth-first order.
    const stagedHeader = page.locator(
        '.conversation-changes-group-header', { hasText: 'Staged Changes' });
    await stagedHeader.focus();
    const visibleText = [];
    for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press('ArrowDown');
        visibleText.push(await page.evaluate(() =>
            document.activeElement.textContent.trim()));
    }
    assert.deepEqual(visibleText, [
        '▾src/auth',
        'Msession.ts',
        '▾ Changes · 2',
        '▾src/auth',
        'Ulogin.test.ts',
        'Mlogin.ts',
    ], 'ArrowDown follows the visible tree order without leaving the tree');

    // Home/End jump to the first and last visible item.
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => document.activeElement),
        await stagedHeader.evaluate(element => element));
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() =>
        document.activeElement.textContent.trim()), 'Mlogin.ts');

    // ← collapses an expanded parent, then moves a collapsed child or leaf
    // to its parent; → expands a collapsed parent and enters an expanded one.
    const changesFolder = page.locator(
        '.conversation-changes-folder', { hasText: 'src/auth' }).nth(1);
    await changesFolder.focus();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await changesFolder.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement),
        await changesFolder.evaluate(element => element),
        'collapsing keeps focus on the folder');
    assert.equal(
        await page.locator('.conversation-changes-file', {
            hasText: 'login.test.ts',
        }).isVisible(),
        false);
    await page.keyboard.press('ArrowRight');
    assert.equal(await changesFolder.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() =>
        document.activeElement.textContent.trim()), '▾src/auth',
        'ArrowRight expands without stealing focus');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => document.activeElement),
        await changesFolder.evaluate(element => element),
        'a leaf moves to its parent');

    // Enter and Space activate the same behavior as click; a file posts the
    // open-file intent instead of navigating.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() =>
        document.activeElement.textContent.trim()), 'Mlogin.ts');
    await page.keyboard.press('Enter');
    assert.deepEqual((await postedIntents(page)).at(-1), {
        type: 'conversation-viewer-changes-open-file',
        version: 1,
        memberId: 'm-api',
        group: 'changes',
        xy: ' M',
        path: 'src/auth/login.ts',
        originalPath: undefined,
        ...changesActionBinding(),
    });
    await page.keyboard.press('Space');
    assert.deepEqual((await postedIntents(page)).at(-1), {
        type: 'conversation-viewer-changes-open-file',
        version: 1,
        memberId: 'm-api',
        group: 'changes',
        xy: ' M',
        path: 'src/auth/login.ts',
        originalPath: undefined,
        ...changesActionBinding(),
    });

    // Collapse All moves focus from a hidden child back to its group header;
    // a refresh that removes the focused file falls back to the nearest
    // visible ancestor (PRD §17).
    const changesHeader = page.locator(
        '.conversation-changes-group-header', { hasText: 'Changes · 2' })
        .last();
    const foldToggle = page.locator('[data-changes-fold-toggle]');
    await foldToggle.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-fold-toggle]')), true,
        'keyboard activation leaves focus on the fold toggle');
    assert.equal(await foldToggle.getAttribute('aria-label'), 'Expand all');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-fold-toggle]')), true,
        'expanding also preserves the toggle focus');
    assert.equal(await foldToggle.getAttribute('aria-label'),
        'Collapse all');

    await page.locator('.conversation-changes-file', {
        hasText: 'login.test.ts',
    }).focus();
    // Programmatic activation keeps the focused tree row active, unlike a
    // Playwright click which focuses the toolbar button first.
    await foldToggle.evaluate(element => element.click());
    assert.equal(await page.evaluate(() => document.activeElement),
        await changesHeader.evaluate(element => element),
        'folding a focused child away restores its group header');

    await foldToggle.evaluate(element => element.click());
    const focusedFile = page.locator('.conversation-changes-file', {
        hasText: 'login.test.ts',
    });
    await focusedFile.focus();
    await sendChanges(page, changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2, taskFileCount: 4,
            items: [
                { group: 'changes', xy: ' M', path: 'src/auth/login.ts' },
                { group: 'staged', xy: 'M ', path: 'src/auth/session.ts' },
            ],
            truncated: false,
        },
    }));
    assert.equal(await page.evaluate(() => document.activeElement),
        await page.locator('.conversation-changes-file', {
            hasText: 'login.ts',
        }).evaluate(element => element),
        'a removed focused file lands on its nearest visible sibling');
});

test('WORKTREE-CHANGES-PANEL-001 clears remembered fold state on session reset', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    const changesButton = page.locator('[data-telemetry-changes]');
    await changesButton.click();
    await changesButton.evaluate(element => {
        window.__changesButtonBeforeSessionReset = element;
    });
    const stagedHeader = page.locator('.conversation-changes-group-header', {
        hasText: 'Staged Changes',
    });
    await stagedHeader.click();
    assert.equal(await stagedHeader.getAttribute('aria-expanded'), 'false');

    // A session switch advances the subscription generation; the changes
    // controller adopts it through resetSession, which wipes every
    // remembered fold and pulls a fresh state (PRD §15.2/§15.3).
    const generation = await page.evaluate(() =>
        Number(document.body.getAttribute('data-subscription-generation')));
    await sendPage(page, {
        ...hostileConversationPage,
        requestId: 100,
        subscriptionGeneration: generation + 1,
        updateKind: 'initial',
        html: messageHtml('next-session', 1),
        outline: [{
            interactionId: 'next-session-0',
            userPreview: 'next session',
            responseState: 'complete',
        }],
        selectedInteractionId: 'next-session-0',
        selectedInput: 1,
        totalInputs: 1,
        target: {
            projectId: 'project-1',
            provider: 'codex',
            sessionId: 'session-next',
            interactionId: 'next-session-0',
            displayName: 'Next session',
        },
        comments: { revision: 0, comments: [] },
        projectComments: { revision: 0, comments: [] },
        bookmarks: { revision: 0, interactionIds: [] },
    });
    assert.deepEqual((await postedIntents(page)).at(-1), {
        type: 'conversation-viewer-changes-refresh',
        version: 1,
        ...changesActionBinding({
            subscriptionGeneration: generation + 1,
            projectId: 'project-1',
            sessionId: 'session-next',
        }),
    }, 'resetSession pulls the new session\'s state with its own binding');
    assert.equal(
        await page.locator('[data-changes-fold-toggle]').isDisabled(), true,
        'no state means nothing to fold');
    assert.equal(await changesButton.isVisible(), true,
        'the Changes telemetry button stays mounted through a session handoff');
    assert.equal(await page.evaluate(() =>
        window.__changesButtonBeforeSessionReset
            === document.querySelector('[data-telemetry-changes]')), true,
    'the handoff keeps the same button node rather than flashing a replacement');
    assert.equal(await page.locator('[data-telemetry-changes-value]').innerText(),
        '', 'the old session\'s counts disappear before the new state arrives');
    assert.equal(await changesButton.getAttribute('aria-label'),
        'Loading changes');
    assert.equal(await changesButton.getAttribute('data-tooltip'),
        'Loading changes…');
    assert.equal((await changesButton.getAttribute('class')).includes(
        'conversation-telemetry-changes-unavailable'), false,
    'the old session\'s unavailable state cannot leak into the handoff');

    // The new session's state starts from clean fold defaults even though
    // the member ids repeat.
    await sendChanges(page, changesFixture());
    const headerAgain = page.locator('.conversation-changes-group-header', {
        hasText: 'Staged Changes',
    });
    assert.equal(await headerAgain.getAttribute('aria-expanded'), 'true',
        'reset clears the remembered collapse');
    assert.equal(
        await page.locator('[data-changes-fold-toggle]').isEnabled(), true);
});

test('WORKTREE-CHANGES-PANEL-001 scrolls long change lists instead of clipping them', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const manyItems = Array.from({ length: 60 }, (_unused, index) => ({
        group: 'changes',
        xy: ' M',
        path: `src/deeply/nested/directory/structure/file-${String(index).padStart(2, '0')}.ts`,
    }));
    await sendChanges(page, changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2, taskFileCount: 60,
            items: manyItems,
            truncated: false,
        },
    }));
    await page.locator('[data-telemetry-changes]').click();
    const groups = page.locator('[data-changes-groups]');
    const metrics = await groups.evaluate(element => ({
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
    }));
    assert.equal(metrics.overflowY, 'auto');
    assert.ok(metrics.scrollHeight > metrics.clientHeight,
        'the list scrolls internally instead of overflowing the panel');
    // The last file is reachable by scrolling to the bottom.
    await groups.evaluate(element => {
        element.scrollTop = element.scrollHeight;
    });
    assert.equal(
        await page.locator('.conversation-changes-file', {
            hasText: 'file-59.ts',
        }).isVisible(),
        true);
});

test('WORKTREE-CHANGES-PANEL-001 degrades partial and retired states without zero-washing', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture({
        aggregate: {
            completeness: 'partial', workingItemCount: 3,
            workingPartial: true, aheadCount: 2,
            aheadPartial: true, allUnreadable: false,
        },
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: 'agent-pivot/fix-login', worktreePath: '/wt/api',
            availability: 'available', workingItemCount: 3,
            aheadCount: 2, truncated: false,
        }, {
            memberId: 'm-gone', repoLabel: 'gone', branchName: '',
            worktreePath: '/wt/gone', availability: 'unreadable',
            workingItemCount: 0, truncated: false,
        }],
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2, taskFileCount: 5,
            items: [], truncated: false,
        },
    }));
    assert.equal(
        await page.locator('[data-telemetry-changes-value]').innerText(),
        '3+',
        'partial working state keeps its + marker; unknown ahead is omitted');
    const tooltip = await page.locator('[data-telemetry-changes]')
        .getAttribute('data-tooltip');
    assert.ok(tooltip.includes('Partial'));

    // Retired: disabled button, no zero, explanatory panel.
    await sendChanges(page, changesFixture({
        kind: 'retired',
        aggregate: {
            completeness: 'unavailable', workingItemCount: 0,
            workingPartial: false, aheadPartial: false,
            allUnreadable: true,
        },
        members: [],
        selectedMemberId: undefined,
        detail: undefined,
    }));
    const retiredButton = page.locator('[data-telemetry-changes]');
    assert.equal(await retiredButton.isDisabled(), false,
        'retired stays clickable so the panel can explain itself');
    assert.equal(await retiredButton.getAttribute('class')
        .then(c => c.includes('conversation-telemetry-changes-unavailable')),
        true);
    assert.ok((await retiredButton.getAttribute('data-tooltip'))
        .includes('has been deleted'));
    await retiredButton.click();
    assert.ok((await page.locator('[data-changes-unavailable]').innerText())
        .includes('deleted'));

    // Baseline-unavailable members explain themselves and hide Review.
    await sendChanges(page, changesFixture({
        aggregate: {
            completeness: 'partial', workingItemCount: 1,
            workingPartial: false, aheadPartial: true, allUnreadable: false,
        },
        members: [{
            memberId: 'm-legacy', repoLabel: 'legacy', branchName: 'old/task',
            worktreePath: '/wt/legacy', availability: 'baselineUnavailable',
            workingItemCount: 1, truncated: false,
        }],
        selectedMemberId: 'm-legacy',
        detail: {
            memberId: 'm-legacy', availability: 'baselineUnavailable',
            items: [{ group: 'changes', xy: ' M', path: 'src/keep.ts' }],
            truncated: false,
        },
    }));
    assert.equal(
        await page.locator('[data-telemetry-changes-value]').innerText(),
        '1',
        'unknown ahead is omitted from the button entirely');
    assert.equal(
        await page.locator('[data-changes-review]').isHidden(), true,
        'a review action without a baseline is hidden, not dead');

    // Stale generations are ignored.
    await sendChanges(page, changesFixture({
        aggregate: {
            completeness: 'complete', workingItemCount: 9,
            workingPartial: false, aheadCount: 9,
            aheadPartial: false, allUnreadable: false,
        },
        members: [{
            memberId: 'm-x', repoLabel: 'x', branchName: 'b',
            worktreePath: '/wt/x', availability: 'available',
            workingItemCount: 9, aheadCount: 9, truncated: false,
        }],
        selectedMemberId: 'm-x',
        detail: undefined,
    }), 999);
    assert.equal(
        await page.locator('[data-telemetry-changes-value]').innerText(), '1',
        'a stale generation never overwrites the current state');
});

test('CONVERSATION-COMMENTS-PILL-001 shows session · workspace open counts refreshed from both stacks', async t => {
    const interactionId = 'input-pill-counts';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 700, height: 700 },
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

    const pill = page.locator('[data-telemetry-comments]');
    const pillText = () => page
        .locator('[data-telemetry-comments-value]')
        .innerText();
    assert.equal(await pill.isVisible(), true);
    assert.equal(await pillText(), '0 · 0');

    // Session mutations drive the first count.
    await page.locator('[data-comment-action="new"]').click();
    await page.locator('[data-comment-input]').fill('Note for the session.');
    await page.locator('[data-comment-input]').press('Control+Enter');
    const sessionAdd = (await postedMessages(page)).at(-1);
    const sessionComment = {
        id: 'c-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Note for the session.',
        status: 'open',
        createdAt: 1000,
    };
    await sendPage(page, commentSettlement(sessionAdd, [sessionComment]));
    assert.equal(await pillText(), '1 · 0');

    // Workspace mutations refresh the second count via the stack's
    // afterSettle hook — no extra wiring.
    await page.locator('[data-comments-tab="workspace"]').click();
    await page.locator('[data-project-comment-action="open-composer"]')
        .click();
    await page.locator('[data-project-comment-input]')
        .fill('Note for the workspace.');
    await page.locator('[data-project-comment-input]').press('Control+Enter');
    const projectAdd = (await postedMessages(page)).at(-1);
    assert.equal(
        projectAdd.type,
        'conversation-viewer-project-comment-mutation'
    );
    const note = {
        id: 'n-1',
        text: 'Note for the workspace.',
        tags: [],
        status: 'open',
        createdAt: 1000,
        dispatches: [],
    };
    await sendPage(page, projectCommentSettlement(projectAdd, [note]));
    assert.equal(await pillText(), '1 · 1');

    // Status flips move only their own stack's count.
    await page.locator(
        '[data-project-comment-id="n-1"]'
            + ' [data-project-comment-action="toggle-status"]'
    ).click();
    const statusRequest = (await postedMessages(page)).at(-1);
    await sendPage(page, projectCommentSettlement(statusRequest, [{
        ...note,
        status: 'done',
        doneAt: 2000,
    }]));
    assert.equal(await pillText(), '1 · 0');

    // The tooltip spells out both counts.
    assert.equal(
        await pill.getAttribute('data-tooltip'),
        '1 open session comment · 0 open workspace notes — click to review'
    );
});

test('CONVERSATION-COMMENTS-CLAMP-001 clamps long cards with an in-memory expand toggle on both stacks', async t => {
    const interactionId = 'input-clamp';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 700, height: 860 },
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

    const longText = Array.from(
        { length: 24 },
        (_, index) => `Line ${index + 1} of a very long comment body.`
    ).join('\n');
    const isClamped = locator => locator
        .locator('.conversation-comment-body')
        .evaluate(element => element.classList.contains('is-clamped'));

    await page.locator('[data-comment-action="new"]').click();
    await page.locator('[data-comment-input]').fill('placeholder');
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    const comments = [{
        id: 'long-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: longText,
        status: 'open',
        createdAt: 1000,
    }, {
        id: 'short-1',
        scope: 'session',
        messageId: '',
        interactionId: '',
        role: 'user',
        quote: '',
        prefix: '',
        suffix: '',
        comment: 'Short note.',
        status: 'open',
        createdAt: 1001,
    }, {
        id: 'long-quote-1',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: longText,
        prefix: 'Alpha ',
        suffix: ' beta gamma.',
        comment: 'Review the selected quote.',
        status: 'open',
        createdAt: 1002,
    }];
    await sendPage(page, commentSettlement(addRequest, comments));

    // A long open card is visually clamped while the full text stays in
    // the DOM; the toggle lives outside the icon actions row.
    const longCard = page.locator('[data-comment-id="long-1"]');
    const longBody = longCard.locator('.conversation-comment-body');
    assert.equal(await isClamped(longCard), true);
    assert.equal(await longBody.textContent(), longText);
    const toggle = longCard.locator('[data-comment-clamp-toggle]');
    assert.equal(await toggle.innerText(), 'Show more');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(
        await longCard
            .locator('.conversation-comment-actions [data-comment-clamp-toggle]')
            .count(),
        0,
        'the clamp toggle stays out of the icon actions row'
    );

    // Short cards never clamp.
    const shortCard = page.locator('[data-comment-id="short-1"]');
    assert.equal(
        await shortCard.locator('[data-comment-clamp-toggle]').count(),
        0
    );
    assert.equal(await isClamped(shortCard), false);

    // A short body with a long quote still shares one card-level clamp
    // toggle; both content regions stay complete in the DOM.
    const quotedCard = page.locator('[data-comment-id="long-quote-1"]');
    const quotedBody = quotedCard.locator('.conversation-comment-body');
    const quotedText = quotedCard.locator(
        '.conversation-comment-quote blockquote'
    );
    assert.equal(await isClamped(quotedCard), false);
    assert.equal(
        await quotedText.evaluate(element =>
            element.classList.contains('is-clamped')
        ),
        true
    );
    assert.equal(await quotedText.textContent(), longText);
    const quoteToggle = quotedCard.locator('[data-comment-clamp-toggle]');
    assert.equal(await quoteToggle.innerText(), 'Show more');
    await quoteToggle.click();
    assert.equal(
        await quotedText.evaluate(element =>
            element.classList.contains('is-clamped')
        ),
        false
    );
    assert.equal(
        await quotedCard.locator('[data-comment-clamp-toggle]').innerText(),
        'Show less'
    );

    // Expand → full height; collapse → clamped again (in-memory only).
    await toggle.click();
    assert.equal(await isClamped(longCard), false);
    const expandedToggle = longCard.locator('[data-comment-clamp-toggle]');
    assert.equal(await expandedToggle.innerText(), 'Show less');
    assert.equal(
        await expandedToggle.getAttribute('aria-expanded'),
        'true'
    );
    await expandedToggle.click();
    assert.equal(await isClamped(longCard), true);
    assert.equal(
        await longCard.locator('[data-comment-clamp-toggle]').innerText(),
        'Show more'
    );

    // Done cards are exempt: a freshly sent card renders expanded once
    // (noteSentComments) with the full body unclamped and no toggle.
    await longCard.locator('[data-comment-action="send-comment"]').click();
    const sendRequest = (await postedMessages(page)).at(-1);
    await sendPage(page, commentSettlement(sendRequest, [{
        ...comments[0],
        status: 'done',
        sentAt: 3000,
    }, comments[1]]));
    assert.equal(await isClamped(longCard), false);
    assert.equal(await longBody.textContent(), longText);
    assert.equal(
        await longCard.locator('[data-comment-clamp-toggle]').count(),
        0,
        'expanded done cards stay unclamped'
    );

    // Collapse the done card, then re-expand it: no clamp either way.
    await longCard.locator('[data-comment-action="toggle-done"]').click();
    assert.equal(
        await longCard.locator('[data-comment-clamp-toggle]').count(),
        0,
        'collapsed done cards never offer a clamp toggle'
    );
    await longCard.locator('.conversation-comment-collapsed-body').click();
    assert.equal(await isClamped(longCard), false);
    assert.equal(await longBody.textContent(), longText);
    assert.equal(
        await longCard.locator('[data-comment-clamp-toggle]').count(),
        0
    );

    // The Workspace stack clamps the same way.
    await page.locator('[data-comments-tab="workspace"]').click();
    await page.locator('[data-project-comment-action="open-composer"]')
        .click();
    await page.locator('[data-project-comment-input]').fill('placeholder');
    await page.locator('[data-project-comment-input]').press('Control+Enter');
    const projectAdd = (await postedMessages(page)).at(-1);
    const note = {
        id: 'wn-1',
        text: longText,
        tags: [],
        status: 'open',
        createdAt: 1000,
        source: {
            provider: 'codex',
            sessionId: 'session-host-document',
            quote: longText,
        },
        dispatches: [],
    };
    await sendPage(page, projectCommentSettlement(projectAdd, [note]));
    const noteCard = page.locator('[data-project-comment-id="wn-1"]');
    const noteBody = noteCard.locator('.conversation-comment-body');
    assert.equal(await isClamped(noteCard), true);
    assert.equal(await noteBody.textContent(), longText);
    const noteQuote = noteCard.locator(
        '.conversation-comment-quote blockquote'
    );
    assert.equal(
        await noteQuote.evaluate(element =>
            element.classList.contains('is-clamped')
        ),
        true
    );
    const noteToggle = noteCard.locator(
        '[data-project-comment-clamp-toggle]'
    );
    assert.equal(await noteToggle.innerText(), 'Show more');
    await noteToggle.click();
    assert.equal(await isClamped(noteCard), false);
    assert.equal(
        await noteCard
            .locator('[data-project-comment-clamp-toggle]')
            .innerText(),
        'Show less'
    );
});

test('CONVERSATION-COMMENTS-CLAMP-001 reveal measures after opening the panel and expands a clamped card', async t => {
    const interactionId = 'input-clamp-reveal';
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
        viewport: { width: 700, height: 860 },
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

    const longText = Array.from(
        { length: 24 },
        (_, index) => `Line ${index + 1} of a very long comment body.`
    ).join('\n');

    // The comment settles while the Comments view is hidden: measurements
    // are meaningless at that point and must be redone on reveal.
    await page.locator('[data-telemetry-comments]').click();
    await page.locator('[data-comment-action="new"]').click();
    await page.locator('[data-comment-input]').fill('placeholder');
    await page.locator('[data-comment-input]').press('Control+Enter');
    const addRequest = (await postedMessages(page)).at(-1);
    const quoteComment = {
        id: 'q-1',
        messageId: `${interactionId}:user`,
        interactionId,
        role: 'user',
        quote: 'safe',
        prefix: '',
        suffix: '',
        comment: longText,
        status: 'open',
        createdAt: 1000,
    };
    await sendPage(page, commentSettlement(addRequest, [quoteComment]));
    const card = page.locator('[data-comment-id="q-1"]');
    assert.equal(await card.locator(
        '.conversation-comment-body'
    ).evaluate(element => element.classList.contains('is-clamped')), true);
    const toggle = card.locator('[data-comment-clamp-toggle]');
    assert.equal(await toggle.textContent(), 'Show more');

    // Clicking the message marker reveals the card fully expanded.
    await page.locator('[data-conversation-position]').click();
    await page.locator('[data-comment-marker]').click();
    assert.equal(await card.evaluate(element =>
        element.classList.contains('conversation-comment-flash')
    ), true);
    assert.equal(await card.locator(
        '.conversation-comment-body'
    ).evaluate(element => element.classList.contains('is-clamped')), false);
    assert.equal(
        await card.locator('[data-comment-clamp-toggle]').textContent(),
        'Show less'
    );
});

test('WORKTREE-CHANGES-PANEL-001 tooltip overlay opens on hover and focus, and closes on Esc, blur, and sidebar close', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();

    const panel = page.locator('[data-conversation-changes]');
    const overlay = page.locator('.conversation-tooltip-overlay');
    const refresh = page.locator('[data-changes-refresh]');

    // Hover: a single overlay node hangs directly off <body> with
    // position: fixed — it escapes every overflow clipping container in the
    // panel. aria-describedby ties the trigger to it so the visible hint
    // and the spoken description share one source (PRD §17).
    await refresh.hover();
    await page.waitForTimeout(250);
    assert.equal(await overlay.count(), 0,
        'brief pointer passes do not create a tooltip overlay');
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await overlay.innerText(), 'Refresh');
    assert.equal(await overlay.getAttribute('role'), 'tooltip');
    assert.equal(
        await overlay.evaluate(element =>
            element.parentElement === document.body),
        true,
        'the overlay is a direct child of <body>'
    );
    assert.equal(
        await overlay.evaluate(element =>
            getComputedStyle(element).position),
        'fixed',
        'the overlay is fixed-positioned, never clipped by panel overflow'
    );
    const overlayId = await overlay.getAttribute('id');
    assert.ok(overlayId, 'the overlay carries an id');
    assert.equal(await refresh.getAttribute('aria-describedby'), overlayId);

    // Leaving the Webview itself closes the hint and drops the description
    // link; no following mouseover event is available to clean it up.
    await refresh.evaluate(button => button.dispatchEvent(new MouseEvent(
        'mouseout', { bubbles: true, relatedTarget: null }
    )));
    assert.equal(await overlay.isHidden(), true);
    assert.equal(await refresh.getAttribute('aria-describedby'), null);

    // Keyboard focus shows the same hint.
    await refresh.focus();
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await overlay.innerText(), 'Refresh');
    assert.equal(await refresh.getAttribute('aria-describedby'), overlayId);

    // Blur closes it — focus landing on the select opens that hint instead.
    await page.locator('[data-changes-member-select]').focus();
    assert.equal(await refresh.getAttribute('aria-describedby'), null);
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await overlay.innerText(), '/wt/api');
    assert.equal(
        await page.locator('[data-changes-member-select]')
            .getAttribute('aria-describedby'),
        overlayId
    );
    assert.match(
        await page.locator('[data-changes-repo-picker]').evaluate(element =>
            getComputedStyle(element.querySelector(
                '.conversation-changes-repo-label')).boxShadow),
        /rgba?\(/,
        'the transparent select receives a visible focus treatment');

    // The branch text itself is keyboard-focusable and its tooltip carries
    // the complete branch name plus worktree path (PRD §15.1/§17).
    const branch = page.locator('[data-changes-branch]');
    await branch.focus();
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await overlay.innerText(),
        'agent-pivot/fix-login\n/wt/api');
    assert.equal(await branch.getAttribute('aria-describedby'), overlayId);

    // Esc closes the focused trigger's hint. (Focus sits inside the
    // sidebar, so the sidebar's own Esc handling also closes the panel —
    // the pre-existing layered behavior from PRD §17.)
    await page.keyboard.press('Escape');
    assert.equal(await overlay.isHidden(), true);
    assert.equal(
        await branch
            .getAttribute('aria-describedby'),
        null
    );

    // Closing the sidebar closes the hint: reopen, re-show, then close.
    await page.locator('[data-telemetry-changes]').click();
    assert.equal(await panel.isVisible(), true);
    await refresh.hover();
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.equal(await overlay.isVisible(), true);
    await page.locator('[data-telemetry-changes]').click();
    await overlay.waitFor({ state: 'hidden' });
    assert.equal(await refresh.getAttribute('aria-describedby'), null);
});

test('WORKTREE-CHANGES-PANEL-001 tooltip overlay stays fixed inside the viewport and closes on panel scroll', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    const manyItems = Array.from({ length: 60 }, (_unused, index) => ({
        group: 'changes',
        xy: ' M',
        path: `src/deeply/nested/directory/structure/file-${String(index).padStart(2, '0')}.ts`,
    }));
    await sendChanges(page, changesFixture({
        detail: {
            memberId: 'm-api', availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount: 2, taskFileCount: 60,
            items: manyItems,
            truncated: false,
        },
    }));
    await page.locator('[data-telemetry-changes]').click();
    const overlay = page.locator('.conversation-tooltip-overlay');
    const groups = page.locator('[data-changes-groups]');
    const viewport = page.viewportSize();
    const overlayBox = () => overlay.evaluate(element => {
        const box = element.getBoundingClientRect();
        return {
            left: box.left, top: box.top,
            right: box.right, bottom: box.bottom,
        };
    });
    const assertInsideViewport = box => {
        assert.ok(box.left >= 0, `left ${box.left} is inside the viewport`);
        assert.ok(box.top >= 0, `top ${box.top} is inside the viewport`);
        assert.ok(box.right <= viewport.width,
            `right ${box.right} is clamped to ${viewport.width}`);
        assert.ok(box.bottom <= viewport.height,
            `bottom ${box.bottom} is clamped to ${viewport.height}`);
    };

    // Trigger at the bottom edge of the scroll container: the hint clamps
    // into the viewport instead of sinking below it or being clipped.
    await groups.evaluate(element => {
        element.scrollTop = element.scrollHeight;
    });
    const lastRow = page.locator('.conversation-changes-file', {
        hasText: 'file-59.ts',
    });
    await lastRow.hover();
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await overlay.innerText(),
        'src/deeply/nested/directory/structure/file-59.ts');
    assertInsideViewport(await overlayBox());

    // Scrolling the panel's scroll container closes the hint.
    await groups.evaluate(element => {
        element.scrollTop = 0;
    });
    await overlay.waitFor({ state: 'hidden' });
    assert.equal(await lastRow.getAttribute('aria-describedby'), null);

    // Trigger at the top edge of the scroll container stays unclipped too.
    const firstRow = page.locator('.conversation-changes-file', {
        hasText: 'file-00.ts',
    });
    await firstRow.hover();
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.equal(await overlay.isVisible(), true);
    assertInsideViewport(await overlayBox());

    // A right-edge trigger (the refresh button at the panel's end) clamps
    // horizontally into the viewport.
    const refresh = page.locator('[data-changes-refresh]');
    await refresh.hover();
    await overlay.waitFor({ state: 'visible', timeout: 900 });
    assert.equal(await overlay.isVisible(), true);
    assert.equal(await overlay.innerText(), 'Refresh');
    assertInsideViewport(await overlayBox());
});

test('WORKTREE-CHANGES-PANEL-001 migrates every native title in the Changes panel to data-tooltip', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();
    const panel = page.locator('[data-conversation-changes]');

    assert.equal(await panel.locator('[title]').count(), 0,
        'no native title survives anywhere inside the Changes panel');

    const refresh = page.locator('[data-changes-refresh]');
    assert.equal(await refresh.getAttribute('title'), null);
    assert.equal(await refresh.getAttribute('data-tooltip'), 'Refresh');
    assert.equal(await refresh.getAttribute('aria-label'), 'Refresh',
        'aria-label still carries the accessible name');

    const openScm = page.locator('[data-changes-open-scm]');
    assert.equal(await openScm.getAttribute('title'), null);
    assert.equal(await openScm.getAttribute('data-tooltip'),
        'Open in Source Control');
    assert.equal(await openScm.getAttribute('aria-label'),
        'Open in Source Control');

    for (const [selector, label] of [
        ['[data-changes-fold-toggle]', 'Collapse all'],
        ['[data-changes-refresh]', 'Refresh'],
        ['[data-changes-open-scm]', 'Open in Source Control'],
    ]) {
        const foldAction = page.locator(selector);
        assert.equal(await foldAction.getAttribute('title'), null);
        assert.equal(await foldAction.getAttribute('data-tooltip'), label);
        assert.equal(await foldAction.getAttribute('aria-label'), label);
    }

    const review = page.locator('[data-changes-review]');
    assert.equal(await review.getAttribute('title'), null);
    assert.ok((await review.getAttribute('data-tooltip'))
        .includes('includes committed and uncommitted changes'));

    const memberSelect = page.locator('[data-changes-member-select]');
    assert.equal(await memberSelect.getAttribute('title'), null);
    assert.equal(await memberSelect.getAttribute('data-tooltip'), '/wt/api',
        'the select reveals the full worktree path through the overlay');

    // File rows keep the full path in the overlay; folder rows the full
    // directory path — neither touches the native title anymore.
    assert.deepEqual(
        await panel.locator('.conversation-changes-file')
            .evaluateAll(elements => elements.map(element => ({
                title: element.getAttribute('title'),
                tooltip: element.getAttribute('data-tooltip'),
            }))),
        [
            { title: null, tooltip: 'src/auth/session.ts' },
            { title: null, tooltip: 'src/auth/login.test.ts' },
            { title: null, tooltip: 'src/auth/login.ts' },
        ]
    );
    assert.deepEqual(
        await panel.locator('.conversation-changes-folder')
            .evaluateAll(elements => elements.map(element => ({
                title: element.getAttribute('title'),
                tooltip: element.getAttribute('data-tooltip'),
            }))),
        [
            { title: null, tooltip: 'src/auth' },
            { title: null, tooltip: 'src/auth' },
        ]
    );
});

// ===== Commits sub-tab (PRD §14.3/§15.4/§15.5) =====

function commitsFixture(overrides = {}) {
    return {
        memberId: 'm-api',
        scope: 'since-start',
        offset: 0,
        historyHead: 'f'.repeat(40),
        commits: [{
            sha: 'c'.repeat(40), subject: 'fix: token refresh race',
            authorName: 'hzcheng', authorTime: 1724000000,
            inTrackingBranch: false,
        }, {
            sha: 'd'.repeat(40), subject: 'chore: setup script',
            authorName: 'hzcheng', authorTime: 1723990000,
            inTrackingBranch: true,
        }],
        hasMore: false,
        ...overrides,
    };
}

async function sendCommitsList(page, payload, generationOverride) {
    const generation = generationOverride || await page.evaluate(() =>
        Number(document.body.getAttribute('data-subscription-generation')));
    // Echo the latest list request's correlation id unless the test
    // overrides it: responses with a superseded requestId are discarded
    // by design (PRD §14.3.4).
    const requestId = payload.requestId || (await postedMessages(page))
        .filter(message =>
            message.type === 'conversation-viewer-commits-list')
        .at(-1)?.requestId;
    await sendPage(page, {
        type: 'conversation-viewer-commits',
        version: 1,
        requestId,
        subscriptionGeneration: generation,
        ...payload,
    });
}

async function openCommitsTab(page) {
    await sendChanges(page, changesFixture());
    await page.locator('[data-telemetry-changes]').click();
    await page.locator('[data-changes-subtab="commits"]').click();
}

test('WORKTREE-CHANGES-COMMITS-001 switching to Commits requests the first page and renders rows', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);

    // Entering the tab requests page 0 of the since-start scope, bound to
    // the session identity and generation (PRD §14.3).
    const request = (await postedIntents(page)).at(-1);
    assert.equal(request.type, 'conversation-viewer-commits-list');
    assert.equal(request.memberId, 'm-api');
    assert.equal(request.scope, 'since-start');
    assert.equal(request.offset, 0);
    assert.equal(request.historyHead, undefined,
        'the first page carries no frozen head');
    assert.match(request.requestId, /^commits-\d+$/);
    assert.equal(request.projectId, 'project-a');
    assert.equal(request.sessionId, 'session-host-document');
    assert.ok(request.subscriptionGeneration >= 1);

    assert.equal(
        await page.locator('[data-changes-subtab="commits"]')
            .getAttribute('aria-selected'),
        'true');
    assert.equal(
        await page.locator('[data-changes-files-view]').isHidden(), true);
    assert.equal(
        await page.locator('[data-changes-commits-view]').isVisible(), true);
    // The fold toggle stays enabled in Commits — it folds commit rows
    // instead of file groups (§15.4); refresh and SCM keep working too.
    // Nothing is loaded yet, so there is nothing to fold.
    assert.equal(
        await page.locator('[data-changes-fold-toggle]').isVisible(), true);
    assert.equal(
        await page.locator('[data-changes-fold-toggle]').isDisabled(), true,
        'no commits loaded means nothing to fold');
    assert.equal(
        await page.locator('[data-changes-refresh]').isEnabled(), true);
    assert.equal(
        await page.locator('[data-changes-open-scm]').isEnabled(), true);

    // Summary and tracking information live on the shared Review icon;
    // the Commits tab begins with the list rather than duplicated headers.
    assert.equal(
        await page.locator('[data-changes-commits-summary]').count(), 0);
    assert.equal(
        await page.locator('[data-changes-commits-tracking]').count(), 0);

    await sendCommitsList(page, commitsFixture());
    const rows = page.locator('.conversation-changes-commit-row');
    assert.equal(await rows.count(), 2);
    assert.equal(await rows.nth(0).getAttribute('aria-label'),
        'ccccccc, fix: token refresh race, not in tracking branch',
        'the badge semantics fold into the row label (§15.5.2)');
    assert.equal(await rows.nth(1).getAttribute('aria-label'),
        'ddddddd, chore: setup script, in tracking branch');
    assert.equal(await rows.nth(0).locator(
        '.conversation-changes-commit-badge').innerText(), '●');
    assert.equal(await rows.nth(1).locator(
        '.conversation-changes-commit-badge').innerText(), '✓');
    assert.match(await rows.nth(0).locator(
        '.conversation-changes-commit-meta').innerText(), /hzcheng · /);

    // No baseline closing row before the section completes (§15.5.6).
    assert.equal(
        await page.locator('.conversation-changes-commit-baseline').count(),
        0);

    // Switching back to Files restores the working tree view.
    await page.locator('[data-changes-subtab="files"]').click();
    assert.equal(
        await page.locator('[data-changes-files-view]').isVisible(), true);
    assert.equal(
        await page.locator('[data-changes-subtab="files"]')
            .getAttribute('aria-selected'),
        'true');
});

test('WORKTREE-CHANGES-COMMITS-001 the sub-tab persists across reloads and sessions', async t => {
    const first = await openHostViewerDocument(t, {});
    await openCommitsTab(first.page);
    assert.equal(
        await first.page.evaluate(() =>
            window.__webviewState.conversationSidebar.changesSubTab),
        'commits');

    // A reload with the persisted state reopens the Commits tab.
    const second = await openHostViewerDocument(t, {
        initialWebviewState: {
            conversationSidebar: {
                open: false, width: 240, view: 'changes', query: '',
                subagentsRunningOnly: false, changesSubTab: 'commits',
            },
        },
    });
    await sendChanges(second.page, changesFixture());
    await second.page.locator('[data-telemetry-changes]').click();
    assert.equal(
        await second.page.locator('[data-changes-subtab="commits"]')
            .getAttribute('aria-selected'),
        'true',
        'the persisted sub-tab restores without a click');
    assert.equal(
        await second.page.locator('[data-changes-commits-view]')
            .isVisible(),
        true);
});

test('WORKTREE-CHANGES-COMMITS-001 expands a commit inline, opens files, and reviews the commit', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());

    const row = page.locator('.conversation-changes-commit-row').first();
    await row.click();
    const detailRequest = (await postedIntents(page)).at(-1);
    assert.equal(detailRequest.type, 'conversation-viewer-commit-detail');
    assert.equal(detailRequest.sha, 'c'.repeat(40));
    assert.equal(await page.evaluate(
        () => document.activeElement === document.querySelector(
            '.conversation-changes-commit-row')),
        true, 'expansion keeps focus on the row');
    assert.match(await page.locator(
        '.conversation-changes-commit-inline-note').innerText(),
        /Loading files/);

    await sendPage(page, {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        requestId: detailRequest.requestId,
        subscriptionGeneration: await page.evaluate(() =>
            Number(document.body.getAttribute(
                'data-subscription-generation'))),
        memberId: 'm-api',
        sha: 'c'.repeat(40),
        files: [{
            path: 'src/auth/login.ts', status: 'M',
            additions: 12, deletions: 3,
        }, {
            path: 'src/auth/new.ts', oldPath: 'src/auth/old.ts',
            status: 'R', additions: 4, deletions: 1,
        }],
        totalFiles: 2,
        filesTruncated: false,
    });
    const fileRows = page.locator('.conversation-changes-commit-file-row');
    assert.equal(await fileRows.count(), 2);
    assert.equal(await fileRows.nth(1).locator(
        '.conversation-changes-commit-file-name')
        .getAttribute('data-tooltip'), 'src/auth/old.ts → src/auth/new.ts');
    assert.equal(await fileRows.nth(0).locator(
        '.conversation-changes-commit-numstat').innerText(), '+12 −3');

    // Clicking a file posts the bound open-file intent.
    await fileRows.first().click();
    const openFile = (await postedIntents(page)).at(-1);
    assert.equal(openFile.type, 'conversation-viewer-commit-open-file');
    assert.equal(openFile.sha, 'c'.repeat(40));
    assert.equal(openFile.path, 'src/auth/login.ts');
    assert.equal(openFile.projectId, 'project-a');

    // Review this commit rides the same binding.
    await page.locator('.conversation-changes-commit-review-row button')
        .click();
    const review = (await postedIntents(page)).at(-1);
    assert.equal(review.type, 'conversation-viewer-commit-review');
    assert.equal(review.sha, 'c'.repeat(40));

    // A stale detail response (superseded requestId) is discarded.
    await sendPage(page, {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        requestId: 'commits-999',
        subscriptionGeneration: await page.evaluate(() =>
            Number(document.body.getAttribute(
                'data-subscription-generation'))),
        memberId: 'm-api',
        sha: 'd'.repeat(40),
        files: [{ path: 'evil.ts', status: 'M' }],
        totalFiles: 1,
        filesTruncated: false,
    });
    assert.equal(await page.locator(
        '.conversation-changes-commit-file-row', { hasText: 'evil.ts' })
        .count(), 0, 'a superseded requestId never renders (§14.3.4)');
});

test('WORKTREE-CHANGES-COMMITS-001 pages with a frozen head, renders the baseline row at the boundary, and continues into Earlier commits', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);

    // First page: hasMore, no closing row yet.
    await sendCommitsList(page, commitsFixture({
        hasMore: true,
        commits: Array.from({ length: 50 }, (_unused, index) => ({
            sha: String(index + 1).padStart(40, 'a'),
            subject: `commit ${index}`, authorName: 'hz',
            authorTime: 1724000000 - index,
        })),
    }));
    assert.equal(
        await page.locator('.conversation-changes-commit-row').count(), 50);
    const more = page.locator('[data-changes-commits-more]');
    assert.equal(await more.isVisible(), true);
    assert.equal(await more.innerText(), 'Load more');

    await more.click();
    const pageTwo = (await postedIntents(page)).at(-1);
    assert.equal(pageTwo.offset, 50);
    assert.equal(pageTwo.historyHead, 'f'.repeat(40),
        'later pages echo the frozen history head (§14.3)');

    // Last page: sectionComplete + baseline closing row.
    await sendCommitsList(page, commitsFixture({
        offset: 50,
        commits: [{
            sha: 'e'.repeat(40), subject: 'oldest', authorName: 'hz',
            authorTime: 1723900000,
        }],
        hasMore: false,
        sectionComplete: true,
        baselineRow: {
            sha: 'a'.repeat(40), subject: 'main · merged #241',
        },
    }), undefined);
    await page.evaluate(() => undefined);
    // The second response needs the requestId the button issued.
    // (It was 'commits-3': tab-open list + load-more.)
    assert.equal(
        await page.locator('.conversation-changes-commit-baseline')
            .innerText(),
        '○ (baseline) main · merged #241');

    // Show full branch history only after the boundary (§15.5.7).
    const full = page.locator('[data-changes-commits-full]');
    assert.equal(await full.isVisible(), true);
    await full.click();
    const earlierRequest = (await postedIntents(page)).at(-1);
    assert.equal(earlierRequest.scope, 'full');
    assert.equal(earlierRequest.offset, 0);

    await sendCommitsList(page, commitsFixture({
        scope: 'full',
        offset: 0,
        commits: [{
            // The baseline sha itself: deduped against the rendered
            // closing row (§14.3).
            sha: 'a'.repeat(40), subject: 'main · merged #241',
            authorName: 'hz', authorTime: 1723800000,
        }, {
            sha: '0'.repeat(40), subject: 'ancient', authorName: 'hz',
            authorTime: 1723700000,
        }],
        hasMore: false,
    }));
    assert.match(await page.locator(
        '.conversation-changes-commit-earlier-header').innerText(),
        /Earlier commits/);
    const subjects = await page.locator(
        '.conversation-changes-commit-subject').allInnerTexts();
    assert.ok(subjects.indexOf('ancient')
        > subjects.indexOf('oldest'),
        'the Earlier section appends below the since-start section');
    assert.equal(subjects.filter(subject =>
        subject === 'main · merged #241').length, 0,
        'the baseline row is never duplicated as a commit row');
});

test('WORKTREE-CHANGES-COMMITS-001 degrades honestly: timeout retries, history-moved restarts, unreadable notices', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);

    await sendCommitsList(page, commitsFixture({
        commits: [], hasMore: false, historyHead: '', degraded: 'timeout',
    }));
    assert.equal(await page.locator(
        '[data-changes-commits-error]').isVisible(), true);
    await page.locator('[data-changes-commits-retry]').click();
    const retry = (await postedIntents(page)).at(-1);
    assert.equal(retry.type, 'conversation-viewer-commits-list');
    assert.equal(retry.offset, 0, 'Retry restarts the first page');

    await sendCommitsList(page, commitsFixture(), undefined);
    await page.evaluate(() => undefined);
    assert.equal(
        await page.locator('.conversation-changes-commit-row').count(), 2,
        'the retry renders the recovered list');

    // history-moved: paged data is discarded and the scope restarts.
    await sendCommitsList(page, commitsFixture({
        degraded: 'history-moved', historyHead: 'e'.repeat(40),
        commits: [], hasMore: false,
    }));
    const restart = (await postedIntents(page)).at(-1);
    assert.equal(restart.type, 'conversation-viewer-commits-list');
    assert.equal(restart.offset, 0);
    assert.equal(restart.historyHead, undefined,
        'a history-moved restart drops the stale frozen head');

    // Unreadable member: the tab shows a notice, the Files tab is intact.
    await sendChanges(page, changesFixture({
        members: [{
            memberId: 'm-api', repoLabel: 'api',
            branchName: 'agent-pivot/fix-login', worktreePath: '/gone',
            availability: 'unreadable', workingItemCount: 0,
            truncated: false,
        }],
        selectedMemberId: 'm-api',
        detail: {
            memberId: 'm-api', availability: 'unreadable',
            items: [], truncated: false,
        },
    }));
    await page.locator('[data-changes-subtab="commits"]').click();
    assert.match(await page.locator(
        '[data-changes-commits-notice]').innerText(), /unavailable/);
});

test('WORKTREE-CHANGES-COMMITS-001 a changed invalidation signature silently refetches; an unchanged one does not', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());
    const before = (await postedIntents(page)).length;

    // Same signature → no refetch.
    await sendChanges(page, changesFixture());
    assert.equal((await postedIntents(page)).length, before,
        'an unchanged signature re-renders without a new request');

    // headSha moved (a commit landed) → silent refetch of the first page.
    const moved = changesFixture();
    moved.members[0].headSha = 'e'.repeat(40);
    moved.members[0].aheadCount = 3;
    await sendChanges(page, moved);
    const refetch = (await postedIntents(page)).at(-1);
    assert.equal(refetch.type, 'conversation-viewer-commits-list');
    assert.equal(refetch.offset, 0);
    assert.equal(refetch.historyHead, undefined);
});

test('WORKTREE-CHANGES-COMMITS-001 switching members clears the list and restores the cached one on return', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());
    assert.equal(
        await page.locator('.conversation-changes-commit-row').count(), 2);

    const memberState = (selectedMemberId, aheadCount) => changesFixture({
        selectedMemberId,
        detail: {
            memberId: selectedMemberId, availability: 'available',
            baselineSha: 'a'.repeat(40), aheadCount, taskFileCount: 1,
            items: [], truncated: false,
        },
    });

    // Switch to m-web: the list clears immediately into loading (§14.3.3).
    await sendChanges(page, memberState('m-web', 0));
    assert.equal(
        await page.locator('.conversation-changes-commit-row').count(), 0,
        'the previous member\'s commits never linger (§14.3.3)');
    assert.equal(
        await page.locator('[data-changes-commits-loading]').isVisible(),
        true);
    const webRequest = (await postedIntents(page))
        .filter(message =>
            message.type === 'conversation-viewer-commits-list')
        .at(-1);
    assert.equal(webRequest.memberId, 'm-web');

    await sendCommitsList(page, {
        memberId: 'm-web',
        scope: 'since-start',
        offset: 0,
        historyHead: 'f'.repeat(40),
        commits: [{
            sha: '7'.repeat(40), subject: 'web commit', authorName: 'hz',
            authorTime: 1724000000,
        }],
        hasMore: false,
    });
    assert.equal(await page.locator(
        '.conversation-changes-commit-row').count(), 1);

    // Back to m-api: the valid cache renders instantly, no new request.
    const count = (await postedIntents(page)).filter(message =>
        message.type === 'conversation-viewer-commits-list').length;
    await sendChanges(page, memberState('m-api', 2));
    assert.equal(
        await page.locator('.conversation-changes-commit-row').count(), 2,
        'a valid per-member cache renders instantly on return');
    assert.equal(
        (await postedIntents(page)).filter(message =>
            message.type === 'conversation-viewer-commits-list').length,
        count,
        'no refetch for a valid cache (§15.2 per-member memory)');
});

test('WORKTREE-CHANGES-COMMITS-001 the commits list implements the keyboard model', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());

    const firstRow = page.locator('.conversation-changes-commit-row').first();
    await firstRow.focus();
    // Enter expands and keeps the row focused.
    await page.keyboard.press('Enter');
    const detailRequest = (await postedIntents(page)).at(-1);
    assert.equal(detailRequest.type, 'conversation-viewer-commit-detail');
    await sendPage(page, {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        requestId: detailRequest.requestId,
        subscriptionGeneration: await page.evaluate(() =>
            Number(document.body.getAttribute(
                'data-subscription-generation'))),
        memberId: 'm-api',
        sha: 'c'.repeat(40),
        files: [{ path: 'src/a.ts', status: 'M', additions: 1,
            deletions: 0 }],
        totalFiles: 1,
        filesTruncated: false,
    });

    // ArrowDown moves into the expanded file row; Enter opens it.
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() =>
        document.activeElement.classList.contains(
            'conversation-changes-commit-file-row')), true);
    await page.keyboard.press('Enter');
    const openFile = (await postedIntents(page)).at(-1);
    assert.equal(openFile.type, 'conversation-viewer-commit-open-file');
    assert.equal(openFile.path, 'src/a.ts');

    // ArrowUp back to the commit row, ArrowLeft collapses it.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator(
        '.conversation-changes-commit-file-row').count(), 0);
    assert.equal(
        await firstRow.getAttribute('aria-expanded'), 'false');

    // Home/End bound the traversal.
    await page.keyboard.press('End');
    assert.equal(await page.evaluate(() =>
        document.activeElement.getAttribute('data-commit-sha')),
        'd'.repeat(40));
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() =>
        document.activeElement.getAttribute('data-commit-sha')),
        'c'.repeat(40));
});

test('WORKTREE-CHANGES-COMMITS-001 ArrowLeft on a leaf row moves to the parent commit and the review row is no Tab stop', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());

    const firstRow = page.locator('.conversation-changes-commit-row').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    const detailRequest = (await postedIntents(page))
        .filter(message =>
            message.type === 'conversation-viewer-commit-detail')
        .at(-1);
    await sendPage(page, {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        requestId: detailRequest.requestId,
        subscriptionGeneration: await page.evaluate(() =>
            Number(document.body.getAttribute(
                'data-subscription-generation'))),
        memberId: 'm-api',
        sha: 'c'.repeat(40),
        files: [{ path: 'src/a.ts', status: 'M', additions: 1,
            deletions: 0 }],
        totalFiles: 1,
        filesTruncated: false,
    });

    // The review row owns the keyboard stop; its button is not a separate
    // Tab stop (PRD §17 one-stop tree).
    assert.equal(await page.locator(
        '.conversation-changes-commit-review-row button')
        .getAttribute('tabindex'), '-1');

    // ArrowDown into the file row, ArrowLeft back to the parent commit.
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() =>
        document.activeElement.classList.contains(
            'conversation-changes-commit-file-row')), true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() =>
        document.activeElement.classList.contains(
            'conversation-changes-commit-row')), true,
        'a leaf row\'s ArrowLeft lands on its parent commit');
    assert.equal(await page.evaluate(() =>
        document.activeElement.getAttribute('data-commit-sha')),
        'c'.repeat(40));
});

test('WORKTREE-CHANGES-COMMITS-001 collapsing an in-flight detail keeps the row collapsed when the response lands', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());

    // Expand, then collapse before the detail response arrives.
    const row = page.locator('.conversation-changes-commit-row').first();
    await row.click();
    const detailRequest = (await postedIntents(page))
        .filter(message =>
            message.type === 'conversation-viewer-commit-detail')
        .at(-1);
    assert.equal(detailRequest.sha, 'c'.repeat(40));
    await row.click();
    assert.equal(await row.getAttribute('aria-expanded'), 'false');

    // The late response is correlated but must not re-expand the row.
    await sendPage(page, {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        requestId: detailRequest.requestId,
        subscriptionGeneration: await page.evaluate(() =>
            Number(document.body.getAttribute(
                'data-subscription-generation'))),
        memberId: 'm-api',
        sha: 'c'.repeat(40),
        files: [{ path: 'src/a.ts', status: 'M', additions: 1,
            deletions: 0 }],
        totalFiles: 1,
        filesTruncated: false,
    });
    assert.equal(await page.locator(
        '.conversation-changes-commit-file-row').count(), 0,
        'a collapsed row never re-expands from an in-flight response');
    assert.equal(await row.getAttribute('aria-expanded'), 'false');
});

test('WORKTREE-CHANGES-COMMITS-001 focus falls back to the parent commit or the sub-tab when the focused row vanishes', async t => {
    const { page } = await openHostViewerDocument(t, {});
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());

    // Expand the first commit and focus its file row.
    const firstRow = page.locator('.conversation-changes-commit-row').first();
    await firstRow.focus();
    await page.keyboard.press('Enter');
    const detailRequest = (await postedIntents(page))
        .filter(message =>
            message.type === 'conversation-viewer-commit-detail')
        .at(-1);
    await sendPage(page, {
        type: 'conversation-viewer-commit-detail',
        version: 1,
        requestId: detailRequest.requestId,
        subscriptionGeneration: await page.evaluate(() =>
            Number(document.body.getAttribute(
                'data-subscription-generation'))),
        memberId: 'm-api',
        sha: 'c'.repeat(40),
        files: [{ path: 'src/a.ts', status: 'M', additions: 1,
            deletions: 0 }],
        totalFiles: 1,
        filesTruncated: false,
    });
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() =>
        document.activeElement.classList.contains(
            'conversation-changes-commit-file-row')), true);

    // A changed signature silently refetches (§14.3.2): the paged rows
    // are discarded and the focused file row vanishes — focus must land
    // on the sub-tab, never the document body.
    const moved = changesFixture();
    moved.members[0].headSha = 'e'.repeat(40);
    moved.members[0].aheadCount = 3;
    await sendChanges(page, moved);
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-subtab="commits"]')),
        true,
        'focus retreats to the sub-tab while the list reloads (§17)');

    // The refetched list renders; focus stays on the sub-tab until the
    // user re-enters (no focus yanking from a background response).
    await sendCommitsList(page, commitsFixture());
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-subtab="commits"]')),
        true);
});

test('WORKTREE-CHANGES-COMMITS-001 the fold toggle expands and collapses every loaded commit row', async t => {
    const { page } = await openHostViewerDocument(t, {
        includeStyles: true,
        themeFixture: viewerThemeFixtures[0],
    });
    await openCommitsTab(page);
    await sendCommitsList(page, commitsFixture());

    const toggle = page.locator('[data-changes-fold-toggle]');
    assert.equal(await toggle.isEnabled(), true);
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand all',
        'nothing expanded yet — the toggle offers Expand all');

    // Expand all: one detail request per loaded commit.
    await toggle.click();
    const details = (await postedIntents(page)).filter(message =>
        message.type === 'conversation-viewer-commit-detail');
    assert.deepEqual(details.map(message => message.sha),
        ['c'.repeat(40), 'd'.repeat(40)],
        'expand all fans out one detail request per commit');
    assert.equal(await page.locator(
        '.conversation-changes-commit-inline-note').count(), 2,
        'every row shows its inline loading state');

    const generation = await page.evaluate(() =>
        Number(document.body.getAttribute('data-subscription-generation')));
    for (const request of details) {
        await sendPage(page, {
            type: 'conversation-viewer-commit-detail',
            version: 1,
            requestId: request.requestId,
            subscriptionGeneration: generation,
            memberId: 'm-api',
            sha: request.sha,
            files: [{ path: 'src/a.ts', status: 'M', additions: 1,
                deletions: 0 }],
            totalFiles: 1,
            filesTruncated: false,
        });
    }
    assert.equal(await page.locator(
        '.conversation-changes-commit-file-row').count(), 2);
    assert.equal(await toggle.getAttribute('aria-label'), 'Collapse all',
        'expanded rows flip the toggle to Collapse all');

    // Collapse all clears every expansion; like the Files fold actions,
    // activating the toggle keeps focus on the toggle itself (§15.3).
    await toggle.click();
    assert.equal(await page.locator(
        '.conversation-changes-commit-file-row').count(), 0);
    assert.equal(await page.evaluate(() =>
        document.activeElement
            === document.querySelector('[data-changes-fold-toggle]')), true,
        'activating the toggle keeps focus on it');
    assert.equal(await toggle.getAttribute('aria-label'), 'Expand all');
});
