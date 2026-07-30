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
const viewerCss = fs.readFileSync(
    path.join(__dirname, '../../media/conversationViewer.css'),
    'utf8'
);
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
                data-subscription-generation="1">
                <header>
                    <span data-conversation-position>Input 0 of 0</span>
                    <button type="button" data-action="previous">Previous</button>
                    <button type="button" data-action="next">Next</button>
                    <button type="button" data-action="latest">Latest</button>
                    <button type="button" data-action="close">Close</button>
                </header>
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
    await page.addScriptTag({ content: purifyScript });
    if (options.includeMermaid) {
        await page.addScriptTag({ content: mermaidScript });
    }
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

function messageHtml(prefix, count, start = 0) {
    return Array.from({ length: count }, (_item, index) => {
        const id = `${prefix}-${start + index}`;
        return `<article data-message-id="${id}" data-interaction-id="${id}">
            <section><p>${id}</p></section>
        </article>`;
    }).join('');
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
                userPreview: id,
                userGraphemeCount: id.length,
                responseState: 'complete',
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
    await page.getByRole('button', { name: 'Close' }).click();

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

test('CONVERSATION-COMMENTS-LAYOUT-001 toggles, resizes, and restores the comments panel', async t => {
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
    const toggle = page.locator('[data-action="toggle-comments"]');
    const panel = page.locator('[data-conversation-comments]');
    const resizer = page.locator('[data-comments-resizer]');

    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await resizer.getAttribute('aria-valuenow'), '240');

    await resizer.press('ArrowLeft');
    await resizer.press('ArrowLeft');
    assert.equal(await resizer.getAttribute('aria-valuenow'), '272');
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState),
        { conversationCommentsPanel: { open: true, width: 272 } }
    );

    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.isHidden(), true);
    assert.equal(await resizer.isHidden(), true);
    assert.deepEqual(
        await page.evaluate(() => window.__webviewState),
        { conversationCommentsPanel: { open: false, width: 272 } }
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
        await restored.page.locator('[data-conversation-comments]').isHidden(),
        true
    );
    await restoredToggle.click();
    assert.equal(
        await restored.page.locator('[data-comments-resizer]')
            .getAttribute('aria-valuenow'),
        '312'
    );
});

test('CONVERSATION-COMMENTS-UI-001 CONVERSATION-COMMENTS-REVIEW-001 reviews multiple anchored selections as one correlated batch', async t => {
    const interactionId = 'input-comments';
    const { page } = await openHostViewerDocument(t, {
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
        ['Sent', 'Sent']
    );
    assert.equal(
        await page.locator('[data-comment-action="send"]').isDisabled(),
        true
    );
    assert.equal(
        await page.locator('[data-conversation-status]').textContent(),
        'Comments sent to this session.'
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
        selectedInteractionId: 'selected-2',
        selectedInput: 3,
    });
    assert.equal(await page.evaluate(() =>
        document.activeElement
            && document.activeElement.getAttribute('data-interaction-id')
    ), 'selected-2');
});

test('CONVERSATION-VIEWER-PARTIAL-001 labels capped input positions and partial history', async t => {
    const page = await openViewerPage(t);
    await sendPage(page, {
        ...hostileConversationPage,
        html: messageHtml('partial', 2),
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
