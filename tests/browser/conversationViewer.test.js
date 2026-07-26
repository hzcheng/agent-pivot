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
const viewerScript = fs.readFileSync(
    path.join(__dirname, '../../src/webview/conversationViewerScripts.js'),
    'utf8'
);

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

async function openViewerPage(t) {
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
                markdown: '[safe](https://example.test/safe)',
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

async function openHostViewerDocument(t, options) {
    const page = await browser.newPage({ viewport: { width: 700, height: 500 } });
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
        if (pathname === '/conversationViewer.css') {
            await route.fulfill({ contentType: 'text/css', body: '' });
            return;
        }
        await route.fulfill({ contentType: 'text/html', body: html });
    });
    await page.addInitScript(() => {
        window.__acquireCount = 0;
        window.__postedMessages = [];
        window.acquireVsCodeApi = () => {
            window.__acquireCount += 1;
            return {
                postMessage(message) {
                    window.__postedMessages.push(message);
                },
            };
        };
    });
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

test('CONVERSATION-VIEWER-BROWSER-SCROLL-001 auto-follows at exactly 8px but not at 9px', async t => {
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
    await scroll.evaluate(element => {
        element.scrollTop = element.scrollHeight - element.clientHeight - 8;
    });
    await sendPage(page, {
        ...baseMessage,
        requestId: 2,
        updateKind: 'refresh',
        html: appendedHtml,
        totalInputs: 21,
    });
    assert.equal(await scroll.evaluate(element =>
        Math.round(element.scrollHeight - element.scrollTop - element.clientHeight)
    ), 0);

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

test('CONVERSATION-VIEWER-BROWSER-REFRESH-001 preserves a real Host history window at 9px and auto-follows at 8px', async t => {
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
        if (distance === 9) {
            assert.equal(
                await scroll.evaluate(element => element.scrollTop),
                before
            );
            assert.equal(await page.getByRole('button', {
                name: 'New response content',
            }).isVisible(), true);
        } else {
            assert.equal(await scroll.evaluate(element =>
                Math.round(element.scrollHeight - element.scrollTop
                    - element.clientHeight)
            ), 0);
            assert.equal(await page.getByRole('button', {
                name: 'New response content',
            }).isHidden(), true);
        }
    }
});
