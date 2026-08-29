'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const childProcess = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function fakeUri(value) {
    return {
        scheme: value.split(':', 1)[0],
        path: value,
        fsPath: value,
        toString: () => value,
    };
}

const fakeVscode = {
    ViewColumn: { Active: 1, Beside: 2 },
    Uri: { parse: value => fakeUri(value) },
};

function loadConversationViewer() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/conversation/viewer');
    } finally {
        Module._load = previousLoad;
    }
}

const { ConversationViewer } = loadConversationViewer();
const {
    ChangesCollector,
} = require('../../../out/worktrees/changesCollector');
const {
    CommitsCollector,
} = require('../../../out/worktrees/commitsCollector');

function git(cwd, args) {
    return childProcess.execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

async function worktreeChangesFixture(t) {
    const sandbox = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'agent-pivot-changes-viewer-'));
    const repo = path.join(sandbox, 'repository');
    await fs.promises.mkdir(repo);
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.name', 'Agent Pivot Tests']);
    git(repo, ['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(repo, 'tracked.ts'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'fixture']);
    const baselineSha = git(repo, ['rev-parse', 'HEAD']);
    const worktreePath = path.join(sandbox, 'worktree');
    git(repo, ['worktree', 'add', '-b', 'agent-pivot/task', worktreePath]);
    await fs.promises.writeFile(path.join(worktreePath, 'changed.ts'), 'x\n');
    t.after(async () =>
        fs.promises.rm(sandbox, { recursive: true, force: true }));
    return { repo, worktreePath, baselineSha };
}

const {
    ConversationError,
} = require('../../../out/aiSessions/conversation/types');
const {
    formatConversationClockTime,
} = require('../../../out/aiSessions/conversation/text');
const {
    KimiConversationAdapter,
} = require('../../../out/aiSessions/conversation/kimiAdapter');
const {
    CodexConversationAdapter,
} = require('../../../out/aiSessions/conversation/codexAdapter');
const {
    buildConversationPage,
} = require('../../../out/aiSessions/conversation/model');

const timedCodexFixture = JSON.parse(fs.readFileSync(path.resolve(
    __dirname,
    '../../fixtures/conversations/codex/thread-read-timed.json'
), 'utf8'));

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function target(sessionId, interactionId = 'input-1', overrides = {}) {
    return {
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
        interactionId,
        expectedRevision: 'r1',
        displayName: `Conversation ${sessionId}`,
        duplicateDisplayName: false,
        ...overrides,
    };
}

function page(
    sessionId,
    interactionId = 'input-1',
    visible = 'visible',
    options = {}
) {
    const count = options.count || 1;
    const interactionOffset = options.interactionOffset || 0;
    const padding = options.padding || '';
    const interactionIds = options.interactionIds || Array.from(
        { length: count },
        (_item, index) => index === 0
            ? interactionId
            : `${interactionId}-${interactionOffset + index}`
    );
    return {
        provider: 'codex',
        sessionId,
        sourceRevision: options.sourceRevision || 'r1',
        anchorInteractionId: options.anchorInteractionId || interactionIds[0],
        messages: interactionIds.map((id, index) => ({
            id: `${id}:user`,
            interactionId: id,
            role: 'user',
            markdown: `${visible}-${index}${padding}`,
        })),
        interactionStates: interactionIds.map(id => ({
            interactionId: id,
            responseState: options.responseStates?.[id] || 'complete',
        })),
        previousCursor: options.previousCursor,
        nextCursor: options.nextCursor,
        isStart: options.previousCursor === undefined,
        isEnd: options.nextCursor === undefined,
    };
}

function outline(sessionId, interactionIds, options = {}) {
    return {
        provider: 'codex',
        sessionId,
        sourceRevision: options.sourceRevision || 'r1',
        interactions: interactionIds.map(id => ({
            id,
            userPreview: id,
            userGraphemeCount: id.length,
            responseState: options.responseStates?.[id] || 'complete',
        })),
        totalInteractions: options.totalInteractions || interactionIds.length,
        partial: options.partial || false,
    };
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

function decodeDocumentId(html) {
    const match = html.match(/data-document-id="([^"]*)"/);
    assert.ok(match, 'Host document must carry a document identity');
    return match[1];
}

// Delta publications omit the HTML string when the rendered content is
// identical to what the Webview already applied. Content assertions must
// therefore target the last publication that actually carried HTML.
function lastContentPublication(panel) {
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && typeof message.html === 'string'
    ).at(-1);
    assert.ok(publication, 'a content-bearing publication must exist');
    return publication;
}

// A real Webview acknowledges every publication it applies. State-only
// envelopes — restored auxiliary revisions and the subagent list — are
// withheld until that receipt proves the base content is actually on screen,
// so a harness asserting them has to model the receipt.
async function acknowledgeLatestPublication(panel) {
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1) || decodeInitialPublication(panel.webview.html);
    assert.ok(publication, 'a publication must exist to acknowledge');
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    for (let attempt = 0; attempt < 6; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
}

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 renders a modest latest page in one publication', async () => {
    const sessionId = 'progressive-page';
    const interactionIds = Array.from(
        { length: 30 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));

    const initial = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(initial.html, /Loading earlier messages/);
    assert.match(initial.html, /message-0/);
    assert.match(initial.html, /message-29/);
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).length, 0, 'the modest page must not wait for a second full refresh');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 paints the recent window before backfilling a heavy short page', async () => {
    const sessionId = 'progressive-heavy-short-page';
    let now = 10;
    const timings = [];
    const interactionIds = Array.from(
        { length: 30 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        now: () => now,
        onTiming: timing => timings.push(timing),
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
            padding: 'x'.repeat(4 * 1024),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));

    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);
    assert.doesNotMatch(partial.html, /message-0/);
    assert.match(partial.html, /message-29/);

    now = 35;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });
    assert.deepEqual(timings, [{
        source: 'open',
        updateKind: 'initial',
        delivery: 'document',
        applicationMs: 25,
        contentBytes: Buffer.byteLength(partial.html, 'utf8'),
        progressive: true,
        loadMs: 25,
    }], 'diagnostics must identify the lightweight first paint, without session data');
    const chunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(chunk, 'the deferred prefix must backfill after the first paint');
    assert.match(chunk.html, /message-4/);
    assert.doesNotMatch(chunk.html, /message-0/);
    assert.ok(Buffer.byteLength(chunk.html, 'utf8') <= 64 * 1024,
        'each deferred slice must be bounded by its actual Webview HTML, not source estimates');
    let nextChunk = chunk;
    while (!nextChunk.complete) {
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: nextChunk.subscriptionGeneration,
            requestId: nextChunk.requestId,
            htmlSignature: nextChunk.htmlSignature,
        });
        nextChunk = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
    }
    await panel.receive({
        type: 'conversation-viewer-history-chunk-applied',
        version: 1,
        subscriptionGeneration: nextChunk.subscriptionGeneration,
        requestId: nextChunk.requestId,
        htmlSignature: nextChunk.htmlSignature,
    });
    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(completion?.html, undefined,
        'the final reconciliation must reuse the fully backfilled content');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 bounds the first paint of an unusually heavy latest window', async () => {
    const sessionId = 'progressive-heavy-latest-window';
    const interactionIds = Array.from(
        { length: 30 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
            padding: 'x'.repeat(16 * 1024),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));

    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /message-29/);
    assert.doesNotMatch(partial.html, /message-26/,
        'the first paint must stay within its byte budget, not always render twelve messages');
    assert.ok(Buffer.byteLength(partial.html, 'utf8') <= 64 * 1024,
        'the first paint budget must apply to generated HTML, not only source messages');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 tightens a markdown-expanded first paint by rendered HTML bytes', async () => {
    const sessionId = 'progressive-rendered-html-budget';
    const interactionIds = Array.from(
        { length: 10 },
        (_item, index) => `input-${index}`
    );
    const codeBlock = `\`\`\`typescript\n${
        'const value = Promise.resolve({ answer: 42 });\n'.repeat(180)
    }\`\`\``;
    const messages = interactionIds.map((interactionId, index) => ({
        id: `expanded-${index}`,
        interactionId,
        role: 'assistant',
        markdown: `marker-${index}\n${codeBlock}`,
    }));
    assert.ok(Buffer.byteLength(messages.map(message => message.markdown).join(''), 'utf8')
        < 96 * 1024, 'the raw Markdown must remain below the source-size trigger');
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: 'r1',
            anchorInteractionId: interactionIds.at(-1),
            messages,
            interactionStates: interactionIds.map(interactionId => ({
                interactionId,
                responseState: 'complete',
            })),
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));

    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /marker-9/);
    assert.doesNotMatch(partial.html, /marker-7/,
        'syntax-highlighted HTML must shrink the source-sized recent window further');
    assert.ok(Buffer.byteLength(partial.html, 'utf8') <= 64 * 1024,
        'the visible first paint must remain bounded after Markdown expansion');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 byte-triggers below the count threshold without splitting a visible interaction', async () => {
    const sessionId = 'progressive-utf8-short-page';
    const latestInteractionId = 'input-latest';
    const interactionIds = [
        ...Array.from({ length: 8 }, (_item, index) => `input-${index}`),
        latestInteractionId,
    ];
    const messages = Array.from({ length: 10 }, (_item, index) => ({
        id: `message-${index}`,
        interactionId: index >= 8 ? latestInteractionId : `input-${index}`,
        role: 'user',
        markdown: `marker-${index}-${'界'.repeat(10_000)}`,
    }));
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: 'r1',
            anchorInteractionId: latestInteractionId,
            messages,
            interactionStates: interactionIds.map(interactionId => ({
                interactionId,
                responseState: 'complete',
            })),
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, latestInteractionId));

    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /marker-8-/,
        'the first member of the final interaction must remain visible');
    assert.match(partial.html, /marker-9-/,
        'the final interaction must remain whole at a byte boundary');
    assert.doesNotMatch(partial.html, /marker-7-/,
        'a short-by-count but heavy UTF-8 page must defer older history');
    assert.match(partial.html, /Loading earlier messages/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 ignores hidden Thinking payloads when choosing a first paint', async () => {
    const sessionId = 'progressive-hidden-thinking';
    const interactionIds = Array.from(
        { length: 30 },
        (_item, index) => `input-${index}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: 'r1',
            anchorInteractionId: interactionIds.at(-1),
            messages: interactionIds.map((interactionId, index) => ({
                id: `thinking-${index}`,
                interactionId,
                role: 'thinking',
                markdown: 'hidden-thinking',
                thinking: { text: 'x'.repeat(8 * 1024) },
            })),
            interactionStates: interactionIds.map(interactionId => ({
                interactionId,
                responseState: 'complete',
            })),
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));

    const initial = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(initial.html, /Loading earlier messages/,
        'hidden Thinking must not create a visible progressive-loading detour');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 keeps an oversized latest interaction atomic', async () => {
    const sessionId = 'progressive-oversized-latest-atomic';
    const latestInteractionId = 'input-latest';
    const messages = [
        {
            id: 'latest-user', interactionId: latestInteractionId,
            role: 'user', markdown: 'Inspect the long worklog',
        },
        ...Array.from({ length: 6 }, (_item, index) => ({
            id: `latest-tool-${index}`, interactionId: latestInteractionId,
            role: 'tool', markdown: '',
            tool: {
                name: 'Shell', summary: `command-${index}`,
                detail: 'x'.repeat(16 * 1024),
            },
        })),
        {
            id: 'latest-answer', interactionId: latestInteractionId,
            role: 'assistant', markdown: 'Final answer.',
        },
    ];
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, [
            'input-earlier',
            latestInteractionId,
        ]),
        readPage: async () => ({
            provider: 'codex', sessionId, sourceRevision: 'r1',
            anchorInteractionId: latestInteractionId, messages,
            interactionStates: [{
                interactionId: latestInteractionId,
                responseState: 'complete',
            }],
            isStart: true, isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, latestInteractionId));

    const initial = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(initial.html, /Loading earlier messages/);
    assert.match(initial.html, /command-0/);
    assert.match(initial.html, /Final answer/);
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).length, 0,
        'a group-derived worklog must never be reconstructed by blind prepends');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 completes a recovered recent-message page', async () => {
    const sessionId = 'progressive-recovery';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
    });
    const recovered = decodeInitialPublication(panel.webview.html);
    assert.notEqual(recovered.requestId, partial.requestId);
    assert.match(recovered.html, /Loading earlier messages/);

    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recovered.subscriptionGeneration,
        requestId: recovered.requestId,
        htmlSignature: recovered.htmlSignature,
    });
    const firstChunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(firstChunk, 'the recovered partial page must resume backfill');
    assert.match(firstChunk.html, /message-64/);
    assert.doesNotMatch(firstChunk.html, /message-0/);

    let chunk = firstChunk;
    while (chunk) {
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: chunk.subscriptionGeneration,
            requestId: chunk.requestId,
            htmlSignature: chunk.htmlSignature,
        });
        if (chunk.complete) {
            break;
        }
        chunk = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
    }
    assert.ok(chunk?.complete, 'the recovered backfill must reach history start');
    const complete = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(complete?.html, undefined);
    assert.equal(complete?.updateKind, 'refresh');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 recovers a dropped complete progressive page', async () => {
    const sessionId = 'progressive-completion-timeout';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const timers = new Map();
    let nextTimer = 1;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });
    const timer = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(timer, 'the complete progressive page must be acknowledged');

    timer.callback();
    const recovered = lastContentPublication(panel);
    assert.doesNotMatch(recovered.html, /Loading earlier messages/);
    assert.match(recovered.html, /message-0/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 recovers a lost first progressive acknowledgement', async () => {
    const sessionId = 'progressive-first-ack-timeout';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const timers = new Map();
    let nextTimer = 1;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    const timer = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(timer, 'the initial progressive page must be acknowledged');

    timer.callback();
    const recovered = decodeInitialPublication(panel.webview.html);
    assert.notEqual(recovered.requestId, partial.requestId);
    assert.match(recovered.html, /Loading earlier messages/);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recovered.subscriptionGeneration,
        requestId: recovered.requestId,
        htmlSignature: recovered.htmlSignature,
    });
    assert.ok(panel.postedMessages.some(message =>
        message.type === 'conversation-viewer-history-chunk'
    ), 'the recovered document must resume its bounded history backfill');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 transfers the incomplete-content watchdog across authority suspension', async () => {
    const sessionId = 'progressive-authority-rollover';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const timers = new Map();
    let nextTimer = 1;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    await viewer.reconcileAuthority(() => false);
    const staleFull = lastContentPublication(panel);
    assert.doesNotMatch(staleFull.html, /Loading earlier messages/);
    const timer = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(timer, 'the authority-rollover full page must be acknowledged');

    timer.callback();
    const recovered = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(recovered.html, /Loading earlier messages/);
    assert.match(recovered.html, /message-0/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 keeps an interaction group intact at the progressive boundary', async () => {
    const sessionId = 'progressive-group-boundary';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => {
            const result = page(sessionId, interactionIds[0], 'message', {
                interactionIds,
                anchorInteractionId: interactionIds.at(-1),
            });
            result.messages.splice(89, 0,
                {
                    id: 'input-90:progress',
                    interactionId: 'input-90',
                    role: 'progress',
                    markdown: 'group-progress',
                },
                {
                    id: 'input-90:assistant',
                    interactionId: 'input-90',
                    role: 'assistant',
                    markdown: 'group-answer',
                }
            );
            return result;
        },
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    assert.match(recent.html, /message-89/);
    assert.match(recent.html, /group-progress/);
    assert.match(recent.html, /group-answer/);
    assert.doesNotMatch(recent.html, /message-88/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 backfills a long history in ack-paced chunks', async () => {
    const sessionId = 'progressive-chunked-backfill';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    assert.match(recent.html, /Loading earlier messages/);
    assert.match(recent.html, /message-99/);
    assert.doesNotMatch(recent.html, /message-87/);

    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });

    // 88 deferred messages arrive as four slices, nearest the visible tail
    // first; each next slice is sent only after the previous one applied.
    const chunkRanges = [[64, 88], [40, 64], [16, 40], [0, 16]];
    for (const [index, [start, end]] of chunkRanges.entries()) {
        const sentChunks = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        );
        assert.equal(sentChunks.length, index + 1,
            'the next slice is sent only after the previous receipt');
        const chunk = sentChunks.at(-1);
        assert.ok(chunk, `chunk ${index + 1} must be published`);
        assert.equal(
            chunk.complete,
            index === chunkRanges.length - 1,
            'only the oldest slice completes the backfill'
        );
        assert.match(chunk.html, new RegExp(`message-${end - 1}`));
        assert.match(chunk.html, new RegExp(`message-${start}`));
        assert.doesNotMatch(chunk.html, new RegExp(`message-${start - 1}`));
        assert.doesNotMatch(chunk.html, new RegExp(`message-${end}`));
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: chunk.subscriptionGeneration,
            requestId: chunk.requestId,
            htmlSignature: chunk.htmlSignature,
        });
    }

    // History fully applied: a final refresh publication converges the
    // session. The content is unchanged, so its HTML stays off the wire.
    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(completion, 'the completion publication must exist');
    assert.equal(completion.updateKind, 'refresh');
    assert.equal(completion.html, undefined);
    assert.equal(typeof completion.htmlSignature, 'string');
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: completion.subscriptionGeneration,
        requestId: completion.requestId,
        htmlSignature: completion.htmlSignature,
    });
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).length,
        chunkRanges.length,
        'no further chunks after completion'
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 defers post-load revalidation while the backfill is open', async () => {
    const sessionId = 'progressive-revalidate';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    let outlineReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async () => {
            outlineReads += 1;
            return outline(sessionId, interactionIds);
        },
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);

    // The dashboard's post-load hygiene revalidation arrives before the
    // partial page's receipt. It must defer: a refresh here would advance
    // the request counter, orphan the receipt, and cancel the backfill.
    await viewer.revalidateLatest(interactionIds.at(-1));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
                && message.updateKind === 'refresh'
        ).length,
        0,
        'revalidation must not supersede an open backfill'
    );

    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });

    const chunkRanges = [[64, 88], [40, 64], [16, 40], [0, 16]];
    for (const [index, [start, end]] of chunkRanges.entries()) {
        const sentChunks = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        );
        assert.equal(sentChunks.length, index + 1,
            'the partial receipt must anchor the chunked backfill');
        const chunk = sentChunks.at(-1);
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: chunk.subscriptionGeneration,
            requestId: chunk.requestId,
            htmlSignature: chunk.htmlSignature,
        });
        assert.equal(chunk.complete, index === chunkRanges.length - 1);
    }

    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(completion, 'the completion publication must exist');
    const readsBeforeCompletion = outlineReads;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: completion.subscriptionGeneration,
        requestId: completion.requestId,
        htmlSignature: completion.htmlSignature,
    });

    // The obligation is closed; the deferred freshness check runs exactly
    // once. Content is unchanged, so it settles as a read without a
    // publication (its retained-revision short-circuit publishes nothing).
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(outlineReads, readsBeforeCompletion + 1,
        'the deferred revalidation re-reads exactly once after completion');
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
                && message.requestId > completion.requestId
        ).length,
        0,
        'an unchanged revalidation publishes nothing new'
    );
    viewer.dispose();
});

// A session-watch invalidation whose content turns out to be unchanged is the
// most common event during a first paint: the provider rewrites its transcript
// while the deferred history is still being backfilled. That refresh claims the
// request counter before it can know it will publish nothing, so it must hand
// the counter back — otherwise the in-flight slice's receipt is orphaned and
// the reader is left with a "Loading earlier messages" placeholder forever.
test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 keeps the deferred backfill alive across an unchanged session-watch refresh', async () => {
    const sessionId = 'progressive-watch-noop';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    let invalidate;
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
        watch: (_provider, _sessionId, onChange) => {
            invalidate = onChange;
            return { dispose() {} };
        },
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });
    const firstChunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(firstChunk, 'the partial receipt must anchor the backfill');

    // The transcript is touched while that slice is in flight.
    invalidate();
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    // Drain the rest of the history. Every receipt must still be correlated,
    // so each one releases the next slice through to the session start.
    let applied = firstChunk;
    for (let slice = 0; slice < 8 && !applied.complete; slice++) {
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: applied.subscriptionGeneration,
            requestId: applied.requestId,
            htmlSignature: applied.htmlSignature,
        });
        applied = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
    }
    assert.equal(applied.complete, true,
        'an unchanged refresh must not strand the deferred history');
    viewer.dispose();
});

// The same invalidation can also land before the Webview reports its first
// paint. The partial page is still the authoritative document, so its receipt
// must still be able to plan the backfill.
test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 plans the deferred backfill when an unchanged refresh precedes the first receipt', async () => {
    const sessionId = 'progressive-watch-noop-preflight';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    let invalidate;
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
        watch: (_provider, _sessionId, onChange) => {
            invalidate = onChange;
            return { dispose() {} };
        },
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);

    invalidate();
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });
    assert.ok(
        panel.postedMessages.some(message =>
            message.type === 'conversation-viewer-history-chunk'
        ),
        'the partial receipt must still plan the deferred backfill'
    );
    viewer.dispose();
});

// A superseding load that genuinely owns the counter can still stall before it
// publishes. The incomplete-content obligation is the Webview's only promise
// that its placeholder will resolve, so it carries its own watchdog: one
// full-content refresh converges the document instead of stranding the reader.
test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 recovers deferred history stranded by a load that never publishes', async () => {
    const sessionId = 'progressive-obligation-watchdog';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const timers = new Map();
    let nextTimer = 1;
    let invalidate;
    let outlineReads = 0;
    let stallPageReads = false;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => {
            outlineReads += 1;
            // The second read reports a completed turn, so the refresh cannot
            // take its unchanged short-circuit and must re-read the page.
            return outline(sessionId, interactionIds, outlineReads > 1
                ? { responseStates: { [interactionIds.at(-1)]: 'inProgress' } }
                : {});
        },
        readPage: async () => {
            if (stallPageReads) {
                await new Promise(() => {});
            }
            return page(sessionId, interactionIds[0], 'message', {
                interactionIds,
                anchorInteractionId: interactionIds.at(-1),
            });
        },
        watch: (_provider, _sessionId, onChange) => {
            invalidate = onChange;
            return { dispose() {} };
        },
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });
    const chunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(chunk, 'the partial receipt must anchor the backfill');

    // A refresh claims the counter and never returns from its page read.
    stallPageReads = true;
    invalidate();
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    // The in-flight slice's receipt is orphaned by that load.
    await panel.receive({
        type: 'conversation-viewer-history-chunk-applied',
        version: 1,
        subscriptionGeneration: chunk.subscriptionGeneration,
        requestId: chunk.requestId,
        htmlSignature: chunk.htmlSignature,
    });
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    const watchdog = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(watchdog,
        'an open incomplete-content obligation must be watched');
    watchdog.callback();
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    const recovered = lastContentPublication(panel);
    assert.equal(recovered.updateKind, 'refresh');
    assert.doesNotMatch(recovered.html, /Loading earlier messages/,
        'the recovery must retire the deferred-history placeholder');
    assert.match(recovered.html, /message-0/);
    assert.match(recovered.html, /message-99/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 continues across a page boundary to the session start', async () => {
    const sessionId = 'progressive-boundary';
    const olderInteractions = ['input-1', 'input-2'];
    const recentInteractions = ['input-3', 'input-4', 'input-5'];
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, [
            ...olderInteractions,
            ...recentInteractions,
        ]),
        readPage: async request => {
            requests.push(request);
            if (request.direction === 'before') {
                // The older page reaches the session start.
                return page(sessionId, 'input-1', 'message', {
                    interactionIds: olderInteractions,
                    anchorInteractionId: 'input-1',
                });
            }
            // The opening page stops mid-session: earlier history sits
            // behind a cursor boundary.
            return {
                ...page(sessionId, 'input-5', 'message', {
                    interactionIds: recentInteractions,
                    anchorInteractionId: 'input-5',
                }),
                previousCursor: 'cursor-1',
                isStart: false,
            };
        },
    });

    await viewer.open(target(sessionId, 'input-5'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(initial.html, /data-message-id="input-1:user"/,
        'the opening page stops before the session start');

    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    // The retained-window settle does NOT walk the boundary: loading older
    // pages is on demand, so a page that stops mid-session must not
    // publish the older page until the user scrolls to the top.
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(requests.filter(request => request.direction === 'before').length,
        0,
        'the older page must stay off the wire until requested');

    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });

    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        const latest = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1);
        if (latest && typeof latest.html === 'string'
            && /data-message-id="input-1:user"/.test(latest.html)) {
            break;
        }
    }
    assert.ok(requests.some(request => request.direction === 'before'),
        'the boundary walk must request the previous page on demand');
    const walked = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(walked, 'the boundary walk must publish the merged page');
    assert.match(walked.html, /data-message-id="input-1:user"/);
    assert.match(walked.html, /data-message-id="input-5:user"/);
    assert.doesNotMatch(walked.html, /Loading earlier messages/);
    assert.equal(walked.selectedInteractionId, 'input-5',
        'the walk preserves the user selection');
    viewer.dispose();
});

test('CONVERSATION-HISTORY-PAGING-001 prepends an indexed page older than the outline window', async () => {
    const sessionId = 'indexed-history-boundary';
    const olderInteractions = ['input-1', 'input-2'];
    const recentInteractions = ['input-2001', 'input-2002'];
    let onChange;
    let responseState = 'inProgress';
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        // The outline deliberately retains only the most recent window. The
        // older page is valid via its opaque cursor but must not become the
        // selected outline item merely because it was prepended.
        readOutline: async () => outline(sessionId, recentInteractions, {
            totalInteractions: 2_002,
            partial: true,
            responseStates: { 'input-2002': responseState },
        }),
        readPage: async request => request.direction === 'before'
            ? page(sessionId, 'input-1', 'message', {
                interactionIds: olderInteractions,
                anchorInteractionId: 'input-1',
            })
            : {
                ...page(sessionId, 'input-2002', 'message', {
                    interactionIds: recentInteractions,
                    anchorInteractionId: 'input-2002',
                    responseStates: { 'input-2002': responseState },
                }),
                previousCursor: 'indexed-cursor',
                isStart: false,
            },
    });

    await viewer.open(target(sessionId, 'input-2002'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        const latest = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1);
        if (latest?.html?.includes('data-message-id="input-1:user"')) {
            break;
        }
    }
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.match(publication.html, /data-message-id="input-1:user"/);
    assert.equal(publication.selectedInteractionId, 'input-2002');
    // A same-revision lifecycle refresh must not rebuild retained pages only
    // from the bounded outline and erase the older cursor-authorized page.
    responseState = 'complete';
    onChange();
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        const latest = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1);
        if (latest?.interactionStates?.some(state =>
            state.interactionId === 'input-2002'
                && state.responseState === 'complete')) {
            break;
        }
    }
    const refreshed = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.match(refreshed.html, /data-message-id="input-1:user"/);
    viewer.dispose();
});

test('CONVERSATION-HISTORY-PAGING-002 advances the outline revision after a stale earlier-page retry', async () => {
    const requests = [];
    let revision = 'r1';
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-2001', 'input-2002'],
            { sourceRevision: revision, totalInteractions: 2_002, partial: true }
        ),
        readPage: async request => {
            requests.push(request);
            if (request.direction === 'before' && request.expectedRevision === 'r1') {
                revision = 'r2';
                throw new ConversationError('staleRevision');
            }
            return request.direction === 'before'
                ? page(request.sessionId, 'input-1', 'older', {
                    interactionIds: ['input-1'],
                    sourceRevision: request.expectedRevision,
                })
                : {
                    ...page(request.sessionId, 'input-2002', 'recent', {
                        interactionIds: ['input-2001', 'input-2002'],
                        sourceRevision: request.expectedRevision,
                    }),
                    previousCursor: 'older-cursor',
                    isStart: false,
                };
        },
    });
    await viewer.open(target('history-stale', 'input-2002'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        if (panel.postedMessages.some(message =>
            message.type === 'conversation-viewer-load-earlier-result'
                && message.requestId === 1 && message.outcome === 'busy')) {
            break;
        }
    }
    assert.equal(viewer.outlineController.snapshot.sourceRevision, 'r2');
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 2,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        if (requests.some(request => request.direction === 'before'
            && request.expectedRevision === 'r2')) {
            break;
        }
    }
    assert.ok(requests.some(request => request.direction === 'before'
        && request.expectedRevision === 'r2'),
    `a stale around fallback must leave the boundary retryable: ${JSON.stringify(requests)}`);
    viewer.dispose();
});

test('CONVERSATION-HISTORY-PAGING-003 refreshes the page boundary after history indexing completes', async () => {
    const sessionId = 'indexed-history-complete';
    let indexed = false;
    let onChange;
    let beforeRequests = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, ['input-2001', 'input-2002'], {
            sourceRevision: 'r1',
            totalInteractions: indexed ? 2_002 : 2,
            partial: !indexed,
        }),
        readPage: async request => {
            if (request.direction === 'before') {
                beforeRequests += 1;
                return page(sessionId, 'input-1', 'older', {
                    interactionIds: ['input-1'],
                    sourceRevision: 'r1',
                });
            }
            return {
                ...page(sessionId, 'input-2002', 'recent', {
                    interactionIds: ['input-2001', 'input-2002'],
                    anchorInteractionId: 'input-2002',
                    sourceRevision: 'r1',
                }),
                ...(indexed ? { previousCursor: 'complete-history-cursor' } : {}),
                isStart: !indexed,
            };
        },
    });
    await viewer.open(target(sessionId, 'input-2002'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });
    indexed = true;
    onChange();
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        const latest = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1);
        if (latest?.totalInteractions === 2_002) {
            break;
        }
    }
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    for (let attempt = 0; attempt < 20 && !beforeRequests; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(beforeRequests, 1,
        `the completed index must refresh the cursor-authorized page boundary: ${JSON.stringify(panel.postedMessages)}`);
    viewer.dispose();
});

test('CONVERSATION-HISTORY-PAGING-004 keeps an outer cursor when a refresh only overlaps its page', async () => {
    const sessionId = 'history-partial-edge-refresh';
    let responseState = 'inProgress';
    let onChange;
    let beforeRequests = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, ['input-1', 'input-2', 'input-3'], {
            sourceRevision: 'r1',
            responseStates: { 'input-2': responseState },
        }),
        readPage: async request => {
            if (request.direction === 'before') {
                beforeRequests += 1;
                return page(sessionId, 'input-0', 'older', {
                    interactionIds: ['input-0'],
                    sourceRevision: 'r1',
                });
            }
            return responseState === 'inProgress'
                ? page(sessionId, 'input-1', 'initial', {
                    interactionIds: ['input-1', 'input-2'],
                    anchorInteractionId: 'input-2',
                    sourceRevision: 'r1',
                    responseStates: { 'input-2': responseState },
                })
                : {
                    ...page(sessionId, 'input-2', 'refresh', {
                        interactionIds: ['input-2', 'input-3'],
                        anchorInteractionId: 'input-2',
                        sourceRevision: 'r1',
                        responseStates: { 'input-2': responseState },
                    }),
                    previousCursor: 'input-2-boundary',
                    isStart: false,
                };
        },
    });
    await viewer.open(target(sessionId, 'input-2'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });
    responseState = 'complete';
    onChange();
    for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        if (panel.postedMessages.some(message =>
            message.type === 'conversation-viewer-page'
                && message.outline?.some(item => item.interactionId === 'input-3'))) {
            break;
        }
    }
    const refreshed = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(refreshed.previousCursor, '');
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(beforeRequests, 0,
        'an interior cursor must not be promoted to the oldest retained boundary');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 settles a stalled earlier-page read', async () => {
    const sessionId = 'progressive-boundary-timeout';
    const interactionIds = ['input-1', 'input-2'];
    const timers = new Map();
    let nextTimer = 1;
    let resolveBefore;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async request => {
            if (request.direction === 'before') {
                return new Promise(resolve => {
                    resolveBefore = resolve;
                });
            }
            return {
                ...page(sessionId, 'input-2', 'message', {
                    interactionIds: ['input-2'],
                    anchorInteractionId: 'input-2',
                }),
                previousCursor: 'cursor-1',
                isStart: false,
            };
        },
    });

    await viewer.open(target(sessionId, 'input-2'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    const timer = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(timer, 'the earlier-page read must have a bounded wait');

    timer.callback();
    assert.deepEqual(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-load-earlier-result'
    ).at(-1), {
        type: 'conversation-viewer-load-earlier-result',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: 1,
        outcome: 'timed-out',
    });
    // A provider may resolve after it has observed cancellation. That late
    // result must neither publish stale history nor send a second settlement.
    resolveBefore({
        ...page(sessionId, 'input-1', 'late message', {
            interactionIds,
            anchorInteractionId: 'input-1',
        }),
        isStart: true,
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-load-earlier-result'
    ).length, 1, 'a timed-out request settles exactly once');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 stops the boundary walk when a prepend makes no progress', async () => {
    const sessionId = 'progressive-boundary-stuck';
    const interactions = ['input-1', 'input-2'];
    let beforeRequests = 0;
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactions),
        readPage: async request => {
            if (request.direction === 'before') {
                beforeRequests += 1;
                // A pathological page that reports no new boundary: the
                // prepended content leaves the oldest interaction unchanged.
                return {
                    ...page(sessionId, 'input-2', 'message', {
                        interactionIds: ['input-2'],
                        anchorInteractionId: 'input-2',
                    }),
                    previousCursor: 'cursor-stuck',
                    isStart: false,
                };
            }
            return {
                ...page(sessionId, 'input-2', 'message', {
                    interactionIds: ['input-2'],
                    anchorInteractionId: 'input-2',
                }),
                previousCursor: 'cursor-stuck',
                isStart: false,
            };
        },
    });

    await viewer.open(target(sessionId, 'input-2'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    // The user requests an older page; the walk makes no progress and must
    // not loop: its own publication receipt must not re-arm the same
    // boundary, and a further request hits the stuck boundary guard.
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
        if (beforeRequests >= 1) break;
    }
    const lastPublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    if (lastPublication) {
        await panel.receive({
            type: 'conversation-viewer-applied',
            version: 1,
            subscriptionGeneration: lastPublication.subscriptionGeneration,
            requestId: lastPublication.requestId,
            htmlSignature: lastPublication.htmlSignature,
        });
    }
    await panel.receive({
        type: 'conversation-viewer-load-earlier',
        version: 1,
        requestId: 2,
        subscriptionGeneration: initial.subscriptionGeneration,
    });
    for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(beforeRequests, 1,
        'a no-progress walk must not be retried on its own receipt');
    assert.deepEqual(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-load-earlier-result'
    ).at(-1), {
        type: 'conversation-viewer-load-earlier-result',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: 2,
        outcome: 'stalled',
    }, 'a blocked boundary must settle the matching Webview request');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 recovers a lost history chunk with a full refresh', async () => {
    const sessionId = 'progressive-chunk-timeout';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const timers = new Map();
    let nextTimer = 1;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });
    const chunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(chunk, 'the first history chunk must be published');
    const timer = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(timer, 'an unacknowledged chunk must be watched');

    timer.callback();
    const recovered = lastContentPublication(panel);
    assert.equal(recovered.type, 'conversation-viewer-page');
    assert.equal(recovered.updateKind, 'refresh');
    assert.doesNotMatch(recovered.html, /Loading earlier messages/);
    assert.match(recovered.html, /message-0/);
    assert.match(recovered.html, /message-99/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 defers restored auxiliary state until the backfill completes', async () => {
    const sessionId = 'progressive-chunk-auxiliary';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const commentStore = {
        async load() {
            return { revision: 7, comments: [] };
        },
        async save() {},
    };
    const { viewer, panel } = createViewer({
        commentStore,
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });
    // Let the comment restore settle while the backfill is in flight.
    await new Promise(resolve => setTimeout(resolve, 0));
    const chunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(chunk, 'the backfill must be in flight');
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).length,
        0,
        'auxiliary state must not supersede the in-flight backfill'
    );

    // Drain the backfill.
    for (;;) {
        const pendingChunk = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
        if (!pendingChunk) {
            break;
        }
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: pendingChunk.subscriptionGeneration,
            requestId: pendingChunk.requestId,
            htmlSignature: pendingChunk.htmlSignature,
        });
        if (pendingChunk.complete) {
            break;
        }
    }
    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(completion, 'the completion publication must exist');
    assert.equal(completion.comments.revision, 7);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 cancels the backfill when an authority rollover supersedes it', async () => {
    const sessionId = 'progressive-chunk-rollover';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });
    const chunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(chunk, 'the backfill must be in flight');

    await viewer.reconcileAuthority(() => false);
    const staleFull = lastContentPublication(panel);
    assert.doesNotMatch(staleFull.html, /Loading earlier messages/);
    assert.match(staleFull.html, /message-0/);

    // A late receipt for the canceled chunk must not restart the backfill.
    await panel.receive({
        type: 'conversation-viewer-history-chunk-applied',
        version: 1,
        subscriptionGeneration: chunk.subscriptionGeneration,
        requestId: chunk.requestId,
        htmlSignature: chunk.htmlSignature,
    });
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: staleFull.subscriptionGeneration,
        requestId: staleFull.requestId,
        htmlSignature: staleFull.htmlSignature,
    });
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).length,
        1,
        'no further chunks after the rollover superseded the backfill'
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 avoids a deferred window for a modest page', async () => {
    const sessionId = 'progressive-chunk-boundary';
    const interactionIds = Array.from(
        { length: 60 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(initial.html, /Loading earlier messages/);
    assert.match(initial.html, /message-0/);
    assert.match(initial.html, /message-59/);
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).length, 0);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 keeps interaction groups intact across chunk boundaries', async () => {
    const sessionId = 'progressive-chunk-groups';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => {
            const result = page(sessionId, interactionIds[0], 'message', {
                interactionIds,
                anchorInteractionId: interactionIds.at(-1),
            });
            // A group larger than one slice, plus a group straddling a
            // nominal slice boundary (message index 88 starts the first
            // slice; input-40's group spans the 64|65 boundary).
            const grouped = [];
            for (let index = 0; index < 30; index += 1) {
                grouped.push({
                    id: `input-40:extra-${index}`,
                    interactionId: 'input-40',
                    role: 'progress',
                    markdown: `group-40-note-${index}`,
                });
            }
            result.messages.splice(40, 0, ...grouped);
            return result;
        },
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    assert.match(recent.html, /Loading earlier messages/);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });

    const seen = [];
    for (;;) {
        const chunk = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
        if (!chunk) {
            break;
        }
        const notes = chunk.html.match(/group-40-note-\d+/g) ?? [];
        assert.equal(
            notes.length === 0 || notes.length === 30,
            true,
            'a group larger than a slice stays inside one chunk'
        );
        if (notes.length) {
            assert.equal(seen.length, 0,
                'the oversized group appears exactly once');
        }
        seen.push(...notes);
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: chunk.subscriptionGeneration,
            requestId: chunk.requestId,
            htmlSignature: chunk.htmlSignature,
        });
        if (chunk.complete) {
            break;
        }
    }
    assert.equal(seen.length, 30, 'every grouped message arrives once');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-003 keeps the progressive render when an auxiliary restore lands before the first receipt', async () => {
    const sessionId = 'progressive-chunk-early-auxiliary';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const restoredComments = deferred();
    const { viewer, panel } = createViewer({
        commentStore: {
            load: () => restoredComments.promise,
            async save() {},
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    assert.match(recent.html, /Loading earlier messages/);
    assert.equal(recent.comments.revision, 0,
        'the readable page must not wait for the auxiliary restore');
    // The auxiliary restore settles after the publication but before its
    // receipt. It must not win that race by re-rendering the whole
    // conversation: restoring comments is a state change, so it waits for the
    // deferred history instead of discarding the progressive first paint.
    restoredComments.resolve({ revision: 7, comments: [] });
    await new Promise(resolve => setImmediate(resolve));
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });

    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).length,
        0,
        'the auxiliary restore must not supersede the progressive page'
    );

    // The backfill runs to the session start in ack-paced slices.
    let applied = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(applied, 'the receipt must still plan the deferred backfill');
    for (let slice = 0; slice < 8 && !applied.complete; slice++) {
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: applied.subscriptionGeneration,
            requestId: applied.requestId,
            htmlSignature: applied.htmlSignature,
        });
        applied = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
    }
    assert.equal(applied.complete, true, 'the backfill must reach history start');
    await panel.receive({
        type: 'conversation-viewer-history-chunk-applied',
        version: 1,
        subscriptionGeneration: applied.subscriptionGeneration,
        requestId: applied.requestId,
        htmlSignature: applied.htmlSignature,
    });

    // History is whole, so the completion publication needs no HTML. Its
    // receipt closes the obligation and releases the restored comments as a
    // state-only envelope — the reader pays nothing for them.
    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(completion, 'the completion publication must exist');
    assert.equal(completion.html, undefined,
        'a converged document must not be resent');
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: completion.subscriptionGeneration,
        requestId: completion.requestId,
        htmlSignature: completion.htmlSignature,
    });
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    const auxiliary = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.comments.revision === 7
    ).at(-1);
    assert.ok(auxiliary, 'the restored comments must still reach the Webview');
    assert.equal(auxiliary.html, undefined,
        'auxiliary state must ride a state-only envelope, never a re-render');
    viewer.dispose();
});

// A conversation's subagent list is sidebar metadata, not content. Discovering
// it must never cost the reader a full-document re-render: switching into any
// session that has subagents would otherwise throw away the progressive first
// paint and resend the whole transcript, which is the dominant cost of a switch.
test('CONVERSATION-LARGE-SESSION-PERFORMANCE-003 keeps the progressive render when a session has subagents', async () => {
    const sessionId = 'progressive-subagent-switch';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
        readSubagents: async () => ([{
            id: 'sub-1',
            label: 'explorer',
            agentType: 'Explore',
            status: 'idle',
            createdAt: 1,
            updatedAt: 2,
        }]),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: partial.subscriptionGeneration,
        requestId: partial.requestId,
        htmlSignature: partial.htmlSignature,
    });
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
                && typeof message.html === 'string'
        ).length,
        0,
        'discovering subagents must not resend the conversation'
    );

    // The deferred history still backfills in ack-paced slices.
    let applied = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(applied, 'the partial receipt must plan the deferred backfill');
    for (let slice = 0; slice < 8 && !applied.complete; slice++) {
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: applied.subscriptionGeneration,
            requestId: applied.requestId,
            htmlSignature: applied.htmlSignature,
        });
        applied = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
    }
    assert.equal(applied.complete, true, 'the backfill must reach history start');
    await panel.receive({
        type: 'conversation-viewer-history-chunk-applied',
        version: 1,
        subscriptionGeneration: applied.subscriptionGeneration,
        requestId: applied.requestId,
        htmlSignature: applied.htmlSignature,
    });
    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(completion, 'the completion publication must exist');
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: completion.subscriptionGeneration,
        requestId: completion.requestId,
        htmlSignature: completion.htmlSignature,
    });
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }

    // The list still reaches the sidebar — as state, with no HTML on the wire.
    const withSubagents = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.subagents?.length === 1
    ).at(-1);
    assert.ok(withSubagents, 'the subagent list must still reach the Webview');
    assert.equal(withSubagents.subagents[0].id, 'sub-1');
    assert.equal(withSubagents.html, undefined,
        'the subagent list must ride a state-only envelope');
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
                && typeof message.html === 'string'
        ).length,
        0,
        'no publication in the whole switch may carry conversation HTML'
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 ignores a stale chunk receipt while a refresh load is in flight', async () => {
    const sessionId = 'progressive-chunk-anchor-race';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    let watchCallback;
    let reads = 0;
    const pageRequested = deferred();
    const refreshedPage = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCallback = onChange;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, interactionIds, {
            sourceRevision: reads > 0 ? 'r2' : 'r1',
        }),
        readPage: async () => {
            reads += 1;
            if (reads === 1) {
                return page(sessionId, interactionIds[0], 'message', {
                    interactionIds,
                    anchorInteractionId: interactionIds.at(-1),
                });
            }
            // The refresh load allocated its request id already; it now
            // blocks on the page read.
            pageRequested.resolve();
            return refreshedPage.promise;
        },
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });
    const chunk = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk'
    ).at(-1);
    assert.ok(chunk, 'the backfill must be in flight');

    // A refresh load starts, allocates the request counter, and blocks on
    // the page read. The stale chunk receipt must not publish a completion
    // over it nor move the request counter.
    watchCallback();
    await pageRequested.promise;
    await panel.receive({
        type: 'conversation-viewer-history-chunk-applied',
        version: 1,
        subscriptionGeneration: chunk.subscriptionGeneration,
        requestId: chunk.requestId,
        htmlSignature: chunk.htmlSignature,
    });
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).length, 0, 'the stale receipt must not publish over the load');

    refreshedPage.resolve(page(sessionId, interactionIds[0], 'message', {
        interactionIds,
        anchorInteractionId: interactionIds.at(-1),
        sourceRevision: 'r2',
    }));
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const refreshed = lastContentPublication(panel);
    assert.equal(refreshed.updateKind, 'refresh');
    assert.match(refreshed.html, /message-0/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-002 recovers a lost backfill completion publication', async () => {
    const sessionId = 'progressive-chunk-completion-loss';
    const interactionIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const timers = new Map();
    let nextTimer = 1;
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, { callback, delayMs });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        readOutline: async () => outline(sessionId, interactionIds),
        readPage: async () => page(sessionId, interactionIds[0], 'message', {
            interactionIds,
            anchorInteractionId: interactionIds.at(-1),
        }),
    });

    await viewer.open(target(sessionId, interactionIds.at(-1)));
    const recent = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: recent.subscriptionGeneration,
        requestId: recent.requestId,
        htmlSignature: recent.htmlSignature,
    });
    // Drain the whole backfill; the completion publication then goes
    // unacknowledged (lost between Host queue and Webview application).
    for (;;) {
        const chunk = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).at(-1);
        if (!chunk) {
            break;
        }
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: chunk.subscriptionGeneration,
            requestId: chunk.requestId,
            htmlSignature: chunk.htmlSignature,
        });
        if (chunk.complete) {
            break;
        }
    }
    const completion = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(completion, 'the completion publication must exist');
    const timer = Array.from(timers.values()).find(candidate =>
        candidate.delayMs === 4_000
    );
    assert.ok(timer, 'the completion publication must be watched');

    timer.callback();
    const recovered = decodeInitialPublication(panel.webview.html);
    assert.doesNotMatch(recovered.html, /Loading earlier messages/);
    assert.match(recovered.html, /message-0/);
    assert.match(recovered.html, /message-99/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 patches only the trailing interaction while it streams', async () => {
    const sessionId = 'streaming-tail-patch';
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    let revision = 1;
    let tailText = 'answer part';
    let watchCallback;
    const timings = [];
    const streamingPage = () => ({
        provider: 'codex',
        sessionId,
        sourceRevision: `r${revision}`,
        anchorInteractionId: 'input-3',
        messages: [
            ...interactionIds.map(id => ({
                id: `${id}:user`,
                interactionId: id,
                role: 'user',
                markdown: `question-${id}`,
            })),
            {
                id: 'input-3:assistant',
                interactionId: 'input-3',
                role: 'assistant',
                markdown: tailText,
            },
        ],
        interactionStates: interactionIds.map(id => ({
            interactionId: id,
            responseState: 'complete',
        })),
        previousCursor: undefined,
        nextCursor: undefined,
        isStart: true,
        isEnd: true,
    });
    const { viewer, panel } = createViewer({
        onTiming: timing => timings.push(timing),
        watch: (_provider, _sessionId, onChange) => {
            watchCallback = onChange;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, interactionIds, {
            sourceRevision: `r${revision}`,
        }),
        readPage: async () => streamingPage(),
    });

    await viewer.open(target(sessionId, 'input-3'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.match(initial.html, /answer part/);
    // The running document advertises tail-patch support once, at startup,
    // through its own message rather than a field on the receipt.
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: decodeDocumentId(panel.webview.html),
        capabilities: ['tail-patch'],
    });
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    // The streamed growth changes only the trailing interaction: the wire
    // carries just that group, never the whole document.
    tailText = 'answer part grows further';
    revision = 2;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const patch = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(patch, 'the streaming refresh must be published');
    assert.equal(patch.updateKind, 'refresh');
    assert.equal(patch.html, undefined, 'the full document stays off the wire');
    assert.equal(patch.tailInteractionId, 'input-3');
    assert.match(patch.tailHtml, /answer part grows further/);
    assert.match(patch.tailHtml, /question-input-3/);
    assert.doesNotMatch(patch.tailHtml, /question-input-1/);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: patch.subscriptionGeneration,
        requestId: patch.requestId,
        htmlSignature: patch.htmlSignature,
    });
    assert.equal(timings.at(-1)?.delivery, 'message');
    assert.equal(timings.at(-1)?.contentBytes,
        Buffer.byteLength(patch.tailHtml, 'utf8'),
        'tail timing must count only the HTML that crossed the wire');
    assert.equal(timings.at(-1)?.progressive, false);

    // After the patched receipt, an unchanged refresh omits HTML entirely.
    revision = 3;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const idle = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(idle.html, undefined);
    assert.equal(idle.tailHtml, undefined);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: idle.subscriptionGeneration,
        requestId: idle.requestId,
        htmlSignature: idle.htmlSignature,
    });
    assert.equal(timings.at(-1)?.contentBytes, 0,
        'an unchanged delta must report no HTML transfer');

    // A new interaction changes the prefix: back to a full refresh.
    interactionIds.push('input-4');
    tailText = 'next answer';
    revision = 4;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const grown = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(typeof grown.html, 'string');
    assert.equal(grown.tailHtml, undefined);
    assert.match(grown.html, /question-input-4/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 delivers full HTML while the previous publication is unacknowledged', async () => {
    const sessionId = 'streaming-tail-unacked';
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    let revision = 1;
    let tailText = 'answer part';
    let watchCallback;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCallback = onChange;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, interactionIds, {
            sourceRevision: `r${revision}`,
        }),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: `r${revision}`,
            anchorInteractionId: 'input-3',
            messages: [
                ...interactionIds.map(id => ({
                    id: `${id}:user`,
                    interactionId: id,
                    role: 'user',
                    markdown: `question-${id}`,
                })),
                {
                    id: 'input-3:assistant',
                    interactionId: 'input-3',
                    role: 'assistant',
                    markdown: tailText,
                },
            ],
            interactionStates: interactionIds.map(id => ({
                interactionId: id,
                responseState: 'complete',
            })),
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, 'input-3'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: decodeDocumentId(panel.webview.html),
        capabilities: ['tail-patch'],
    });
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    tailText = 'answer part two';
    revision = 2;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const first = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(first.tailInteractionId, 'input-3',
        'the first streamed growth patches the tail');

    // Without the first patch's receipt the Webview base is unknown, so the
    // next growth must carry the full document again.
    tailText = 'answer part three';
    revision = 3;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const second = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(typeof second.html, 'string');
    assert.equal(second.tailHtml, undefined);
    assert.match(second.html, /answer part three/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 keeps full-HTML refreshes for a Webview without tail-patch support', async () => {
    const sessionId = 'streaming-tail-capability';
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    let revision = 1;
    let tailText = 'answer part';
    let watchCallback;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCallback = onChange;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, interactionIds, {
            sourceRevision: `r${revision}`,
        }),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: `r${revision}`,
            anchorInteractionId: 'input-3',
            messages: [
                ...interactionIds.map(id => ({
                    id: `${id}:user`,
                    interactionId: id,
                    role: 'user',
                    markdown: `question-${id}`,
                })),
                {
                    id: 'input-3:assistant',
                    interactionId: 'input-3',
                    role: 'assistant',
                    markdown: tailText,
                },
            ],
            interactionStates: interactionIds.map(id => ({
                interactionId: id,
                responseState: 'complete',
            })),
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, 'input-3'));
    const initial = decodeInitialPublication(panel.webview.html);
    // A document rendered by an older script never posts the capabilities
    // message, so every refresh keeps the full document on the wire.
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    tailText = 'answer part grows';
    revision = 2;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const refresh = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(typeof refresh.html, 'string',
        'an incapable document keeps receiving full HTML');
    assert.equal(refresh.tailHtml, undefined);
    assert.match(refresh.html, /answer part grows/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 arms tail patches from a transitional receipt without the dedicated handshake', async () => {
    const sessionId = 'streaming-tail-transitional';
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    let revision = 1;
    let tailText = 'answer part';
    let watchCallback;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCallback = onChange;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, interactionIds, {
            sourceRevision: `r${revision}`,
        }),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: `r${revision}`,
            anchorInteractionId: 'input-3',
            messages: [
                ...interactionIds.map(id => ({
                    id: `${id}:user`,
                    interactionId: id,
                    role: 'user',
                    markdown: `question-${id}`,
                })),
                {
                    id: 'input-3:assistant',
                    interactionId: 'input-3',
                    role: 'assistant',
                    markdown: tailText,
                },
            ],
            interactionStates: interactionIds.map(id => ({
                interactionId: id,
                responseState: 'complete',
            })),
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, 'input-3'));
    const initial = decodeInitialPublication(panel.webview.html);
    // A document rendered by the pre-handshake script acknowledges with
    // the capability on the receipt and never posts the dedicated message.
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
        capabilities: ['tail-patch'],
    });

    tailText = 'answer part grows';
    revision = 2;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const patch = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(patch.tailInteractionId, 'input-3',
        'the transitional receipt arms the patch wire');
    assert.equal(patch.html, undefined);
    assert.match(patch.tailHtml, /answer part grows/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 re-locks tail patches behind a document replacement until the fresh script re-posts its capabilities', async () => {
    const sessionId = 'streaming-tail-rebuild';
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    let revision = 1;
    let tailText = 'answer part';
    let watchCallback;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCallback = onChange;
            return { dispose() {} };
        },
        readOutline: async () => outline(sessionId, interactionIds, {
            sourceRevision: `r${revision}`,
        }),
        readPage: async () => ({
            provider: 'codex',
            sessionId,
            sourceRevision: `r${revision}`,
            anchorInteractionId: 'input-3',
            messages: [
                ...interactionIds.map(id => ({
                    id: `${id}:user`,
                    interactionId: id,
                    role: 'user',
                    markdown: `question-${id}`,
                })),
                {
                    id: 'input-3:assistant',
                    interactionId: 'input-3',
                    role: 'assistant',
                    markdown: tailText,
                },
            ],
            interactionStates: interactionIds.map(id => ({
                interactionId: id,
                responseState: 'complete',
            })),
            previousCursor: undefined,
            nextCursor: undefined,
            isStart: true,
            isEnd: true,
        }),
    });

    await viewer.open(target(sessionId, 'input-3'));
    const initial = decodeInitialPublication(panel.webview.html);
    const firstDocumentId = decodeDocumentId(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: firstDocumentId,
        capabilities: ['tail-patch'],
    });
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    tailText = 'answer part grows';
    revision = 2;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const patch = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(patch.tailInteractionId, 'input-3');
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: patch.subscriptionGeneration,
        requestId: patch.requestId,
        htmlSignature: patch.htmlSignature,
    });

    // A recovery rebuild replaces the document: the outgoing script's
    // capability advertisement must not leak into the fresh document.
    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: patch.subscriptionGeneration,
        requestId: patch.requestId,
        htmlSignature: patch.htmlSignature,
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
    });
    const rebuilt = decodeInitialPublication(panel.webview.html);
    assert.notEqual(rebuilt.requestId, patch.requestId);
    const rebuiltDocumentId = decodeDocumentId(panel.webview.html);
    assert.notEqual(rebuiltDocumentId, firstDocumentId);

    // A capabilities advertisement still queued from the replaced document
    // must not arm patches for its successor.
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: firstDocumentId,
        capabilities: ['tail-patch'],
    });
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: rebuilt.subscriptionGeneration,
        requestId: rebuilt.requestId,
        htmlSignature: rebuilt.htmlSignature,
    });

    tailText = 'answer part grows again';
    revision = 3;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const fullRefresh = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(typeof fullRefresh.html, 'string',
        'the fresh document keeps full HTML until it re-posts capabilities');
    assert.equal(fullRefresh.tailHtml, undefined);

    // The fresh script's startup handshake re-arms tail patches.
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: rebuiltDocumentId,
        capabilities: ['tail-patch'],
    });
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: fullRefresh.subscriptionGeneration,
        requestId: fullRefresh.requestId,
        htmlSignature: fullRefresh.htmlSignature,
    });
    tailText = 'answer part grows once more';
    revision = 4;
    watchCallback();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    const rearmed = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(rearmed.tailInteractionId, 'input-3');
    assert.equal(rearmed.html, undefined);
    assert.match(rearmed.tailHtml, /answer part grows once more/);
    viewer.dispose();
});

function decodeInitialBookmarks(html) {
    const match = html.match(/data-initial-bookmarks="([^"]+)"/);
    assert.ok(match, 'Host document must contain bookmark state');
    return JSON.parse(match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&'));
}

function retainedPageInteractionIds(pageIndex, pageSize, prefix) {
    const first = pageIndex === 0 ? 'selected-anchor' : `${prefix}-${pageIndex}`;
    return Array.from(
        { length: pageSize },
        (_item, index) => index === 0
            ? first
            : `${first}-${pageIndex * pageSize + index}`
    );
}

function fakePanel(options = {}) {
    const disposeListeners = new Set();
    const messageListeners = new Set();
    const viewStateListeners = new Set();
    let disposed = false;
    const panel = {
        createCount: 0,
        revealCount: 0,
        revealColumns: [],
        revealPreserveFocus: [],
        postedMessages: [],
        createArguments: undefined,
        visible: true,
        active: options.active !== false,
        get viewStateListenerCount() {
            return viewStateListeners.size;
        },
        webview: {
            html: '',
            cspSource: 'fixture-csp',
            options: {},
            onDidReceiveMessage(listener) {
                messageListeners.add(listener);
                return { dispose: () => messageListeners.delete(listener) };
            },
            postMessage(message) {
                panel.postedMessages.push(message);
                const delivered = typeof options.postMessageResult === 'function'
                    ? options.postMessageResult(message, panel)
                    : options.postMessageResult ?? true;
                return Promise.resolve(delivered);
            },
            asWebviewUri(uri) {
                return fakeUri(uri.toString().replace(
                    'file://',
                    'webview://fixture/'
                ));
            },
        },
        reveal(column, preserveFocus) {
            panel.revealCount += 1;
            panel.revealColumns.push(column);
            panel.revealPreserveFocus.push(preserveFocus);
        },
        onDidDispose(listener) {
            disposeListeners.add(listener);
            return { dispose: () => disposeListeners.delete(listener) };
        },
        onDidChangeViewState(listener) {
            viewStateListeners.add(listener);
            return { dispose: () => viewStateListeners.delete(listener) };
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            Array.from(disposeListeners).forEach(listener => listener());
        },
        async setVisible(visible) {
            panel.visible = visible;
            await Promise.all(Array.from(viewStateListeners).map(listener =>
                listener({ webviewPanel: panel })
            ));
        },
        async setActive(active) {
            panel.active = active;
            await Promise.all(Array.from(viewStateListeners).map(listener =>
                listener({ webviewPanel: panel })
            ));
        },
        async receive(message) {
            await Promise.all(Array.from(messageListeners).map(listener => listener(message)));
        },
    };
    return panel;
}

function createViewer(options = {}) {
    const panel = options.panel || fakePanel();
    const watchDisposals = [];
    const restoredTargets = [];
    const openedUris = [];
    const viewer = new ConversationViewer({
        createPanel: (..._args) => {
            panel.createCount += 1;
            panel.createArguments = _args;
            return panel;
        },
        readOutline: options.readOutline || (async (_provider, sessionId) =>
            outline(sessionId, ['input-1'])),
        readSnapshot: options.readSnapshot,
        readPage: options.readPage || (async request =>
            page(request.sessionId, request.anchorInteractionId)),
        readSubagents: options.readSubagents,
        readTelemetry: options.readTelemetry,
        readSessionStatus: options.readSessionStatus,
        cycleLocalSessionStatus: options.cycleLocalSessionStatus,
        onNavigationIntent: options.onNavigationIntent,
        acknowledgeSessionAttention: options.acknowledgeSessionAttention,
        switchAdjacentWindow: options.switchAdjacentWindow,
        watch: options.watch || ((_provider, sessionId) => ({
            dispose() {
                watchDisposals.push(sessionId);
            },
        })),
        restoreFocus: restoreTarget => {
            restoredTargets.push(restoreTarget);
        },
        openExternal: async uri => {
            openedUris.push(uri.toString());
            return true;
        },
        openLocalFile: options.openLocalFile,
        insertIntoActiveTerminal: options.insertIntoActiveTerminal,
        runCommandInTerminal: options.runCommandInTerminal,
        renameSession: options.renameSession,
        writeClipboardText: options.writeClipboardText,
        followAdjacentConversation: options.followAdjacentConversation,
        setKeyboardFocus: options.setKeyboardFocus,
        onDiagnostic: options.onDiagnostic,
        onTiming: options.onTiming,
        now: options.now,
        mediaUri: fileName => fakeUri(`file:///extension/media/${fileName}`),
        showThinking: options.showThinking,
        commentStore: options.commentStore,
        bookmarkStore: options.bookmarkStore,
        changes: options.changes,
        setTimer: options.setTimer,
        clearTimer: options.clearTimer,
    });
    return { viewer, panel, watchDisposals, restoredTargets, openedUris };
}

test('CONVERSATION-SESSION-STATUS-002 forwards the acknowledge-attention intent for the current target only', async () => {
    const acknowledged = [];
    const { viewer, panel } = createViewer({
        acknowledgeSessionAttention: async currentTarget => {
            acknowledged.push(currentTarget);
        },
    });
    // Intents arriving before any session is open have no target.
    await panel.receive({
        type: 'conversation-viewer-acknowledge-attention',
        version: 1,
    });
    assert.equal(acknowledged.length, 0,
        'no current target must mean no acknowledgement');

    await viewer.open(target('session-a', 'input-a'));

    await panel.receive({
        type: 'conversation-viewer-acknowledge-attention',
        version: 1,
    });
    assert.equal(acknowledged.length, 1);
    assert.equal(acknowledged[0].sessionId, 'session-a',
        'the Host resolves the target, never the Webview');

    // Malformed or over-posted envelopes never reach the handler.
    await panel.receive({
        type: 'conversation-viewer-acknowledge-attention',
        version: 1,
        sessionId: 'session-spoofed',
    });
    await panel.receive({
        type: 'conversation-viewer-acknowledge-attention',
        version: 2,
    });
    assert.equal(acknowledged.length, 1);

    viewer.dispose();
});

test('CONVERSATION-VIEWER-RENAME-001 forwards the rename intent for the current target and ignores malformed envelopes', async () => {
    const renamed = [];
    const { viewer, panel } = createViewer({
        renameSession: async renameTarget => {
            renamed.push(renameTarget);
        },
    });
    await viewer.open(target('session-a', 'input-a'));

    await panel.receive({
        type: 'conversation-viewer-rename-session',
        version: 1,
    });
    assert.deepEqual(renamed, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }], 'the Host rename flow receives the current session identity');

    // Malformed envelopes never reach the rename UX.
    await panel.receive({
        type: 'conversation-viewer-rename-session',
        version: 1,
        sessionId: 'session-spoofed',
    });
    await panel.receive({
        type: 'conversation-viewer-rename-session',
        version: 2,
    });
    assert.equal(renamed.length, 1,
        'malformed or spoofed envelopes are dropped by the protocol validator');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 records target-free timing for an initial document application', async () => {
    let now = 10;
    const timings = [];
    const { viewer, panel } = createViewer({
        now: () => now,
        onTiming: timing => timings.push(timing),
    });

    await viewer.open(target('session-a'));
    const publication = decodeInitialPublication(panel.webview.html);
    now = 35;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    assert.equal(timings.length, 1);
    assert.deepEqual(timings[0], {
        source: 'open',
        updateKind: 'initial',
        delivery: 'document',
        applicationMs: 25,
        contentBytes: Buffer.byteLength(publication.html, 'utf8'),
        progressive: false,
        loadMs: 25,
    });
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 records the correlated frame-cache preview outcome', async () => {
    const diagnostics = [];
    const { viewer, panel } = createViewer({
        onDiagnostic: event => diagnostics.push(event),
    });

    await viewer.open(target('session-a'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    await viewer.follow(target('session-b'));
    const incoming = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(incoming, 'the reused panel must receive a page for session-b');
    await panel.receive({
        type: 'conversation-viewer-frame-cache-preview',
        version: 1,
        subscriptionGeneration: incoming.subscriptionGeneration,
        outcome: 'hit',
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    });

    assert.ok(diagnostics.some(event =>
        event.event === 'conversation-viewer'
            && event.reason === 'frame-cache-preview'
            && event.sessionId === 'session-b'
            && event.outcome === 'hit'
    ));
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 preflights a cached frame before target snapshot resolution and restores it on cancellation', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-a'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.equal(viewer.previewSession({
        projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
    }), undefined, 'a retained pre-upgrade Webview never receives a cancel it cannot apply');
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: decodeDocumentId(panel.webview.html),
        capabilities: ['tail-patch', 'frame-preflight'],
    });
    const preview = viewer.previewSession({
        projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
    });
    assert.ok(preview, 'an existing panel can preflight a different session');
    const loading = panel.postedMessages.at(-1);
    assert.deepEqual(loading, {
        type: 'conversation-viewer-loading',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration + 1,
        target: {
            projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
        },
        preflight: true,
    }, 'the cache handoff does not wait for a resolved interaction target');

    assert.equal(await viewer.follow(target('session-a')), true,
        'a duplicate follow restores the still-authoritative session');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-loading-cancel',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration + 1,
        target: {
            projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
        },
    }, 'an A → B preview → A follow restores the authoritative document immediately');
    preview.dispose();
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-loading-cancel'
    ).length, 1, 'the stale B handle cannot cancel a later intent');
    viewer.dispose();
});

test('CONVERSATION-SWITCH-LATENCY-002 records a preflight cache outcome before terminal focus commits Viewer authority', async () => {
    const diagnostics = [];
    const { viewer, panel } = createViewer({
        onDiagnostic: event => diagnostics.push(event),
    });
    await viewer.open(target('session-a'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-capabilities',
        version: 1,
        documentId: decodeDocumentId(panel.webview.html),
        capabilities: ['tail-patch', 'frame-preflight'],
    });
    viewer.previewSession({
        projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
    });
    await panel.receive({
        type: 'conversation-viewer-frame-cache-preview',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration + 1,
        outcome: 'hit',
        projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
    });
    assert.ok(diagnostics.some(event =>
        event.reason === 'frame-cache-preview'
            && event.preflightSessionId === 'session-b'
            && event.outcome === 'hit'
    ), 'a slow terminal focus must not hide its preflight cache outcome');

    viewer.previewSession({
        projectId: 'project-a', provider: 'codex', sessionId: 'session-c',
    });
    await panel.receive({
        type: 'conversation-viewer-frame-cache-preview',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration + 1,
        outcome: 'miss',
        projectId: 'project-a', provider: 'codex', sessionId: 'session-b',
    });
    assert.equal(diagnostics.filter(event =>
        event.reason === 'frame-cache-preview'
            && event.preflightSessionId === 'session-b'
    ).length, 1, 'a superseded preflight must reject B\'s late cache outcome');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 records document timing after a message-delivery fallback', async () => {
    let now = 100;
    const timings = [];
    const panel = fakePanel({ postMessageResult: false });
    const { viewer } = createViewer({
        panel,
        now: () => now,
        onTiming: timing => timings.push(timing),
    });

    await viewer.open(target('session-a'));
    now = 130;
    await viewer.follow(target('session-b'));
    const publication = decodeInitialPublication(panel.webview.html);
    now = 150;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    assert.equal(timings.length, 1);
    assert.deepEqual(timings[0], {
        source: 'follow',
        updateKind: 'initial',
        delivery: 'document',
        applicationMs: 20,
        contentBytes: Buffer.byteLength(publication.html, 'utf8'),
        progressive: false,
        loadMs: 20,
    });
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 records correlated, target-free Webview application timing for a reused-panel switch', async () => {
    let now = 100;
    const timings = [];
    const sessionBRead = deferred();
    const { viewer, panel } = createViewer({
        now: () => now,
        onTiming: timing => timings.push(timing),
        readPage: request => request.sessionId === 'session-b'
            ? sessionBRead.promise
            : Promise.resolve(page(request.sessionId, request.anchorInteractionId)),
    });

    await viewer.open(target('session-a'));
    now = 130;
    const switching = viewer.follow(target('session-b'));
    await new Promise(resolve => setImmediate(resolve));
    now = 175;
    sessionBRead.resolve(page('session-b', 'input-1'));
    await switching;
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(publication, 'the reused panel must receive an authoritative page');

    now = 140;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration + 1,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    now = 142;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: 'stale-signature',
    });
    now = 145;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId - 1,
        htmlSignature: publication.htmlSignature,
    });
    assert.deepEqual(timings, [], 'a stale acknowledgement must not produce timing');

    now = 190;
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    assert.equal(timings.length, 1);
    assert.deepEqual(timings[0], {
        source: 'follow',
        updateKind: 'initial',
        delivery: 'message',
        applicationMs: 15,
        contentBytes: Buffer.byteLength(publication.html, 'utf8'),
        progressive: false,
        loadMs: 60,
    });
    assert.equal('sessionId' in timings[0], false);
    assert.equal('provider' in timings[0], false);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 makes an outgoing document inert before a slow target transition becomes interactive', async () => {
    const restore = deferred();
    const renamed = [];
    let loads = 0;
    const { viewer, panel } = createViewer({
        commentStore: {
            async load() {
                loads += 1;
                return loads === 1
                    ? { revision: 0, comments: [] }
                    : restore.promise;
            },
            async save() {},
        },
        renameSession: async renameTarget => {
            renamed.push(renameTarget.sessionId);
        },
    });
    await viewer.open(target('session-a'));

    const switching = viewer.follow(target('session-b'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.postedMessages.some(message =>
        message.type === 'conversation-viewer-loading'
            && message.target?.sessionId === 'session-b'
    ), true, 'the reused panel must make session-a controls inert while session-b restores');
    await panel.receive({
        type: 'conversation-viewer-rename-session',
        version: 1,
    });
    assert.deepEqual(renamed, [],
        'an outgoing document action cannot apply to the already-replaced target');

    restore.resolve({ revision: 0, comments: [] });
    assert.equal(await switching, true);
    await panel.receive({
        type: 'conversation-viewer-rename-session',
        version: 1,
    });
    assert.deepEqual(renamed, [],
        'postMessage delivery alone cannot unlock the incoming target');
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    await panel.receive({
        type: 'conversation-viewer-rename-session',
        version: 1,
    });
    assert.deepEqual(renamed, ['session-b']);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 publishes switched content before slow auxiliary state restores', async () => {
    const sessionBComments = deferred();
    const { viewer, panel } = createViewer({
        commentStore: {
            async load(storeTarget) {
                return storeTarget.sessionId === 'session-b'
                    ? sessionBComments.promise
                    : { revision: 0, comments: [] };
            },
            async save() {},
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });

    await viewer.open(target('session-a'));
    const initial = decodeInitialPublication(panel.webview.html);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        requestId: initial.requestId,
        htmlSignature: initial.htmlSignature,
    });

    const switching = viewer.follow(target('session-b'));
    await new Promise(resolve => setImmediate(resolve));
    const sessionBPublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-b'
    ).at(-1);
    assert.ok(sessionBPublication,
        'content publication must not wait for auxiliary state restoration');
    assert.match(sessionBPublication.html, /visible-session-b/);
    assert.equal(sessionBPublication.comments.revision, 0,
        'the first readable page uses the reset auxiliary state');
    assert.equal(await Promise.race([
        switching.then(() => true),
        new Promise(resolve => setImmediate(() => resolve(false))),
    ]), true, 'the target load settles before a slow auxiliary restoration');

    sessionBComments.resolve({ revision: 7, comments: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-b'
    ).length, 1, 'the side state waits for the readable page acknowledgement');

    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: sessionBPublication.subscriptionGeneration,
        requestId: sessionBPublication.requestId,
        htmlSignature: sessionBPublication.htmlSignature,
    });
    await new Promise(resolve => setImmediate(resolve));
    const restored = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-b'
    ).at(-1);
    assert.equal(restored.updateKind, 'refresh');
    assert.equal(restored.html, undefined,
        'the auxiliary state refresh reuses the acknowledged transcript');
    assert.equal(restored.comments.revision, 7);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 drops a late auxiliary restore after another session switch', async () => {
    const sessionBComments = deferred();
    const { viewer, panel } = createViewer({
        commentStore: {
            async load(storeTarget) {
                return storeTarget.sessionId === 'session-b'
                    ? sessionBComments.promise
                    : { revision: 0, comments: [] };
            },
            async save() {},
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });

    await viewer.open(target('session-a'));
    await viewer.follow(target('session-b'));
    const sessionBMessagesBeforeSwitch = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-b'
    ).length;

    await viewer.follow(target('session-c'));
    const sessionCPublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-c'
    ).at(-1);
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: sessionCPublication.subscriptionGeneration,
        requestId: sessionCPublication.requestId,
        htmlSignature: sessionCPublication.htmlSignature,
    });

    sessionBComments.resolve({ revision: 9, comments: [] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-b'
    ).length, sessionBMessagesBeforeSwitch,
    'a late restore for session-b must not republish after session-c is current');
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
            && message.target?.sessionId === 'session-c'
    ).at(-1).comments.revision, 0);
    viewer.dispose();
});

test('CONVERSATION-TELEMETRY-CONTROLLER-001 refreshes telemetry while the visible conversation is otherwise idle', async () => {
    const timers = new Map();
    let nextTimer = 1;
    let telemetryReads = 0;
    const { viewer, panel } = createViewer({
        readTelemetry: async (_provider, sessionId) => ({
            provider: 'codex',
            sessionId,
            context: {
                usedTokens: ++telemetryReads * 100,
                maxTokens: 1_000,
            },
            rateLimits: [],
        }),
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, {
                callback: () => {
                    timers.delete(handle);
                    return callback();
                },
                delayMs,
            });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
    });

    await viewer.open(target('session-idle'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(telemetryReads, 1, 'initial publication reads telemetry');
    const scheduled = Array.from(timers.values()).at(-1);
    assert.ok(scheduled, 'visible conversation must schedule a telemetry refresh');
    assert.equal(scheduled.delayMs, 5_000);

    await scheduled.callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(telemetryReads, 2);
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-telemetry'
        ).at(-1).telemetry.context.usedTokens,
        200
    );
    assert.equal(timers.size, 1, 'the next visible refresh is scheduled');

    await panel.setVisible(false);
    assert.equal(timers.size, 0, 'hidden conversations stop telemetry work');
    await panel.setVisible(true);
    assert.equal(timers.size, 1, 'showing the conversation resumes telemetry');

    panel.dispose();
    assert.equal(timers.size, 0, 'disposing the viewer cancels telemetry work');
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 opens and reuses one viewer in the active editor group', async () => {
    const { viewer, panel } = createViewer();

    await viewer.open(target('session-a', 'input-1'));
    await viewer.open(target('session-b', 'input-1'));

    assert.equal(panel.createCount, 1);
    assert.equal(panel.createArguments[2], fakeVscode.ViewColumn.Active);
    assert.deepEqual(panel.revealColumns, [
        fakeVscode.ViewColumn.Active,
        fakeVscode.ViewColumn.Active,
    ]);
});

test('CONVERSATION-SESSION-STATUS-001 embeds and publishes the correlated local Session status', async () => {
    let status = {
        runningSessions: 2,
        attentionSessions: 1,
        runningSessionsLocal: 1,
        attentionSessionsLocal: 1,
        idleSessionsLocal: 3,
    };
    const { viewer, panel } = createViewer({
        readSessionStatus: () => status,
    });
    await viewer.open(target('session-a', 'input-1'));

    assert.ok(panel.webview.html.includes(
        'data-conversation-session-status'
    ));
    assert.ok(panel.webview.html.includes(
        '1 running in this window · click to switch to the next'
    ));
    assert.ok(panel.webview.html.includes(
        '1 need attention in this window · click to switch to the next'
    ));
    assert.ok(panel.webview.html.includes(
        '3 idle in this window · click to switch to the next'
    ));
    assert.ok(panel.webview.html.includes(
        'data-session-status-running data-session-status-cycle="running"'
    ));
    assert.ok(panel.webview.html.includes(
        'data-session-status-running-count>1</span>'
    ));
    assert.ok(panel.webview.html.includes(
        'data-session-status-attention-count>1</span>'
    ));
    assert.ok(panel.webview.html.includes(
        'data-session-status-idle-count>3</span>'
    ));
    assert.ok(panel.webview.html.includes(
        'data-session-status-request-id'
    ));

    const statusMessages = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-session-status'
    );
    await viewer.publishSessionStatus();
    assert.equal(statusMessages().length, 1);
    const message = statusMessages()[0];
    assert.equal(message.version, 1);
    assert.ok(Number.isSafeInteger(message.requestId));
    assert.ok(message.subscriptionGeneration >= 1);
    assert.deepEqual(message.status, {
        runningSessions: 2,
        attentionSessions: 1,
        runningSessionsLocal: 1,
        attentionSessionsLocal: 1,
        idleSessionsLocal: 3,
    });

    await viewer.publishSessionStatus();
    assert.equal(statusMessages().length, 1,
        'an unchanged status must not be reposted');

    status = {
        runningSessions: 3,
        attentionSessions: 0,
        runningSessionsLocal: 2,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 0,
    };
    await viewer.publishSessionStatus();
    assert.equal(statusMessages().length, 2);
    assert.deepEqual(statusMessages()[1].status, {
        runningSessions: 3,
        attentionSessions: 0,
        runningSessionsLocal: 2,
        attentionSessionsLocal: 0,
        idleSessionsLocal: 0,
    });
});

test('CONVERSATION-SESSION-STATUS-001 renders a disabled status button for an empty kind', async () => {
    const { viewer, panel } = createViewer({
        readSessionStatus: () => ({
            runningSessions: 1,
            attentionSessions: 0,
            runningSessionsLocal: 1,
            attentionSessionsLocal: 0,
            idleSessionsLocal: 2,
        }),
    });
    await viewer.open(target('session-a', 'input-1'));

    assert.ok(panel.webview.html.includes(
        'No AI sessions need attention in this window'
    ));
    assert.ok(/data-session-status-attention[^>]*disabled/.test(
        panel.webview.html
    ), 'an empty kind renders a disabled button');
    assert.ok(!/data-session-status-running[^>]*disabled/.test(
        panel.webview.html
    ), 'a non-empty kind stays clickable');
});

test('OPEN-WINDOW-CYCLE-RAILS-001 routes window rail clicks to the window cycle', async () => {
    const switches = [];
    const { viewer, panel } = createViewer({
        switchAdjacentWindow: async direction => {
            switches.push(direction);
        },
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive({
        type: 'conversation-viewer-switch-window',
        version: 1,
        direction: 'previous',
    });
    assert.deepEqual(switches, ['previous']);

    for (const message of [
        { type: 'conversation-viewer-switch-window', version: 1 },
        {
            type: 'conversation-viewer-switch-window',
            version: 1,
            direction: 'up',
        },
        {
            type: 'conversation-viewer-switch-window',
            version: 1,
            direction: 'next',
            extra: true,
        },
    ]) {
        await panel.receive(message);
    }
    assert.equal(switches.length, 1,
        'malformed or spoofed directions are dropped by the protocol validator');
});

test('CONVERSATION-SESSION-STATUS-001 routes status button clicks to the local session cycle', async () => {
    const cycles = [];
    let navigationIntents = 0;
    const cycle = deferred();
    const { viewer, panel } = createViewer({
        onNavigationIntent: () => { navigationIntents += 1; },
        cycleLocalSessionStatus: async (kind, currentTarget) => {
            cycles.push({ kind, currentTarget });
            await cycle.promise;
        },
    });
    await viewer.open(target('session-a', 'input-1'));

    const receiving = panel.receive({
        type: 'conversation-viewer-cycle-status-session',
        version: 1,
        kind: 'attention',
    });
    await Promise.resolve();
    assert.equal(navigationIntents, 1,
        'a valid status-cycle message must cancel an older navigation before its local cycle settles');
    cycle.resolve();
    await receiving;
    assert.deepEqual(cycles, [{
        kind: 'attention',
        currentTarget: target('session-a', 'input-1'),
    }]);
    assert.equal(navigationIntents, 1);

    for (const message of [
        { type: 'conversation-viewer-cycle-status-session', version: 1 },
        {
            type: 'conversation-viewer-cycle-status-session',
            version: 1,
            kind: 'paused',
        },
        {
            type: 'conversation-viewer-cycle-status-session',
            version: 1,
            kind: 'idle',
            extra: true,
        },
    ]) {
        await panel.receive(message);
    }
    assert.equal(cycles.length, 1,
        'malformed or spoofed kinds are dropped by the protocol validator');
    assert.equal(navigationIntents, 1,
        'invalid status-cycle messages must not supersede a valid navigation');
});

test('CONVERSATION-SESSION-STATUS-001 republishes the status after a retarget even when unchanged', async () => {
    const status = {
        runningSessions: 1,
        attentionSessions: 1,
        runningSessionsLocal: 1,
        attentionSessionsLocal: 1,
        idleSessionsLocal: 2,
    };
    const { viewer, panel } = createViewer({
        readSessionStatus: () => status,
    });
    await viewer.open(target('session-a', 'input-1'));
    const statusMessages = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-session-status'
    );
    assert.equal(statusMessages().length, 1,
        'opening a viewer publishes the embedded status once');

    await viewer.publishSessionStatus();
    assert.equal(statusMessages().length, 1,
        'an unchanged status must not be reposted');

    await viewer.open(target('session-b', 'input-1'));
    const messages = statusMessages();
    assert.equal(messages.length, 2,
        'a retarget must republish the current status to heal gap discards');
    assert.ok(messages[1].subscriptionGeneration
        > messages[0].subscriptionGeneration);
    assert.deepEqual(messages[1].status, status);
});

test('CONVERSATION-SESSION-REBIND-001 retargets an open viewer from the exact old Session to the new Session', async () => {
    const outlineReads = [];
    const { viewer, panel, watchDisposals } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads.push(sessionId);
            return outline(
                sessionId,
                sessionId === 'old-root'
                    ? ['old-input']
                    : ['new-input-a', 'new-input-b']
            );
        },
    });
    await viewer.open(target('old-root', 'old-input'));

    assert.equal(await viewer.rebindSession(
        { projectId: 'project-a', provider: 'codex', sessionId: 'old-root' },
        { projectId: 'project-a', provider: 'codex', sessionId: 'new-root' }
    ), true);

    assert.deepEqual(outlineReads, ['old-root', 'new-root', 'new-root']);
    assert.deepEqual(watchDisposals, ['old-root']);
    assert.equal(panel.createCount, 1);
    assert.match(panel.postedMessages.at(-1).html, /new-input-b/);
    await viewer.reconcileAuthority(() => ({
        displayName: 'New root display',
        duplicateDisplayName: false,
    }));
    assert.equal(panel.postedMessages.at(-1).displayName, 'New root display');
});

test('CONVERSATION-SESSION-REBIND-001 keeps an initial rebound load current while display metadata reconciles', async () => {
    const reboundInitialStarted = deferred();
    const releaseReboundInitial = deferred();
    let newRootReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            if (sessionId === 'new-root') {
                newRootReads += 1;
                if (newRootReads === 2) {
                    reboundInitialStarted.resolve();
                    await releaseReboundInitial.promise;
                }
            }
            return outline(sessionId, [`${sessionId}-input`]);
        },
    });
    await viewer.open(target('old-root', 'old-root-input'));

    const rebind = viewer.rebindSession(
        { projectId: 'project-a', provider: 'codex', sessionId: 'old-root' },
        { projectId: 'project-a', provider: 'codex', sessionId: 'new-root' }
    );
    await reboundInitialStarted.promise;
    const reconcile = viewer.reconcileAuthority(() => ({
        displayName: 'Current root',
        duplicateDisplayName: false,
    }));
    releaseReboundInitial.resolve();

    assert.equal(await rebind, true);
    await reconcile;
    assert.match(panel.postedMessages.at(-1).html, /new-root-input/);
    assert.match(panel.postedMessages.at(-1).displayName, /Current root/);
});

test('CONVERSATION-SESSION-REBIND-001 bounds reconciled display metadata before publishing it', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-a'));

    await viewer.reconcileAuthority(() => ({
        displayName: '🧭'.repeat(1_000),
        duplicateDisplayName: true,
    }));

    const publication = panel.postedMessages.at(-1);
    assert.equal(publication.type, 'conversation-viewer-page');
    assert.ok(publication.displayName.length <= 640);
    assert.match(publication.displayName, / · session-/);
});

test('CONVERSATION-SESSION-REBIND-001 lets the newest live rebind win while an older outline read is pending', async () => {
    const oldRebind = deferred();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            if (sessionId === 'new-root-a') {
                await oldRebind.promise;
            }
            return outline(sessionId, [`${sessionId}-input`]);
        },
    });
    await viewer.open(target('old-root', 'old-root-input'));
    const previous = {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    };
    const first = viewer.rebindSession(previous, {
        ...previous,
        sessionId: 'new-root-a',
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await viewer.rebindSession(previous, {
        ...previous,
        sessionId: 'new-root-b',
    }), true);
    oldRebind.resolve();
    assert.equal(await first, false);
    assert.match(panel.postedMessages.at(-1).html, /new-root-b-input/);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 restores a retained panel without revealing it and resumes live updates', async () => {
    const panel = fakePanel();
    let onChange;
    let revision = 1;
    const { viewer } = createViewer({
        panel,
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `revision-${revision}`,
            { sourceRevision: `r${revision}` }
        ),
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
    });

    await viewer.restore(panel, target('session-a', 'input-1'));

    assert.equal(panel.createCount, 0, 'VS Code already owns the retained panel');
    assert.equal(panel.revealCount, 0, 'restoration must not steal editor focus');
    assert.equal(panel.webview.options.enableScripts, true);
    assert.match(panel.webview.html, /revision-1/);

    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    const refresh = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.ok(refresh, 'the restored watcher must publish new transcript data');
    assert.match(refresh.html, /revision-2/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 republishes on revision-moving content growth even when the outline projection is unchanged', async () => {
    const panel = fakePanel();
    let onChange;
    let revision = 1;
    let toolMarker = '';
    let readPageCalls = 0;
    const { viewer } = createViewer({
        panel,
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => {
            readPageCalls += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible${toolMarker}`,
                { sourceRevision: `r${revision}` }
            );
        },
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
    });
    await viewer.open(target('session-a', 'input-1'));
    const publications = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page');
    const baselinePublications = publications().length;
    const baselineReadPages = readPageCalls;

    // Same revision, same interaction ids, same responseState: the
    // refresh must early-return without a page read or publication.
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(readPageCalls, baselineReadPages,
        'a projection-identical refresh must not re-read the page');
    assert.equal(publications().length, baselinePublications);

    // Tool-only growth: the outline projection (ids + states) is
    // identical, but the revision moved with the content epoch — the
    // viewer must re-read the page and publish the new HTML.
    revision = 2;
    toolMarker = '-with-tool';
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(readPageCalls > baselineReadPages,
        'a revision move must re-read the page even without outline changes');
    const publication = publications().at(-1);
    assert.ok(publication, 'the grown content must be published');
    assert.match(publication.html, /visible-with-tool/);
    viewer.dispose();
});

test('CONVERSATION-FOLLOW-ACTIVE-SESSION-001 follows another Session only when the viewer is open and does not reveal it again', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            [sessionId === 'session-a' ? 'input-a' : 'input-b']
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });

    assert.equal(viewer.isOpen(), false);
    assert.equal(await viewer.follow(target('session-b', 'input-b')), false);
    assert.equal(panel.createCount, 0);

    await viewer.open(target('session-a', 'input-a'));
    const retainedDocument = panel.webview.html;
    assert.equal(viewer.isOpen(), true);
    assert.equal(await viewer.follow(target('session-b', 'input-b')), true);
    assert.equal(
        panel.webview.html,
        retainedDocument,
        'following a Session must update the retained Webview in place'
    );
    assert.equal(
        panel.postedMessages.at(-1).html.includes('visible-session-b'),
        true
    );
    assert.deepEqual(panel.revealColumns, [fakeVscode.ViewColumn.Active]);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 retains one Webview document while switching Codex, Kimi, and Claude Sessions and while hidden', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (provider, sessionId) => ({
            ...outline(sessionId, [`${sessionId}-input`]),
            provider,
        }),
        readPage: async request => ({
            ...page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${request.provider}`
            ),
            provider: request.provider,
        }),
    });

    await viewer.open(target('codex-session', 'codex-session-input'));
    assert.equal(
        panel.createArguments[3].retainContextWhenHidden,
        true,
        'the singleton Conversation panel must retain its Webview context'
    );
    const retainedDocument = panel.webview.html;

    for (const provider of ['kimi', 'claude']) {
        const sessionId = `${provider}-session`;
        assert.equal(await viewer.follow(target(
            sessionId,
            `${sessionId}-input`,
            { provider }
        )), true);
        assert.equal(panel.webview.html, retainedDocument);
        const publication = panel.postedMessages.at(-1);
        assert.equal(publication.target.provider, provider);
        assert.equal(publication.target.sessionId, sessionId);
        assert.match(publication.html, new RegExp(`visible-${provider}`));
    }

    await panel.setVisible(false);
    await panel.setVisible(true);
    assert.equal(
        panel.webview.html,
        retainedDocument,
        'showing a retained panel must not rebuild its document'
    );
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 distinguishes the current target from the focused Conversation target', async () => {
    const focusStates = [];
    const { viewer, panel } = createViewer({
        setKeyboardFocus: focused => focusStates.push(focused),
    });
    assert.equal(viewer.getCurrentTarget(), undefined);
    assert.equal(viewer.getFocusedSessionTarget(), undefined);

    await viewer.open(target('session-a', 'input-a'));
    assert.deepEqual(viewer.getCurrentTarget(), target('session-a', 'input-a'));
    assert.equal(viewer.getFocusedTarget(), undefined);
    await panel.receive({
        type: 'conversation-viewer-focus',
        version: 1,
        focused: true,
    });
    assert.deepEqual(viewer.getFocusedTarget(), target('session-a', 'input-a'));
    assert.deepEqual(viewer.getFocusedSessionTarget(), {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });

    await panel.receive({
        type: 'conversation-viewer-focus',
        version: 1,
        focused: false,
    });
    assert.deepEqual(viewer.getCurrentTarget(), target('session-a', 'input-a'));
    assert.equal(viewer.getFocusedTarget(), undefined);
    assert.equal(viewer.getFocusedSessionTarget(), undefined);
    assert.deepEqual(focusStates, [false, true, false]);
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 explicitly restores focus to an open Conversation panel', async () => {
    const { viewer, panel } = createViewer();
    assert.equal(viewer.focus(), false);

    await viewer.open(target('session-a', 'input-a'));
    await panel.setActive(false);
    assert.equal(viewer.focus(), true);
    assert.deepEqual(panel.revealColumns, [
        fakeVscode.ViewColumn.Active,
        fakeVscode.ViewColumn.Active,
    ]);
    assert.deepEqual(panel.revealPreserveFocus, [undefined, false]);
});

test('CONVERSATION-ACTIVE-SESSION-NAVIGATION-COMMANDS-001 reports a superseded in-viewer Session load as not followed', async () => {
    const slowOutlineStarted = deferred();
    const releaseSlowOutline = deferred();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            if (sessionId === 'session-b') {
                slowOutlineStarted.resolve();
                await releaseSlowOutline.promise;
            }
            return outline(sessionId, [`${sessionId}-input`]);
        },
    });
    await viewer.open(target('session-a', 'session-a-input'));

    const first = viewer.follow(target('session-b', 'session-b-input'));
    await slowOutlineStarted.promise;
    assert.equal(
        await viewer.follow(target('session-c', 'session-c-input')),
        true
    );
    releaseSlowOutline.resolve();
    assert.equal(await first, false);
    assert.match(panel.postedMessages.at(-1).html, /session-c-input/);
});

test('WEBVIEW-AI-SESSION-SUBAGENT-VIEWER-001 opens a subagent transcript in place and returns to the conversation', async () => {
    const subagentEntries = [
        {
            id: 'a11111111',
            label: 'Explore the parser',
            agentType: 'explore',
            status: 'running',
            createdAt: 1,
            updatedAt: 2,
        },
    ];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => sessionId.includes('#agent:')
            ? outline(sessionId, ['sub-input-1'])
            : outline(sessionId, ['input-a', 'input-b']),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            request.sessionId.includes('#agent:')
                ? 'subagent-visible'
                : 'main-visible'
        ),
        readSubagents: async () => subagentEntries,
    });

    await viewer.open(target('session-a', 'input-a'));
    await new Promise(resolve => setImmediate(resolve));
    await acknowledgeLatestPublication(panel);
    const initial = panel.postedMessages.at(-1)
        || decodeInitialPublication(panel.webview.html);
    assert.deepEqual(
        initial.subagents.map(entry => [entry.id, entry.status]),
        [['a11111111', 'running']]
    );
    assert.equal(initial.activeSubagent, null);

    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: 'a11111111',
    });
    // The switch applies in place: no document rebuild, and the publication
    // keeps the subscription generation baked into the current document.
    const initialGeneration = Number(panel.webview.html.match(
        /data-subscription-generation="(\d+)"/
    )[1]);
    assert.equal(panel.webview.html.includes('subagent-visible'), false);
    let publication = panel.postedMessages.at(-1);
    assert.equal(publication.activeSubagent.id, 'a11111111');
    assert.equal(publication.activeSubagent.label, 'Explore the parser');
    assert.ok(publication.html.includes('subagent-visible'));
    assert.equal(
        publication.subscriptionGeneration,
        initialGeneration,
        'an in-place switch must keep the document-baked generation'
    );
    assert.deepEqual(
        publication.outline.map(entry => entry.interactionId),
        ['sub-input-1']
    );
    assert.deepEqual(
        publication.subagents.map(entry => entry.id),
        ['a11111111']
    );

    // Unknown or malformed subagent targets are ignored without a new page.
    const settledCount = panel.postedMessages.length;
    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: 'a99999999',
    });
    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
        subagentId: '..',
    });
    await panel.receive({
        type: 'conversation-viewer-open-subagent',
        version: 1,
    });
    assert.equal(panel.postedMessages.length, settledCount);

    await acknowledgeLatestPublication(panel);

    // A dashboard follow for the same session preserves the subagent view.
    const beforeFollow = panel.postedMessages.length;
    assert.equal(await viewer.follow(target('session-a', 'input-b')), true);
    assert.equal(panel.postedMessages.length, beforeFollow);
    assert.equal(panel.postedMessages.at(-1).activeSubagent.id, 'a11111111');

    await panel.receive({
        type: 'conversation-viewer-close-subagent',
        version: 1,
    });
    publication = panel.postedMessages.at(-1);
    assert.equal(publication.activeSubagent, null);
    assert.ok(publication.html.includes('main-visible'));
    assert.equal(publication.subscriptionGeneration, initialGeneration);
    assert.deepEqual(
        publication.outline.map(entry => entry.interactionId),
        ['input-a', 'input-b']
    );
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 publishes readable content before optional subagent discovery settles for every provider', async () => {
    for (const provider of ['codex', 'kimi', 'claude']) {
        const subagents = deferred();
        let openSettled = false;
        const sessionId = `${provider}-nonblocking-subagents`;
        const { viewer, panel } = createViewer({
            readOutline: async () => ({
                ...outline(sessionId, ['input-1']),
                provider,
            }),
            readPage: async request => ({
                ...page(sessionId, request.anchorInteractionId, `${provider}-visible`),
                provider,
            }),
            readSubagents: async () => subagents.promise,
        });

        const opening = viewer.open(target(sessionId, 'input-1', { provider }))
            .then(() => { openSettled = true; });
        await new Promise(resolve => setImmediate(resolve));
        const settledBeforeSubagents = openSettled;
        const readableBeforeSubagents = panel.webview.html.includes(
            `${provider}-visible`
        ) || panel.postedMessages.some(message =>
            message.html?.includes(`${provider}-visible`)
        );

        subagents.resolve([{
            id: 'a11111111',
            label: `${provider} worker`,
            status: 'running',
        }]);
        await opening;

        assert.equal(settledBeforeSubagents, true,
            `${provider} content publication must not await subagents`);
        assert.equal(readableBeforeSubagents, true,
            `${provider} readable content must precede subagents`);
        viewer.dispose();
    }
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 keeps late subagents after same-session navigation supersedes the page request', async () => {
    const subagents = deferred();
    const sessionId = 'navigated-while-discovering';
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(
            sessionId,
            ['input-1', 'input-2']
        ),
        readPage: async request => page(
            sessionId,
            request.anchorInteractionId,
            'readable',
            {
                interactionIds: ['input-1', 'input-2'],
                anchorInteractionId: request.anchorInteractionId,
            }
        ),
        readSubagents: async () => subagents.promise,
    });

    await viewer.open(target(sessionId, 'input-2'));
    await panel.receive({
        type: 'conversation-viewer-previous',
        version: 1,
    });
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');

    subagents.resolve([{
        id: 'a11111111',
        label: 'Late worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    await acknowledgeLatestPublication(panel);
    assert.deepEqual(
        panel.postedMessages.at(-1).subagents.map(entry => entry.id),
        ['a11111111']
    );
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 prevents an older subagent result from superseding a newer authoritative refresh', async () => {
    const sessionId = 'refresh-while-discovering';
    const refreshedOutline = deferred();
    const firstSubagents = deferred();
    const secondSubagents = deferred();
    let outlineReads = 0;
    let subagentReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async () => {
            outlineReads += 1;
            if (outlineReads === 2) {
                return refreshedOutline.promise;
            }
            return outline(sessionId, ['input-1']);
        },
        readPage: async request => page(
            sessionId,
            request.anchorInteractionId,
            request.expectedRevision,
            { sourceRevision: request.expectedRevision }
        ),
        readSubagents: async () => (
            ++subagentReads === 1
                ? firstSubagents.promise
                : secondSubagents.promise
        ),
    });

    await viewer.open(target(sessionId, 'input-1'));
    const refreshing = viewer.refresh();
    await new Promise(resolve => setImmediate(resolve));
    firstSubagents.resolve([{
        id: 'stale-worker',
        label: 'Stale worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    refreshedOutline.resolve(outline(
        sessionId,
        ['input-1'],
        { sourceRevision: 'r2' }
    ));
    await refreshing;
    secondSubagents.resolve([{
        id: 'current-worker',
        label: 'Current worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    await acknowledgeLatestPublication(panel);

    assert.deepEqual(
        panel.postedMessages.at(-1).subagents.map(entry => entry.id),
        ['current-worker']
    );
    assert.match(lastContentPublication(panel).html, /r2/);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 prevents an older subagent result from cancelling cross-page navigation', async () => {
    const sessionId = 'cross-page-while-discovering';
    const navigationPage = deferred();
    const firstSubagents = deferred();
    const secondSubagents = deferred();
    let pageReads = 0;
    let subagentReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async () => outline(
            sessionId,
            ['input-1', 'input-2']
        ),
        readPage: async request => {
            pageReads += 1;
            if (pageReads === 2) {
                return navigationPage.promise;
            }
            return page(sessionId, 'input-2', 'initial', {
                interactionIds: ['input-2'],
                anchorInteractionId: 'input-2',
                previousCursor: 'before-input-2',
            });
        },
        readSubagents: async () => (
            ++subagentReads === 1
                ? firstSubagents.promise
                : secondSubagents.promise
        ),
    });

    await viewer.open(target(sessionId, 'input-2'));
    const navigating = panel.receive({
        type: 'conversation-viewer-previous',
        version: 1,
    });
    await new Promise(resolve => setImmediate(resolve));
    firstSubagents.resolve([{
        id: 'stale-worker',
        label: 'Stale worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    navigationPage.resolve(page(sessionId, 'input-1', 'navigated', {
        interactionIds: ['input-1'],
        anchorInteractionId: 'input-1',
        nextCursor: 'after-input-1',
    }));
    await navigating;
    secondSubagents.resolve([{
        id: 'current-worker',
        label: 'Current worker',
        status: 'running',
    }]);
    await new Promise(resolve => setImmediate(resolve));
    await acknowledgeLatestPublication(panel);

    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    assert.match(lastContentPublication(panel).html, /navigated/);
    assert.deepEqual(
        panel.postedMessages.at(-1).subagents.map(entry => entry.id),
        ['current-worker']
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 revalidates a warm latest snapshot without overriding later user navigation', async () => {
    const sessionId = 'warm-latest';
    let authoritativeReads = 0;
    const snapshot = {
        outline: outline(sessionId, ['input-1', 'input-2']),
        page: page(sessionId, 'input-2', 'warm', {
            interactionIds: ['input-1', 'input-2'],
            anchorInteractionId: 'input-2',
        }),
    };
    const { viewer, panel } = createViewer({
        readSnapshot: async () => {
            authoritativeReads += 1;
            return {
                outline: outline(
                    sessionId,
                    ['input-1', 'input-2', 'input-3'],
                    { sourceRevision: 'r2' }
                ),
                page: page(sessionId, 'input-3', 'authoritative', {
                    interactionIds: ['input-1', 'input-2', 'input-3'],
                    anchorInteractionId: 'input-3',
                    sourceRevision: 'r2',
                }),
            };
        },
    });

    await viewer.open(target(sessionId, 'input-2'), snapshot);
    await viewer.revalidateLatest('input-2');
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-3');
    assert.equal(authoritativeReads, 1);

    await viewer.open(target(sessionId, 'input-2'), snapshot);
    await panel.receive({
        type: 'conversation-viewer-previous',
        version: 1,
    });
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    await viewer.revalidateLatest('input-2');
    assert.equal(panel.postedMessages.at(-1).selectedInteractionId, 'input-1');
    assert.equal(authoritativeReads, 1,
        'manual navigation must cancel the automatic latest revalidation');
    viewer.dispose();
});

test('CONVERSATION-VIEWER-OWNERSHIP-001 reuses one panel, rejects an old session generation, and clears sensitive state on disposal', async () => {
    const panel = fakePanel();
    const pages = new Map([
        ['session-a', deferred()],
        ['session-b', deferred()],
    ]);
    const { viewer, watchDisposals, restoredTargets } = createViewer({
        panel,
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            [sessionId === 'session-a' ? 'input-a' : 'input-b']
        ),
        readPage: request => pages.get(request.sessionId).promise,
    });

    const openA = viewer.open(target('session-a', 'input-a'));
    await new Promise(resolve => setImmediate(resolve));
    const openB = viewer.open(target('session-b', 'input-b'));
    pages.get('session-b').resolve(page('session-b', 'input-b', 'visible-b'));
    await openB;
    pages.get('session-a').resolve(page('session-a', 'input-a', 'visible-a'));
    await openA;

    assert.equal(panel.postedMessages.at(-1).html.includes('visible-b'), true);
    assert.equal(panel.postedMessages.at(-1).html.includes('visible-a'), false);
    assert.equal(panel.createCount, 1);
    assert.deepEqual(watchDisposals, ['session-a']);
    assert.equal(viewer.snapshotSize, 1);

    panel.dispose();
    assert.deepEqual(restoredTargets, [target('session-b', 'input-b')]);
    assert.deepEqual(watchDisposals, ['session-a', 'session-b']);
    assert.equal(viewer.snapshotSize, 0);
});

test('CONVERSATION-VIEWER-OWNERSHIP-002 lets navigation request 5 win when request 4 resolves late', async () => {
    const fourth = deferred();
    const fifth = deferred();
    let requestCount = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2', 'input-3', 'input-4', 'input-5']
        ),
        readPage: request => {
            requestCount += 1;
            if (requestCount === 4) return fourth.promise;
            if (requestCount === 5) return fifth.promise;
            return Promise.resolve(page(
                request.sessionId,
                `input-${requestCount}`,
                `visible-${requestCount}`,
                { nextCursor: `cursor-${requestCount}` }
            ));
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    const requestFour = panel.receive({
        type: 'conversation-viewer-next',
        version: 1,
    });
    const requestFive = panel.receive({
        type: 'conversation-viewer-latest',
        version: 1,
    });

    fifth.resolve(page(
        'session-a',
        'input-5',
        'visible-5'
    ));
    await requestFive;
    fourth.resolve(page(
        'session-a',
        'input-4',
        'visible-4',
        { nextCursor: 'cursor-4' }
    ));
    await requestFour;

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('visible-5'), true);
    assert.equal(publication.html.includes('visible-4'), false);
});

test('CONVERSATION-VIEWER-NAVIGATION-001 follows Latest through bounded pages and selects the final interaction', async () => {
    const requests = [];
    const responses = [
        page('session-a', 'input-1', 'visible-1', {
            nextCursor: 'cursor-1',
        }),
        page('session-a', 'input-3', 'visible-3', {
            previousCursor: 'back-3',
        }),
    ];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2', 'input-3']
        ),
        readPage: request => {
            requests.push(request);
            return Promise.resolve(responses.shift());
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-latest', version: 1 });

    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
        cursor: request.cursor,
    })), [
        { anchorInteractionId: 'input-1', direction: 'around', cursor: undefined },
        { anchorInteractionId: 'input-3', direction: 'around', cursor: undefined },
    ]);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.html.includes('visible-3'), true);
});

test('CONVERSATION-VIEWER-NAVIGATION-002 moves within a loaded page without reading and publishes authoritative position metadata', async () => {
    let reads = 0;
    const interactionIds = Array.from(
        { length: 12 },
        (_item, index) => `input-${index + 1}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            reads += 1;
            return Promise.resolve(page(
                request.sessionId,
                'input-4',
                'visible-input',
                {
                    count: 12,
                    interactionIds,
                    anchorInteractionId: 'input-4',
                }
            ));
        },
    });

    await viewer.open(target('session-a', 'input-4'));
    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');

    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-4');
    assert.equal(publication.selectedInput, 4);
    assert.equal(publication.totalInputs, 12);
    assert.equal(publication.partial, false);

    await panel.receive({ type: 'conversation-viewer-latest', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-12');
    assert.equal(reads, 1);

    await panel.receive({ type: 'conversation-viewer-first', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(reads, 1);
});

test('CONVERSATION-SEEK-LATEST-COMMAND-001 exposes Latest navigation on the viewer API for the seek command', async () => {
    const requests = [];
    const responses = [
        page('session-a', 'input-1', 'visible-1', {
            nextCursor: 'cursor-1',
        }),
        page('session-a', 'input-3', 'visible-3', {
            previousCursor: 'back-3',
        }),
    ];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2', 'input-3']
        ),
        readPage: request => {
            requests.push(request);
            return Promise.resolve(responses.shift());
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.navigateLatest();

    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
        cursor: request.cursor,
    })), [
        { anchorInteractionId: 'input-1', direction: 'around', cursor: undefined },
        { anchorInteractionId: 'input-3', direction: 'around', cursor: undefined },
    ]);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.updateKind, 'navigation');
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.atLatest, true);
});

test('CONVERSATION-OUTLINE-NAVIGATION-001 CONVERSATION-OUTLINE-CONTROLLER-001 publishes the current Session outline and loads an exact selected input', async () => {
    const requests = [];
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            requests.push(request);
            return Promise.resolve(page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${request.anchorInteractionId}`
            ));
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.deepEqual(initial.outline, interactionIds.map(interactionId => ({
        interactionId,
        userPreview: interactionId,
        responseState: 'complete',
    })));

    await panel.receive({
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-3',
    });
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.html.includes('visible-input-3'), true);
    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
    })), [{
        anchorInteractionId: 'input-1',
        direction: 'around',
    }, {
        anchorInteractionId: 'input-3',
        direction: 'around',
    }]);

    const publicationsBeforeInvalid = panel.postedMessages.length;
    await panel.receive({
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'input-2',
        extra: 'rejected',
    });
    await panel.receive({
        type: 'conversation-viewer-select-interaction',
        version: 1,
        interactionId: 'missing-input',
    });
    assert.equal(panel.postedMessages.length, publicationsBeforeInvalid);
    assert.equal(requests.length, 2);
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 restores and Host-settles bookmarks without changing authoritative outline order', async () => {
    const saved = [];
    const bookmarkStore = {
        async load() {
            return { revision: 4, interactionIds: ['input-3'] };
        },
        async save(storeTarget, snapshot) {
            saved.push({
                target: { ...storeTarget },
                snapshot: {
                    revision: snapshot.revision,
                    interactionIds: [...snapshot.interactionIds],
                },
            });
        },
    };
    const interactionIds = ['input-1', 'input-2', 'input-3'];
    const { viewer, panel } = createViewer({
        bookmarkStore,
        readOutline: async (_provider, sessionId) =>
            outline(sessionId, interactionIds),
    });

    await viewer.open(target('session-a', 'input-2'));
    assert.deepEqual(decodeInitialBookmarks(panel.webview.html), {
        revision: 4,
        interactionIds: ['input-3'],
    });
    const before = decodeInitialPublication(panel.webview.html)
        .outline.map(entry => entry.interactionId);

    await panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'bookmark-1',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        expectedRevision: 4,
        payload: {
            interactionId: 'input-1',
            bookmarked: true,
        },
    });

    assert.deepEqual(saved, [{
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-a',
        },
        snapshot: {
            revision: 5,
            interactionIds: ['input-3', 'input-1'],
        },
    }]);
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-bookmarks-result',
        version: 1,
        requestId: 'bookmark-1',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        success: true,
        revision: 5,
        interactionIds: ['input-3', 'input-1'],
    });
    assert.deepEqual(
        decodeInitialPublication(panel.webview.html)
            .outline.map(entry => entry.interactionId),
        before
    );
});

test('CONVERSATION-SESSION-REBIND-001 freezes and drains old-root metadata mutations before copying', async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const saved = [];
    const { viewer, panel } = createViewer({
        bookmarkStore: {
            async load() {
                return { revision: 0, interactionIds: [] };
            },
            async save(storeTarget, snapshot) {
                saved.push({ storeTarget, snapshot });
                saveStarted.resolve();
                await releaseSave.promise;
            },
        },
    });
    await viewer.open(target('old-root'));
    const firstMutation = panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'before-freeze',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        expectedRevision: 0,
        payload: { interactionId: 'input-1', bookmarked: true },
    });
    await saveStarted.promise;

    let drainSettled = false;
    const drain = viewer.freezeSessionMetadata({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    }).then(result => {
        drainSettled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(drainSettled, false, 'copy barrier must await active saves');
    const frozenMutation = panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'after-freeze',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        expectedRevision: 0,
        payload: { interactionId: 'input-1', bookmarked: false },
    });
    releaseSave.resolve();

    await firstMutation;
    assert.equal(await drain, true);
    await frozenMutation;
    assert.equal(saved.length, 1, 'a frozen mutation must not write old storage');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-bookmarks-result',
        version: 1,
        requestId: 'after-freeze',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        success: false,
        revision: 1,
        interactionIds: ['input-1'],
        error: 'stale',
    });
});

test('CONVERSATION-SESSION-REBIND-001 drains an old-root mutation after the viewer has already switched', async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const saved = [];
    const { viewer, panel } = createViewer({
        bookmarkStore: {
            async load() {
                return { revision: 0, interactionIds: [] };
            },
            async save(storeTarget, snapshot) {
                saved.push({
                    target: { ...storeTarget },
                    snapshot: {
                        revision: snapshot.revision,
                        interactionIds: [...snapshot.interactionIds],
                    },
                });
                if (saved.length === 1) {
                    saveStarted.resolve();
                    await releaseSave.promise;
                }
            },
        },
    });
    await viewer.open(target('old-root'));
    const oldMutation = panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'old-pending',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'set',
        expectedRevision: 0,
        payload: { interactionId: 'input-1', bookmarked: true },
    });
    await saveStarted.promise;
    assert.equal(await viewer.follow(target('other-root')), true);

    let drainSettled = false;
    const drain = viewer.freezeSessionMetadata({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    }).then(result => {
        drainSettled = true;
        return result;
    });
    await Promise.resolve();
    assert.equal(drainSettled, false);
    releaseSave.resolve();

    await oldMutation;
    assert.equal(await drain, false, 'the current target must stay unfrozen');
    assert.deepEqual(saved, [{
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'old-root',
        },
        snapshot: { revision: 1, interactionIds: ['input-1'] },
    }, {
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'old-root',
        },
        snapshot: { revision: 0, interactionIds: [] },
    }], 'the stale old write must finish its rollback before copying');
});

test('CONVERSATION-SESSION-REBIND-001 rolls back a stale old-root comment before the copy barrier settles', async () => {
    const saveStarted = deferred();
    const releaseSave = deferred();
    const saved = [];
    const { viewer, panel } = createViewer({
        commentStore: {
            async load() {
                return { revision: 0, comments: [] };
            },
            async save(storeTarget, snapshot) {
                saved.push({
                    target: { ...storeTarget },
                    snapshot: {
                        revision: snapshot.revision,
                        comments: snapshot.comments.map(comment => ({
                            ...comment,
                        })),
                    },
                });
                if (saved.length === 1) {
                    saveStarted.resolve();
                    await releaseSave.promise;
                }
            },
        },
    });
    await viewer.open(target('old-root'));
    const oldMutation = panel.receive({
        type: 'conversation-viewer-comment-mutation',
        version: 1,
        requestId: 'old-comment-pending',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
        operation: 'add',
        expectedRevision: 0,
        payload: {
            scope: 'session',
            comment: 'Do not migrate a failed comment.',
        },
    });
    await saveStarted.promise;
    assert.equal(await viewer.follow(target('other-root')), true);
    const drain = viewer.freezeSessionMetadata({
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'old-root',
    });
    releaseSave.resolve();

    await oldMutation;
    assert.equal(await drain, false);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].snapshot.revision, 1);
    assert.equal(saved[0].snapshot.comments.length, 1);
    assert.deepEqual(saved[1], {
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'old-root',
        },
        snapshot: { revision: 0, comments: [] },
    });
});

test('CONVERSATION-OUTLINE-BOOKMARKS-001 rejects stale or unknown input bookmark intents without persisting', async () => {
    let saves = 0;
    const { viewer, panel } = createViewer({
        bookmarkStore: {
            async load() {
                return { revision: 2, interactionIds: [] };
            },
            async save() {
                saves += 1;
            },
        },
        readOutline: async (_provider, sessionId) =>
            outline(sessionId, ['input-1', 'input-2']),
    });
    await viewer.open(target('session-a'));

    await panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'bookmark-stale',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        expectedRevision: 1,
        payload: { interactionId: 'input-1', bookmarked: true },
    });
    await panel.receive({
        type: 'conversation-viewer-bookmark-mutation',
        version: 1,
        requestId: 'bookmark-unknown',
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'set',
        expectedRevision: 2,
        payload: { interactionId: 'missing', bookmarked: true },
    });

    assert.equal(saves, 0);
    assert.deepEqual(
        panel.postedMessages.slice(-2).map(message => message.error),
        ['stale', 'stale']
    );
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 evicts above 100 interactions while retaining the selected anchor and a reload cursor', async () => {
    let readIndex = 0;
    const interactionIds = Array.from(
        { length: 6 },
        (_page, pageIndex) => retainedPageInteractionIds(pageIndex, 20, 'page')
    ).flat();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            const current = readIndex;
            readIndex += 1;
            return Promise.resolve(page(
                request.sessionId,
                current === 0 ? 'selected-anchor' : `page-${current}`,
                `visible-page-${current}`,
                {
                    count: 20,
                    interactionOffset: current * 20,
                    previousCursor: current > 0
                        ? `back-cursor-${current}`
                        : undefined,
                    nextCursor: current < 5 ? `cursor-${current}` : undefined,
                }
            ));
        },
    });

    await viewer.open(target('session-a', 'selected-anchor'));
    for (let index = 0; index < 119; index++) {
        await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    }

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    const contentPublication = lastContentPublication(panel);
    assert.equal(viewer.snapshotSize, 100);
    assert.equal(contentPublication.html.includes('selected-anchor'), false);
    assert.equal(contentPublication.html.includes('visible-page-5'), true);
    assert.equal(publication.selectedInteractionId, 'page-5-119');
    assert.equal(publication.previousCursor, 'back-cursor-1');
    assert.ok(Buffer.byteLength(contentPublication.html, 'utf8') <= 4 * 1024 * 1024);
});

test('CONVERSATION-VIEWER-BOUNDS-002 evicts above 4 MiB using individually valid page envelopes', async () => {
    let readIndex = 0;
    const padding = 'x'.repeat(47_000);
    const interactionIds = Array.from(
        { length: 10 },
        (_page, pageIndex) => retainedPageInteractionIds(
            pageIndex,
            10,
            'byte-page'
        )
    ).flat();
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds
        ),
        readPage: request => {
            const current = readIndex;
            readIndex += 1;
            const result = page(
                request.sessionId,
                current === 0 ? 'selected-anchor' : `byte-page-${current}`,
                `visible-byte-page-${current}`,
                {
                    count: 10,
                    interactionOffset: current * 10,
                    previousCursor: current > 0
                        ? `byte-back-cursor-${current}`
                        : undefined,
                    padding,
                    nextCursor: current < 9
                        ? `byte-cursor-${current}`
                        : undefined,
                }
            );
            assert.ok(
                Buffer.byteLength(JSON.stringify(result), 'utf8') <= 512 * 1024,
                'fixture pages must respect the coordinator page bound'
            );
            return Promise.resolve(result);
        },
    });

    await viewer.open(target('session-a', 'selected-anchor'));
    for (let index = 0; index < 99; index++) {
        await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    }

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    const contentPublication = lastContentPublication(panel);
    assert.equal(contentPublication.html.includes('selected-anchor'), false);
    assert.equal(contentPublication.html.includes('visible-byte-page-9'), true);
    assert.equal(publication.selectedInteractionId, 'byte-page-9-99');
    assert.equal(publication.previousCursor, 'byte-back-cursor-2');
    assert.equal(publication.nextCursor, undefined);
    assert.ok(viewer.snapshotSize < 100);
    assert.ok(Buffer.byteLength(contentPublication.html, 'utf8') <= 4 * 1024 * 1024);
});

test('CONVERSATION-VIEWER-SECURITY-001 emits a nonce-only CSP and opens only HTTPS links', async () => {
    const { viewer, panel, openedUris } = createViewer();
    await viewer.open(target('session-a'));

    assert.match(panel.webview.html, /default-src 'none';/);
    assert.match(panel.webview.html, /img-src https: blob:;/);
    assert.match(panel.webview.html, /style-src fixture-csp 'unsafe-inline';/);
    assert.match(panel.webview.html, /font-src fixture-csp;/);
    assert.match(panel.webview.html, /script-src 'nonce-[^']+';/);
    assert.doesNotMatch(panel.webview.html, /script-src[^;]*unsafe-inline/);
    assert.match(panel.webview.html, /data-auto-scroll-threshold="8"/);
    assert.equal(
        panel.createArguments[3].localResourceRoots[0].toString(),
        'file:///extension/media/'
    );
    // Each asset URL carries a per-document cache-busting revision, so match the
    // resource path and allow the query rather than pinning the whole URL.
    assert.match(
        panel.webview.html,
        /src="webview:\/\/fixture\/\/extension\/media\/purify\.min\.js\?[^"]*"/
    );
    assert.match(
        panel.webview.html,
        /data-mermaid-src="webview:\/\/fixture\/\/extension\/media\/mermaid\.min\.js\?[^"]*"/
    );
    assert.match(
        panel.webview.html,
        /href="webview:\/\/fixture\/\/extension\/media\/conversationViewer\.css\?[^"]*"/
    );
    assert.match(
        panel.webview.html,
        /href="webview:\/\/fixture\/\/extension\/media\/katex\.min\.css\?[^"]*"/
    );
    const purifyIndex = panel.webview.html.indexOf('purify.min.js');
    const readingAnchorIndex = panel.webview.html.indexOf(
        'conversationReadingAnchorScripts.js'
    );
    const mermaidControllerIndex = panel.webview.html.indexOf(
        'conversationMermaidScripts.js'
    );
    const outlineControllerIndex = panel.webview.html.indexOf(
        'conversationOutlineScripts.js'
    );
    const telemetryControllerIndex = panel.webview.html.indexOf(
        'conversationTelemetryScripts.js'
    );
    const commentsControllerIndex = panel.webview.html.indexOf(
        'conversationCommentsScripts.js'
    );
    const sidebarControllerIndex = panel.webview.html.indexOf(
        'conversationSidebarScripts.js'
    );
    const reconcileControllerIndex = panel.webview.html.indexOf(
        'conversationReconcileScripts.js'
    );
    const findControllerIndex = panel.webview.html.indexOf(
        'conversationFindScripts.js'
    );
    const viewerIndex = panel.webview.html.indexOf(
        'conversationViewerScripts.js'
    );
    assert.ok(purifyIndex >= 0 && purifyIndex < readingAnchorIndex);
    assert.ok(readingAnchorIndex < mermaidControllerIndex);
    assert.ok(mermaidControllerIndex < outlineControllerIndex);
    assert.ok(outlineControllerIndex < telemetryControllerIndex);
    assert.ok(telemetryControllerIndex < commentsControllerIndex);
    assert.ok(commentsControllerIndex < sidebarControllerIndex);
    assert.ok(sidebarControllerIndex < reconcileControllerIndex);
    assert.ok(reconcileControllerIndex < findControllerIndex);
    assert.ok(findControllerIndex < viewerIndex);

    for (const href of [
        'javascript:alert(1)',
        'data:text/html,unsafe',
        'file:///tmp/private',
        'command:workbench.action.reloadWindow',
        'http://example.test/insecure',
        'https://example.test/safe',
    ]) {
        await panel.receive({
            type: 'conversation-viewer-open-link',
            version: 1,
            href,
        });
    }

    assert.deepEqual(openedUris, ['https://example.test/safe']);
});

test('CONVERSATION-LOCAL-FILE-LINKS-001 routes absolute and workspace-relative file links with exact positions', async () => {
    const openedFiles = [];
    const openedTargets = [];
    const filePath = '/home/example/project/src/localStore.ts';
    const { viewer, panel } = createViewer({
        openLocalFile: async (targetFile, viewerTarget) => {
            openedFiles.push(targetFile);
            openedTargets.push(viewerTarget);
        },
        readPage: async request => ({
            ...page(request.sessionId, request.anchorInteractionId),
            messages: [{
                id: `${request.anchorInteractionId}:assistant`,
                interactionId: request.anchorInteractionId,
                role: 'assistant',
                markdown: `[localStore.ts](${filePath}:17) and src/viewer.ts#L20`,
            }],
        }),
    });

    await viewer.open(target('session-a'));

    assert.match(
        decodeInitialPublication(panel.webview.html).html,
        /<a href="\/home\/example\/project\/src\/localStore\.ts:17">localStore\.ts<\/a>/
    );
    await panel.receive({
        type: 'conversation-viewer-open-link',
        version: 1,
        href: `${filePath}:17`,
    });
    await panel.receive({
        type: 'conversation-viewer-open-link',
        version: 1,
        href: 'src/viewer.ts#L20',
    });
    assert.deepEqual(openedFiles, [{
        fsPath: filePath,
        line: 17,
        column: 1,
    }, {
        relativePath: 'src/viewer.ts',
        line: 20,
        column: 1,
    }]);
    assert.deepEqual(openedTargets.map(current => ({
        projectId: current.projectId,
        provider: current.provider,
        sessionId: current.sessionId,
    })), [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }, {
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    }], 'file resolution remains bound to the viewed conversation target');
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 routes one exact selection send to the active terminal inserter', async () => {
    const inserted = [];
    const { viewer, panel } = createViewer({
        insertIntoActiveTerminal: async text => {
            inserted.push(text);
        },
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive({
        type: 'conversation-viewer-send-selection',
        version: 1,
        text: 'beta quote',
    });
    assert.deepEqual(inserted, ['beta quote']);

    for (const message of [
        { type: 'conversation-viewer-send-selection', version: 1 },
        { type: 'conversation-viewer-send-selection', version: 1, text: '   ' },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: 'x'.repeat(4001),
        },
        {
            type: 'conversation-viewer-send-selection',
            version: 1,
            text: 'ok',
            extra: true,
        },
    ]) {
        await panel.receive(message);
    }
    assert.deepEqual(inserted, ['beta quote']);
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 CONVERSATION-RUN-COMMAND-001 runs a bound command in the command terminal', async () => {
    const runs = [];
    const { viewer, panel } = createViewer({
        runCommandInTerminal: async (viewerTarget, command) => {
            runs.push({ viewerTarget, command });
        },
    });
    await viewer.open(target('session-a', 'input-1'));
    const request = {
        type: 'conversation-viewer-run-command',
        version: 1,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        command: 'find . -iname "*profile*"',
    };
    await panel.receive(request);
    assert.deepEqual(runs, [{
        viewerTarget: target('session-a', 'input-1'),
        command: request.command,
    }]);

    await panel.receive({ ...request, sessionId: 'session-other' });
    await panel.receive({ ...request, subscriptionGeneration: 2 });
    assert.equal(runs.length, 1,
        'stale or cross-session commands must never reach the terminal host');
});

test('WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001 routes adjacent session switches with the authoritative current target', async () => {
    const switches = [];
    const { viewer, panel } = createViewer({
        followAdjacentConversation: async (direction, currentTarget) => {
            switches.push({ direction, currentTarget });
        },
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive({
        type: 'conversation-viewer-switch-session',
        version: 1,
        direction: 'next',
    });
    assert.deepEqual(switches, [{
        direction: 'next',
        currentTarget: target('session-a', 'input-1'),
    }]);

    for (const message of [
        { type: 'conversation-viewer-switch-session', version: 1 },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
            direction: 'up',
        },
        {
            type: 'conversation-viewer-switch-session',
            version: 1,
            direction: 'previous',
            extra: true,
        },
    ]) {
        await panel.receive(message);
    }
    assert.equal(switches.length, 1);
});

test('CONVERSATION-WORKING-INDICATOR-001 includes one polite hidden Working status in the Host document', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-working'));

    assert.equal(
        (panel.webview.html.match(/data-conversation-working/g) || []).length,
        1
    );
    assert.match(
        panel.webview.html,
        /data-conversation-working[\s\S]*role="status"[\s\S]*aria-live="polite"[\s\S]*hidden/
    );
    assert.match(panel.webview.html, />Working<\/span>/);
});

test('CONVERSATION-READING-FOCUS-001 keeps modular Webview controllers byte-identical in packaged media', () => {
    for (const fileName of [
        'conversationRegistryScripts.js',
        'conversationReadingAnchorScripts.js',
        'conversationMermaidScripts.js',
        'conversationOutlineScripts.js',
        'conversationTelemetryScripts.js',
        'conversationCommentsScripts.js',
        'conversationSidebarScripts.js',
        'conversationReconcileScripts.js',
        'conversationViewerScripts.js',
    ]) {
        assert.equal(
            fs.readFileSync(path.join('media', fileName), 'utf8'),
            fs.readFileSync(path.join('src', 'webview', fileName), 'utf8'),
            `${fileName} is stale in media`
        );
    }
});

test('CONVERSATION-VIEWER-REFRESH-001 retains stale content after a watched failure and clears stale after recovery', async () => {
    let onChange;
    let readCount = 0;
    let outlineCount = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineCount += 1;
            return outline(
                sessionId,
                outlineCount < 3 ? ['input-1'] : ['input-1', 'input-2'],
                {
                    sourceRevision: outlineCount === 1 ? 'r1' : 'r2',
                    ...(outlineCount < 3
                        ? {}
                        : { totalInteractions: 2_001, partial: true }),
                }
            );
        },
        readPage: request => {
            readCount += 1;
            if (readCount === 2) {
                return Promise.reject(new Error('private source failure'));
            }
            return Promise.resolve(page(
                request.sessionId,
                request.anchorInteractionId,
                readCount === 1 ? 'visible-initial' : 'visible-recovered',
                { sourceRevision: request.expectedRevision }
            ));
        },
    });

    await viewer.open(target('session-a'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, true);
    assert.equal(publication.updateKind, 'refresh');
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('visible-initial'),
        true
    );
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('private source failure'),
        false
    );

    await viewer.refresh();
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-recovered'), true);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);
});

test('CONVERSATION-THINKING-VISIBILITY-001 preserves thinking content across an authoritative refresh', async () => {
    let revision = 1;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => ({
            ...page(
                request.sessionId,
                request.anchorInteractionId,
                'visible-response',
                { sourceRevision: request.expectedRevision }
            ),
            messages: [{
                id: 'input-1:thinking:0',
                interactionId: 'input-1',
                role: 'thinking',
                markdown: '',
                thinking: { text: `thinking revision ${revision}` },
            }],
        }),
        showThinking: () => true,
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(
        decodeInitialPublication(panel.webview.html).html
            .includes('thinking revision 1'),
        true
    );

    revision = 2;
    await viewer.refresh();
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('thinking revision 2'), true);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 omits unchanged HTML from delta publications only after the applied ack', async () => {
    let revision = 1;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-r${revision}`,
            {
                interactionIds: ['input-1', 'input-2'],
                sourceRevision: request.expectedRevision,
            }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    assert.equal(typeof initial.html, 'string');
    assert.equal(typeof initial.htmlSignature, 'string');

    // Before the Webview acknowledges applying the content, even a pure
    // selection change must carry the full HTML: postMessage resolving only
    // proves queueing, never application.
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    const unacknowledged = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(unacknowledged.selectedInteractionId, 'input-2');
    assert.equal(unacknowledged.html.includes('visible-r1'), true);

    // A mismatched or stale ack must not unlock omission.
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: unacknowledged.subscriptionGeneration,
        requestId: unacknowledged.requestId,
        htmlSignature: 'not-the-content-signature',
    });
    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    const wronglyAcked = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(wronglyAcked.html.includes('visible-r1'), true);

    // The correlated ack for the latest publication unlocks delta delivery.
    await panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: wronglyAcked.subscriptionGeneration,
        requestId: wronglyAcked.requestId,
        htmlSignature: wronglyAcked.htmlSignature,
    });
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    const delta = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(delta.selectedInteractionId, 'input-2');
    assert.equal(delta.html, undefined);
    assert.equal(delta.htmlSignature, initial.htmlSignature);

    // A content change republishes the full HTML under a new signature.
    revision = 2;
    await viewer.refresh();
    const refreshed = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(refreshed.html.includes('visible-r2'), true);
    assert.notEqual(refreshed.htmlSignature, initial.htmlSignature);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 rebuilds the document once per subscription generation when the Webview requests a resync', async () => {
    let revision = 1;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-resync-${revision}`,
            { sourceRevision: `r${revision}` }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    let htmlWrites = 0;
    let stored = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
        get: () => stored,
        set: value => {
            htmlWrites += 1;
            stored = value;
        },
    });
    const requestSync = publication => panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });

    await requestSync(initial);
    assert.equal(htmlWrites, 1, 'a resync request rebuilds the document');
    assert.equal(
        decodeInitialPublication(stored).html.includes('visible-resync'),
        true
    );

    // The same publication is never rebuilt twice: a persistent apply
    // failure in the Webview must not reload-loop the document.
    await requestSync(decodeInitialPublication(stored));
    assert.equal(htmlWrites, 1);

    // A live provider can publish again while the restored Webview still
    // cannot apply its document. The recovery allowance belongs to the
    // subscription generation, not each fresh publication, or every watcher
    // refresh recreates the document and restarts the failed Webview.
    revision = 2;
    await viewer.refresh();
    const refreshed = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    await requestSync(refreshed);
    assert.equal(htmlWrites, 1,
        'a later publication in the same generation must not reload-loop');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 recovers a legacy resync outside a target handoff', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(sessionId, ['input-1']),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            'visible-legacy-resync'
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    let htmlWrites = 0;
    let rendered = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
        get: () => rendered,
        set: value => {
            htmlWrites += 1;
            rendered = value;
        },
    });

    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    const recovered = decodeInitialPublication(rendered);
    assert.equal(htmlWrites, 1,
        'a legacy refresh failure receives one safe full-document recovery');
    assert.notEqual(recovered.requestId, initial.requestId);

    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: initial.subscriptionGeneration,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
    });
    assert.equal(htmlWrites, 1,
        'a persistent legacy failure remains bounded to one recovery attempt');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 ignores resync requests correlated to a superseded generation or session', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });
    const lastPage = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    const requestSync = publication => panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: publication.target.sessionId,
    });

    await viewer.open(target('session-a', 'input-1'));
    const initialA = decodeInitialPublication(panel.webview.html);
    const generationA = initialA.subscriptionGeneration;
    await viewer.follow(target('session-b', 'input-1'));
    const publicationB = lastPage();
    const generationB = publicationB.subscriptionGeneration;
    let htmlWrites = 0;
    let stored = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
        get: () => stored,
        set: value => {
            htmlWrites += 1;
            stored = value;
        },
    });

    // A resync stranded by the switch to session-b belongs to the
    // superseded generation: session-b's own delivery and ack closure
    // recovers the Webview, so the Host must not rebuild.
    await requestSync(initialA);
    assert.equal(htmlWrites, 0,
        'a resync from a superseded generation is stale');

    // The current generation with a different session is stale too: the
    // Webview can only fail to apply the session it is switching away
    // from while the Host already owns the new target.
    await requestSync({ ...publicationB, target: { ...publicationB.target, sessionId: 'session-a' } });
    assert.equal(htmlWrites, 0,
        'a resync naming another session is stale');

    // The current session with a superseded generation is stale as well.
    await requestSync({ ...publicationB, subscriptionGeneration: generationA });
    assert.equal(htmlWrites, 0,
        'a resync from a superseded generation for the current session'
            + ' is stale');

    // The correctly correlated request still rebuilds exactly once.
    await requestSync(publicationB);
    assert.equal(htmlWrites, 1);
    assert.equal(
        decodeInitialPublication(stored).html.includes('visible-session-b'),
        true
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 ignores a delayed resync from an earlier publication in the same session', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(sessionId, ['input-1']),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });
    const acknowledge = publication => panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });
    const requestSync = publication => panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
        projectId: publication.target.projectId,
        provider: publication.target.provider,
        sessionId: publication.target.sessionId,
    });

    await viewer.open(target('session-a', 'input-1'));
    await acknowledge(decodeInitialPublication(panel.webview.html));
    let htmlWrites = 0;
    let rendered = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
        get: () => rendered,
        set: value => {
            htmlWrites += 1;
            rendered = value;
        },
    });
    await viewer.follow(target('session-b', 'input-1'));
    const firstPublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    await viewer.refreshPresentation();
    const secondPublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    assert.equal(
        secondPublication.subscriptionGeneration,
        firstPublication.subscriptionGeneration,
        'the competing publications belong to the same target generation'
    );
    assert.notEqual(secondPublication.requestId, firstPublication.requestId);

    await requestSync(firstPublication);
    assert.equal(htmlWrites, 0,
        'a delayed resync cannot rebuild or consume the newer publication');
    await requestSync(secondPublication);
    assert.equal(htmlWrites, 1,
        'the exact current publication remains recoverable');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 safely ignores a correlated resync that arrives before the first publication', async () => {
    let releaseOutline;
    const outlineGate = new Promise(resolve => {
        releaseOutline = resolve;
    });
    let outlineCalls = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineCalls += 1;
            if (outlineCalls === 2) {
                // Hold session-b's initial load in flight.
                await outlineGate;
            }
            return outline(sessionId, ['input-1']);
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });
    const lastPage = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);

    await viewer.open(target('session-a', 'input-1'));
    const generationA = decodeInitialPublication(
        panel.webview.html
    ).subscriptionGeneration;
    let htmlWrites = 0;
    let stored = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
        get: () => stored,
        set: value => {
            htmlWrites += 1;
            stored = value;
        },
    });
    const followPromise = viewer.follow(target('session-b', 'input-1'));

    // Wait until the switch has actually begun: the loading notice is
    // posted right after the target replacement, while session-b's load
    // is still gated in flight.
    let notice;
    for (let attempts = 0; attempts < 20 && !notice; attempts += 1) {
        notice = panel.postedMessages.find(message =>
            message.type === 'conversation-viewer-loading');
        if (!notice) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }
    assert.ok(notice, 'the switch began and announced its loading state');
    assert.equal(notice.subscriptionGeneration, generationA + 1);

    // The request matches the current generation and session, but the
    // first publication is still in flight: there is nothing to rebuild,
    // and the in-flight load's own delivery owns the recovery.
    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: notice.subscriptionGeneration,
        requestId: 1,
        htmlSignature: 'before-first-publication',
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    });
    assert.equal(htmlWrites, 0,
        'no rebuild while the correlated publication is still in flight');

    releaseOutline();
    await followPromise;
    const incoming = lastPage();
    assert.equal(incoming.subscriptionGeneration, generationA + 1);
    assert.equal(incoming.html.includes('visible-session-b'), true,
        'the in-flight load still delivers the full publication');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 announces a lightweight loading state when a reused panel switches sessions', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });
    const loadingNotices = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-loading');

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(loadingNotices().length, 0,
        'a fresh panel renders its own loading document instead');

    await viewer.follow(target('session-b', 'input-1'));
    const notices = loadingNotices();
    assert.equal(notices.length, 1,
        'a reused panel switching sessions announces the lightweight load');
    const incoming = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(notices[0], {
        type: 'conversation-viewer-loading',
        version: 1,
        subscriptionGeneration: incoming.subscriptionGeneration,
        target: {
            projectId: 'project-a',
            provider: 'codex',
            sessionId: 'session-b',
        },
    });
    assert.ok(
        panel.postedMessages.indexOf(notices[0])
            < panel.postedMessages.lastIndexOf(incoming),
        'the notice precedes the incoming session publication'
    );

    // Reloading the already-visible session is not a switch: the live
    // content must not be dimmed behind a loading notice.
    await viewer.refresh();
    assert.equal(loadingNotices().length, 1);
    await viewer.follow(target('session-b', 'input-1'));
    assert.equal(loadingNotices().length, 1,
        're-following the visible session is not a switch either');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 retains an exact target without publishing another conversation page', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1']);
        },
        readPage: async request => {
            pageReads += 1;
            return page(request.sessionId, request.anchorInteractionId);
        },
    });
    const sameTarget = target('session-a', 'input-1');
    await viewer.open(sameTarget);
    const pageMessagesBefore = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').length;
    const generationBefore = viewer.getCurrentTarget().expectedRevision;
    const outlineReadsBefore = outlineReads;
    const pageReadsBefore = pageReads;

    assert.deepEqual(viewer.getCurrentTarget(), sameTarget,
        'the follow input matches the authoritative target exactly');
    assert.equal(await viewer.follow(sameTarget), true);
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page').length,
        pageMessagesBefore,
        'an unchanged exact target must not reapply the conversation page'
    );
    assert.equal(viewer.getCurrentTarget().expectedRevision, generationBefore,
        'the retained target stays authoritative without a generation reset');
    assert.equal(outlineReads, outlineReadsBefore,
        'an unchanged target must not reread the conversation outline');
    assert.equal(pageReads, pageReadsBefore,
        'an unchanged target must not reparse the conversation page');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 completes an exact-target follow without waiting for an unrelated refresh', async () => {
    const refreshStarted = deferred();
    const releaseRefresh = deferred();
    let outlineReads = 0;
    let delayRefresh = false;
    const { viewer } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            if (delayRefresh) {
                refreshStarted.resolve();
                await releaseRefresh.promise;
            }
            return outline(sessionId, ['input-1']);
        },
    });
    const sameTarget = target('session-a', 'input-1');
    await viewer.open(sameTarget);
    delayRefresh = true;
    const refresh = viewer.refresh();
    await refreshStarted.promise;
    assert.equal(await viewer.follow(sameTarget), true,
        'the duplicate target is already authoritative while its refresh continues');
    assert.equal(outlineReads, 2,
        'the duplicate follow does not queue another outline read');
    releaseRefresh.resolve();
    await refresh;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 2,
        'the duplicate follow does not queue another read after refresh completion');
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 rebuilds a stalled reused-panel publication instead of leaving Conversation loading', async () => {
    const timers = new Map();
    let nextTimer = 1;
    const diagnostics = [];
    const { viewer, panel } = createViewer({
        setTimer(callback, delayMs) {
            const handle = nextTimer++;
            timers.set(handle, {
                delayMs,
                callback: () => {
                    timers.delete(handle);
                    callback();
                },
            });
            return handle;
        },
        clearTimer(handle) {
            timers.delete(handle);
        },
        onDiagnostic: event => diagnostics.push(event),
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`
        ),
    });
    const acknowledge = publication => panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
    });

    await viewer.open(target('session-a', 'input-1'));
    await acknowledge(decodeInitialPublication(panel.webview.html));
    let htmlWrites = 0;
    let rendered = panel.webview.html;
    Object.defineProperty(panel.webview, 'html', {
        get: () => rendered,
        set: value => {
            htmlWrites += 1;
            rendered = value;
        },
    });

    await viewer.follow(target('session-b', 'input-1'));
    const stalled = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page'
    ).at(-1);
    const watchdog = Array.from(timers.values()).find(timer =>
        timer.delayMs === 4_000
    );
    assert.ok(watchdog, 'a target handoff must bound its applied receipt');

    // A retained version-1 Webview lacks publication identifiers. It remains
    // parseable, but cannot consume this newer publication's recovery slot;
    // the correlated watchdog still closes the loading handoff below.
    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: stalled.subscriptionGeneration,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    });
    assert.equal(htmlWrites, 0);

    watchdog.callback();
    assert.equal(htmlWrites, 1,
        'a missed receipt rebuilds the current page as a full document');
    const recovered = decodeInitialPublication(rendered);
    assert.equal(recovered.subscriptionGeneration, stalled.subscriptionGeneration);
    assert.notEqual(recovered.requestId, stalled.requestId,
        'a document recovery starts a new correlated application attempt');
    assert.equal(recovered.restoreFocus, undefined,
        'a recovery never steals focus after the user has left the Viewer');
    assert.equal(recovered.htmlSignature, stalled.htmlSignature);
    assert.equal(recovered.html.includes('visible-session-b'), true);
    assert.equal(diagnostics.some(event =>
        event.reason === 'publication-ack-timeout'
    ), true);

    // A late acknowledgement from the outgoing document cannot settle the
    // recovered document, whose request id is a new application attempt.
    await acknowledge(stalled);
    const recoveryTimer = Array.from(timers.values()).find(timer =>
        timer.delayMs === 4_000
    );
    assert.ok(recoveryTimer,
        'a late outgoing acknowledgement must not cancel recovery watchdog');

    // A late request-sync identifies the original failed publication and is
    // rejected rather than consuming the recovery publication's allowance.
    await panel.receive({
        type: 'conversation-viewer-request-sync',
        version: 1,
        subscriptionGeneration: stalled.subscriptionGeneration,
        requestId: stalled.requestId,
        htmlSignature: stalled.htmlSignature,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-b',
    });
    assert.equal(htmlWrites, 1,
        'watchdog and request-sync cannot rebuild one publication twice');

    // A persistent broken Webview gets only one fallback per publication.
    recoveryTimer.callback();
    assert.equal(htmlWrites, 1);
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 offers a frame restore only for acknowledged session content', async () => {
    let changed = false;
    const timings = [];
    const { viewer, panel } = createViewer({
        onTiming: timing => timings.push(timing),
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1', 'input-2'],
            { sourceRevision: `${sessionId}-${changed ? 'r2' : 'r1'}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `${changed ? 'changed' : 'visible'}-${request.sessionId}`,
            {
                interactionIds: ['input-1', 'input-2'],
                sourceRevision: request.expectedRevision,
            }
        ),
    });
    const frameEntry = (sessionId, token) => ({
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
        token,
    });
    const ack = (publication, frames) => panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
        frames,
    });
    const lastPage = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);

    await viewer.open(target('session-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    // Nothing is stashed in the Webview yet: an empty report.
    await ack(initial, []);

    // A session the Webview never reported gets full HTML on switch.
    await viewer.follow(target('session-b', 'input-1'));
    let latest = lastPage();
    assert.equal(latest.html.includes('visible-session-b'), true);
    assert.equal(latest.restoreFrame, undefined);
    const sessionBToken = latest.htmlSignature;

    // The Webview reports it stashed session-a's frame with that token.
    await ack(latest, [frameEntry('session-a', initial.htmlSignature)]);

    // Switching back to session-a: its content is unchanged and the Webview
    // proved it still holds the frame, so the Host offers a frame restore
    // instead of resending and reparsing the HTML.
    await viewer.follow(target('session-a', 'input-1'));
    latest = lastPage();
    assert.equal(latest.html, undefined);
    assert.equal(latest.restoreFrame, true);
    assert.equal(latest.htmlSignature, initial.htmlSignature,
        'a reload of unchanged content must keep the same content token');

    // Content changed while away: the switch back must carry full HTML.
    await ack(latest, [frameEntry('session-b', sessionBToken)]);
    assert.equal(timings.at(-1)?.delivery, 'message');
    assert.equal(timings.at(-1)?.contentBytes, 0,
        'a frame restore must report no HTML retransmission');
    assert.equal(timings.at(-1)?.progressive, false);
    await viewer.follow(target('session-b', 'input-1'));
    latest = lastPage();
    assert.equal(latest.restoreFrame, true,
        'session-b is on the reported list and unchanged');
    await ack(latest, [frameEntry('session-a', initial.htmlSignature)]);
    changed = true;
    await viewer.follow(target('session-a', 'input-1'));
    latest = lastPage();
    assert.equal(latest.html.includes('changed-session-a'), true,
        'changed content must never be served a stale frame restore');
    assert.equal(latest.restoreFrame, undefined);
    viewer.dispose();
});

// Returning to a conversation is the most common switch there is. The Webview
// already holds that session's converged document detached, so reattaching it
// must beat repainting: a progressive publication's signature describes only
// the partial page, so it can never match the stashed frame's token, and
// preferring it would replay the whole backfill on every return visit.
test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 restores a large conversation from its stashed frame instead of repainting', async () => {
    const bigIds = Array.from(
        { length: 100 },
        (_item, index) => `input-${index + 1}`
    );
    const smallIds = ['b-1', 'b-2'];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            sessionId === 'big-a' ? bigIds : smallIds
        ),
        readPage: async request => page(
            request.sessionId,
            request.sessionId === 'big-a' ? bigIds[0] : smallIds[0],
            'message',
            {
                interactionIds: request.sessionId === 'big-a'
                    ? bigIds
                    : smallIds,
                anchorInteractionId: request.sessionId === 'big-a'
                    ? bigIds.at(-1)
                    : smallIds.at(-1),
            }
        ),
    });
    const lastPage = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    const ack = (publication, frames) => panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
        frames,
    });

    // Open the large conversation and converge it exactly as a Webview does:
    // the applied token advances with every slice.
    await viewer.open(target('big-a', bigIds.at(-1)));
    const partial = decodeInitialPublication(panel.webview.html);
    assert.match(partial.html, /Loading earlier messages/);
    let appliedToken = partial.htmlSignature;
    await ack(partial, []);
    let slice = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-history-chunk').at(-1);
    assert.ok(slice, 'the deferred history must backfill');
    for (let guard = 0; guard < 10 && slice; guard++) {
        appliedToken = slice.htmlSignature;
        await panel.receive({
            type: 'conversation-viewer-history-chunk-applied',
            version: 1,
            subscriptionGeneration: slice.subscriptionGeneration,
            requestId: slice.requestId,
            htmlSignature: slice.htmlSignature,
        });
        if (slice.complete) {
            break;
        }
        slice = panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-history-chunk').at(-1);
    }
    const completion = lastPage();
    assert.ok(completion, 'the completion publication must exist');
    appliedToken = completion.htmlSignature;
    await ack(completion, []);

    // Switch away; the Webview stashes the converged frame under that token.
    await viewer.follow(target('small-b', smallIds[0]));
    await ack(lastPage(), [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'big-a',
        token: appliedToken,
    }]);

    // Return. The frame is the cheapest possible switch, so take it.
    const beforeReturn = panel.postedMessages.length;
    await viewer.follow(target('big-a', bigIds.at(-1)));
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    const returned = lastPage();
    assert.equal(returned.restoreFrame, true,
        'a reported frame for unchanged content must be restored');
    assert.equal(returned.html, undefined,
        'a frame restore must put no conversation HTML on the wire');
    assert.equal(returned.htmlSignature, appliedToken,
        'the restore must name the exact content the Webview still holds');
    assert.doesNotMatch(
        JSON.stringify(panel.postedMessages.slice(beforeReturn)),
        /Loading earlier messages/,
        'a restored frame must never reintroduce the deferred placeholder'
    );
    await ack(returned, [{
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'big-a',
        token: appliedToken,
    }]);
    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(
        panel.postedMessages.slice(beforeReturn).filter(message =>
            message.type === 'conversation-viewer-history-chunk'
        ).length,
        0,
        'a restored frame must not replay the backfill'
    );
    viewer.dispose();
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 never offers a frame the Webview stopped reporting', async () => {
    const ids = ['s-a', 's-b', 's-c', 's-d', 's-e', 's-f'];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: `${sessionId}-r1` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.sessionId}`,
            { sourceRevision: request.expectedRevision }
        ),
    });
    const frameEntry = (sessionId, token) => ({
        projectId: 'project-a',
        provider: 'codex',
        sessionId,
        token,
    });
    const lastPage = () => panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    const ack = (publication, frames) => panel.receive({
        type: 'conversation-viewer-applied',
        version: 1,
        subscriptionGeneration: publication.subscriptionGeneration,
        requestId: publication.requestId,
        htmlSignature: publication.htmlSignature,
        frames,
    });
    // Simulated Webview holding at most four frames, stashing the outgoing
    // session on every switch.
    const tokens = new Map();
    let stashed = [];
    const reportedInventory = () => stashed.slice(-4)
        .map(id => frameEntry(id, tokens.get(id)));

    await viewer.open(target('s-a', 'input-1'));
    const initial = decodeInitialPublication(panel.webview.html);
    tokens.set('s-a', initial.htmlSignature);
    await ack(initial, []);

    let previous = 's-a';
    for (const id of ids.slice(1)) {
        await viewer.follow(target(id, 'input-1'));
        const publication = lastPage();
        assert.equal(typeof publication.html, 'string',
            `${id} is a first visit and must carry full HTML`);
        tokens.set(id, publication.htmlSignature);
        stashed = [...stashed.filter(entry => entry !== previous), previous];
        await ack(publication, reportedInventory());
        previous = id;
    }
    // The reported inventory now holds s-b..s-e; s-a was evicted from the
    // Webview's four-frame cache.
    await viewer.follow(target('s-a', 'input-1'));
    let latest = lastPage();
    assert.equal(typeof latest.html, 'string',
        'an evicted frame must get full HTML, not a restoreFrame offer');
    assert.equal(latest.restoreFrame, undefined);
    tokens.set('s-a', latest.htmlSignature);
    stashed = [...stashed.filter(entry => entry !== 's-f'), 's-f'];
    await ack(latest, reportedInventory());

    await viewer.follow(target('s-b', 'input-1'));
    latest = lastPage();
    assert.equal(typeof latest.html, 'string');
    assert.equal(latest.restoreFrame, undefined);
    viewer.dispose();
});

test('CONVERSATION-THINKING-VISIBILITY-001 hides Thinking by default and republishes it only when enabled', async () => {
    let showThinking = false;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readPage: async request => {
            pageReads += 1;
            return {
                ...page(request.sessionId, request.anchorInteractionId),
                messages: [
                    {
                        id: 'input-1:thinking:0',
                        interactionId: 'input-1',
                        role: 'thinking',
                        markdown: '',
                        thinking: { text: 'private working notes' },
                    },
                    {
                        id: 'input-1:assistant:0',
                        interactionId: 'input-1',
                        role: 'assistant',
                        markdown: 'public answer',
                    },
                ],
            };
        },
        showThinking: () => showThinking,
    });

    await viewer.open(target('session-a', 'input-1'));
    let publication = decodeInitialPublication(panel.webview.html);
    assert.equal(publication.html.includes('private working notes'), false);
    assert.equal(publication.html.includes('public answer'), true);

    showThinking = true;
    await viewer.refreshPresentation();
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('private working notes'), true);
    assert.equal(publication.html.includes('public answer'), true);

    showThinking = false;
    await viewer.refreshPresentation();
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('private working notes'), false);
    assert.equal(publication.html.includes('public answer'), true);
    assert.equal(pageReads, 1, 'presentation changes must reuse retained data');
});

test('CONVERSATION-READING-FOCUS-001 ignores watched refreshes when the authoritative source revision is unchanged', async () => {
    let onChange;
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1'], { sourceRevision: 'stable-r1' });
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${pageReads}`,
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 1);
    assert.equal(panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').length, 0);
    assert.equal(panel.webview.html.includes('visible-1'), true);
});

test('CONVERSATION-WORKING-INDICATOR-001 republishes lifecycle state when content revision is unchanged', async () => {
    let onChange;
    let responseState = 'complete';
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            const value = outline(sessionId, ['input-1'], {
                sourceRevision: 'stable-r1',
            });
            value.interactions[0].responseState = responseState;
            return value;
        },
        readPage: async request => {
            pageReads += 1;
            return page(request.sessionId, request.anchorInteractionId, 'visible', {
                sourceRevision: request.expectedRevision,
            });
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    responseState = 'inProgress';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publications = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page');
    assert.equal(pageReads, 2,
        'lifecycle-only refresh reprojects response state and message roles');
    assert.equal(publications.length, 1);
    assert.equal(publications[0].outline[0].responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-LOADING-001 coalesces watched invalidations without starving the initial publication', async t => {
    let onChange;
    let outlineReads = 0;
    let initialSignal;
    const initialOutline = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId, signal) => {
            outlineReads += 1;
            if (outlineReads === 1) {
                initialSignal = signal;
                return initialOutline.promise;
            }
            return outline(sessionId, ['input-1'], {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.expectedRevision}`,
            { sourceRevision: request.expectedRevision }
        ),
    });
    t.after(() => viewer.dispose());

    const opening = viewer.open(target('session-a', 'input-1'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 1);

    onChange();
    onChange();
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    const initialWasAborted = initialSignal.aborted;
    const readsBeforeInitialSettled = outlineReads;

    initialOutline.resolve(outline('session-a', ['input-1'], {
        sourceRevision: 'r1',
    }));
    await opening;
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(initialWasAborted, false);
    assert.equal(readsBeforeInitialSettled, 1);
    assert.equal(outlineReads, 2);
    const publications = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page');
    assert.equal(panel.webview.html.includes('visible-r1'), true);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].updateKind, 'refresh');
    assert.equal(publications[0].html.includes('visible-r2'), true);
    assert.equal(panel.webview.html.includes('Loading conversation…'), false);
});

test('CONVERSATION-VIEWER-LOADING-001 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 keeps following newly appended running inputs across coalesced watcher refreshes', async t => {
    let onChange;
    let outlineReads = 0;
    const secondOutline = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            if (outlineReads === 1) {
                return outline(sessionId, ['input-1'], {
                    sourceRevision: 'r1',
                    responseStates: { 'input-1': 'inProgress' },
                });
            }
            if (outlineReads === 2) {
                return secondOutline.promise;
            }
            return outline(sessionId, ['input-1', 'input-2', 'input-3'], {
                sourceRevision: 'r3',
                responseStates: { 'input-3': 'inProgress' },
            });
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                responseStates: {
                    [request.anchorInteractionId]: 'inProgress',
                },
            }
        ),
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-a', 'input-1'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 2);
    onChange();
    secondOutline.resolve(outline('session-a', ['input-1', 'input-2'], {
        sourceRevision: 'r2',
        responseStates: { 'input-2': 'inProgress' },
    }));
    for (let turn = 0; turn < 4; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(outlineReads, 3);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-3');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.outline.at(-1).responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-LOADING-001 CONVERSATION-READING-FOCUS-001 keeps a historical selection made during coalesced watcher refreshes', async t => {
    let onChange;
    let outlineReads = 0;
    const secondOutline = deferred();
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            if (outlineReads === 1) {
                return outline(sessionId, ['input-1', 'input-2'], {
                    sourceRevision: 'r1',
                });
            }
            if (outlineReads === 2) {
                return secondOutline.promise;
            }
            return outline(
                sessionId,
                ['input-1', 'input-2', 'input-3', 'input-4'],
                { sourceRevision: 'r3' }
            );
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                interactionIds: request.anchorInteractionId === 'input-2'
                    ? ['input-1', 'input-2']
                    : [request.anchorInteractionId],
                anchorInteractionId: request.anchorInteractionId,
            }
        ),
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-a', 'input-2'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(outlineReads, 2);
    onChange();
    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    secondOutline.resolve(outline(
        'session-a',
        ['input-1', 'input-2', 'input-3'],
        { sourceRevision: 'r2' }
    ));
    for (let turn = 0; turn < 4; turn += 1) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(outlineReads, 3);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.atLatest, false);
});

test('CONVERSATION-VIEWER-AUTHORITY-003 suspends exact authority without clearing the snapshot and resumes with a fresh watch/read', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    let watchCreates = 0;
    const watchDisposals = [];
    const pendingOutline = deferred();
    let pendingSignal;
    const { viewer, panel } = createViewer({
        watch: (_provider, sessionId) => {
            watchCreates += 1;
            let active = true;
            return {
                dispose() {
                    if (!active) return;
                    active = false;
                    watchDisposals.push(sessionId);
                },
            };
        },
        readOutline: async (_provider, sessionId, signal) => {
            outlineReads += 1;
            if (outlineReads === 2) {
                pendingSignal = signal;
                return pendingOutline.promise;
            }
            return outline(sessionId, ['input-1', 'input-2']);
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${pageReads}`,
                {
                    sourceRevision: request.expectedRevision,
                    nextCursor: request.anchorInteractionId === 'input-1'
                        ? 'next-input'
                        : undefined,
                }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    const inFlightRefresh = viewer.refresh();
    await new Promise(resolve => setImmediate(resolve));
    let authorityCalls = 0;
    await viewer.reconcileAuthority(candidate => {
        authorityCalls += 1;
        assert.deepEqual(candidate, target('session-a', 'input-1'));
        return false;
    });

    assert.equal(authorityCalls, 1);
    assert.equal(pendingSignal.aborted, true);
    assert.equal(watchCreates, 1);
    assert.deepEqual(watchDisposals, ['session-a']);
    assert.equal(viewer.snapshotSize, 1);
    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, true);
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('visible-1'),
        true
    );

    const readsWhileSuspended = pageReads;
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    assert.equal(pageReads, readsWhileSuspended);
    pendingOutline.resolve(outline('session-a', ['input-1', 'input-2']));
    await inFlightRefresh;

    await viewer.reconcileAuthority(() => true);
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(watchCreates, 2);
    assert.equal(outlineReads, 3);
    assert.equal(pageReads, readsWhileSuspended + 1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-2'), true);
});

test('CONVERSATION-VIEWER-AUTHORITY-005 keeps a failed watch rebuild suspended and retries it on later authority', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    let watchCreates = 0;
    let liveInvalidation;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, onChange) => {
            watchCreates += 1;
            if (watchCreates === 2) {
                throw new Error([
                    '/private/watch/rebuild',
                    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                    'private prompt',
                ].join(' '));
            }
            liveInvalidation = onChange;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1', 'input-2']);
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                `visible-${pageReads}`,
                {
                    sourceRevision: request.expectedRevision,
                    nextCursor: 'next-input',
                }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.reconcileAuthority(() => false);
    const stalePublication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(stalePublication.stale, true);
    const readsBeforeFailedResume = {
        outline: outlineReads,
        page: pageReads,
    };

    await assert.doesNotReject(
        viewer.reconcileAuthority(() => true)
    );
    assert.equal(watchCreates, 2);
    assert.deepEqual({
        outline: outlineReads,
        page: pageReads,
    }, readsBeforeFailedResume);
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    assert.equal(pageReads, readsBeforeFailedResume.page);
    assert.equal(
        panel.postedMessages.filter(message =>
            message.type === 'conversation-viewer-page'
        ).at(-1).stale,
        true
    );

    await viewer.reconcileAuthority(() => true);
    let publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(watchCreates, 3);
    assert.equal(outlineReads, readsBeforeFailedResume.outline + 1);
    assert.equal(pageReads, readsBeforeFailedResume.page + 1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-2'), true);

    liveInvalidation();
    await new Promise(resolve => setImmediate(resolve));
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(outlineReads, readsBeforeFailedResume.outline + 2);
    assert.equal(pageReads, readsBeforeFailedResume.page + 1);
    assert.equal(publication.stale, false);
    assert.equal(publication.html.includes('visible-2'), true);
});

test('CONVERSATION-VIEWER-AUTHORITY-004 reconciliation after panel close is an idempotent no-op', async () => {
    const { viewer, panel } = createViewer();
    await viewer.open(target('session-a'));
    panel.dispose();
    let authorityCalls = 0;

    await viewer.reconcileAuthority(() => {
        authorityCalls += 1;
        return true;
    });
    await viewer.reconcileAuthority(() => {
        authorityCalls += 1;
        return false;
    });

    assert.equal(authorityCalls, 0);
    assert.equal(viewer.snapshotSize, 0);
});

test('CONVERSATION-VIEWER-AUTHORITY-001 fails closed when an initial marker no longer exists', async () => {
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-2'],
            { sourceRevision: 'r2' }
        ),
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'wrong-interaction',
                { sourceRevision: 'r2' }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));

    assert.equal(pageReads, 0);
    assert.equal(viewer.snapshotSize, 0);
    assert.equal(panel.webview.html.includes('Conversation history unavailable.'), true);
    assert.equal(panel.webview.html.includes('wrong-interaction'), false);
});

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 follows a newly appended running input when the previous selection was latest', async () => {
    let onChange;
    let outlineRead = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineRead += 1;
            return outline(
                sessionId,
                outlineRead === 1 ? ['input-1'] : ['input-1', 'input-2'],
                {
                    sourceRevision: outlineRead === 1 ? 'r1' : 'r2',
                    responseStates: outlineRead === 1
                        ? { 'input-1': 'inProgress' }
                        : { 'input-1': 'complete', 'input-2': 'inProgress' },
                }
            );
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                responseStates: {
                    [request.anchorInteractionId]: 'inProgress',
                },
            }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2');
    assert.equal(publication.selectedInput, 2);
    assert.equal(publication.totalInputs, 2);
    assert.equal(publication.atLatest, true);
    assert.equal(publication.outline.at(-1).responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 preserves a historical selection when a refresh adds a new last input', async () => {
    let onChange;
    let outlineRead = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            outlineRead += 1;
            return outline(
                sessionId,
                outlineRead === 1
                    ? ['input-1', 'input-2']
                    : ['input-1', 'input-2', 'input-3'],
                { sourceRevision: outlineRead === 1 ? 'r1' : 'r2' }
            );
        },
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            { sourceRevision: request.expectedRevision }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.selectedInput, 1);
    assert.equal(publication.totalInputs, 3);
    assert.equal(publication.atLatest, false);
});

test('CONVERSATION-VIEWER-REFRESH-002 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 follows a new running input when authority reconciliation arrives before the provider watch', async () => {
    let revision = 1;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            revision === 1 ? ['input-1'] : ['input-1', 'input-2'],
            {
                sourceRevision: `r${revision}`,
                responseStates: revision === 1
                    ? { 'input-1': 'inProgress' }
                    : { 'input-1': 'complete', 'input-2': 'inProgress' },
            }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-${request.anchorInteractionId}`,
            {
                sourceRevision: request.expectedRevision,
                responseStates: {
                    [request.anchorInteractionId]: 'inProgress',
                },
            }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    revision = 2;
    await viewer.reconcileAuthority(() => true);

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.outline.at(-1).responseState, 'inProgress');
});

test('CONVERSATION-VIEWER-DELIVERY-001 retains hidden Webview context without rebuilding it on visibility changes', async () => {
    let onChange;
    let revision = 1;
    const panel = fakePanel({
        postMessageResult: (_message, currentPanel) => currentPanel.visible,
    });
    const { viewer } = createViewer({
        panel,
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            revision === 1 ? ['input-1'] : ['input-1', 'input-2'],
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            `visible-r${revision}`,
            { sourceRevision: request.expectedRevision }
        ),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(panel.viewStateListenerCount, 1);
    assert.equal(panel.createArguments[3].retainContextWhenHidden, true);
    await panel.setVisible(false);
    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(panel.webview.html.includes('visible-r2'), true);
    const retainedDocument = panel.webview.html;
    await panel.setVisible(true);

    assert.equal(panel.webview.html, retainedDocument);

    panel.dispose();
    assert.equal(panel.viewStateListenerCount, 0);
});

test('CONVERSATION-VIEWER-STALE-001 retries an initial stale revision once against a fresh outline', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1'], {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => {
            pageReads += 1;
            requests.push(request);
            if (pageReads === 1) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'visible-current',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 2);
    assert.deepEqual(requests.map(request => ({
        anchorInteractionId: request.anchorInteractionId,
        direction: request.direction,
        expectedRevision: request.expectedRevision,
        cursor: request.cursor,
    })), [
        {
            anchorInteractionId: 'input-1',
            direction: 'around',
            expectedRevision: 'r1',
            cursor: undefined,
        },
        {
            anchorInteractionId: 'input-1',
            direction: 'around',
            expectedRevision: 'r2',
            cursor: undefined,
        },
    ]);
    assert.equal(panel.webview.html.includes('visible-current'), true);
});

test('CONVERSATION-VIEWER-STALE-004 fails an initial stale retry closed when the exact interaction disappears', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(
                sessionId,
                [outlineReads === 1 ? 'input-1' : 'input-2'],
                { sourceRevision: `r${outlineReads}` }
            );
        },
        readPage: async request => {
            pageReads += 1;
            if (pageReads === 1) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'must-not-publish-input-2',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 1);
    assert.equal(viewer.snapshotSize, 0);
    assert.equal(
        panel.webview.html.includes('Conversation history unavailable.'),
        true
    );
    assert.equal(panel.webview.html.includes('must-not-publish-input-2'), false);
});

test('CONVERSATION-VIEWER-STALE-004 fails a follow-latest refresh retry closed when the prior latest interaction disappears', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            const interactionIds = outlineReads === 1
                ? ['input-1']
                : outlineReads === 2
                    ? ['input-1', 'input-2']
                    : ['input-2', 'input-3'];
            return outline(sessionId, interactionIds, {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => {
            pageReads += 1;
            requests.push(request);
            if (pageReads === 2) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                pageReads === 1 ? 'visible-established' : 'must-not-follow',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.refresh();

    assert.equal(outlineReads, 3);
    assert.equal(pageReads, 2);
    assert.deepEqual(
        requests.map(request => request.anchorInteractionId),
        ['input-1', 'input-2']
    );
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.stale, true);
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('visible-established'),
        true
    );
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('must-not-follow'),
        false
    );
});

test('CONVERSATION-VIEWER-STALE-002 recovers expired navigation cursors through one fresh authoritative around read', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const requests = [];
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(
                sessionId,
                outlineReads === 1
                    ? ['input-1', 'input-2']
                    : ['input-1', 'input-2', 'input-3'],
                { sourceRevision: `r${outlineReads}` }
            );
        },
        readPage: async request => {
            pageReads += 1;
            requests.push(request);
            if (pageReads === 1) {
                return page('session-a', 'input-1', 'visible-initial', {
                    nextCursor: 'expired-cursor',
                });
            }
            if (pageReads === 2) {
                throw new ConversationError('staleRevision');
            }
            return page(
                request.sessionId,
                request.anchorInteractionId,
                'visible-retried',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 3);
    assert.deepEqual({
        anchorInteractionId: requests[2].anchorInteractionId,
        direction: requests[2].direction,
        expectedRevision: requests[2].expectedRevision,
        cursor: requests[2].cursor,
    }, {
        anchorInteractionId: 'input-2',
        direction: 'around',
        expectedRevision: 'r2',
        cursor: undefined,
    });
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2');
    assert.equal(publication.html.includes('visible-retried'), true);
});

test('CONVERSATION-VIEWER-STALE-003 bounds persistent stale revision recovery to one retry and retains stale content', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(sessionId, ['input-1', 'input-2'], {
                sourceRevision: `r${outlineReads}`,
            });
        },
        readPage: async request => {
            pageReads += 1;
            if (pageReads === 1) {
                return page('session-a', 'input-1', 'visible-retained', {
                    nextCursor: 'expired-cursor',
                });
            }
            throw new ConversationError('staleRevision');
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await panel.receive({ type: 'conversation-viewer-next', version: 1 });

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 3);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.stale, true);
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('visible-retained'),
        true
    );
});

test('CONVERSATION-VIEWER-AUTHORITY-002 retains stale content when the established exact selection disappears', async () => {
    let outlineReads = 0;
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => {
            outlineReads += 1;
            return outline(
                sessionId,
                [outlineReads === 1 ? 'input-1' : 'input-2'],
                { sourceRevision: `r${outlineReads}` }
            );
        },
        readPage: async request => {
            pageReads += 1;
            return page(
                request.sessionId,
                request.anchorInteractionId,
                pageReads === 1
                    ? 'visible-established'
                    : 'must-not-replace-established',
                { sourceRevision: request.expectedRevision }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    await viewer.refresh();

    assert.equal(outlineReads, 2);
    assert.equal(pageReads, 1);
    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.stale, true);
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('visible-established'),
        true
    );
    assert.equal(
        decodeInitialPublication(panel.webview.html).html.includes('must-not-replace-established'),
        false
    );
});

test('CONVERSATION-VIEWER-REFRESH-003 CONVERSATION-READING-FOCUS-001 CONVERSATION-WORKING-INDICATOR-001 merges a new tail page and advances from the prior latest interaction', async () => {
    let onChange;
    let revision = 1;
    const firstIds = Array.from(
        { length: 20 },
        (_item, index) => `input-${index + 1}`
    );
    const secondIds = Array.from(
        { length: 20 },
        (_item, index) => `input-${index + 2}`
    );
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            revision === 1 ? firstIds : firstIds.concat('input-21'),
            { sourceRevision: `r${revision}` }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            revision === 1 ? 'initial' : 'refreshed',
            {
                interactionIds: revision === 1 ? firstIds : secondIds,
                anchorInteractionId: request.anchorInteractionId,
                sourceRevision: request.expectedRevision,
                previousCursor: revision === 1 ? undefined : 'r2-before',
            }
        ),
    });

    await viewer.open(target('session-a', 'input-20'));
    revision = 2;
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-21');
    assert.equal(publication.atLatest, true);
    assert.equal(publication.html.includes('data-interaction-id="input-1"'), true);
    assert.equal(publication.html.includes('data-interaction-id="input-21"'), true);
    assert.equal(
        publication.html.match(/data-interaction-id="input-2"/g).length,
        1
    );
    assert.equal(viewer.snapshotSize, 21);
});

test('CONVERSATION-VIEWER-PARTIAL-001 offsets capped-tail positions by omitted authoritative interactions', async () => {
    const interactionIds = Array.from(
        { length: 2_000 },
        (_item, index) => `input-${index + 2}`
    );
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            interactionIds,
            { totalInteractions: 2_001, partial: true }
        ),
        readPage: async request => page(
            request.sessionId,
            request.anchorInteractionId,
            'visible-tail',
            {
                interactionIds: ['input-2000', 'input-2001'],
                anchorInteractionId: request.anchorInteractionId,
            }
        ),
    });

    await viewer.open(target('session-a', 'input-2001'));
    const initialPublicationMatch =
        panel.webview.html.match(/data-initial-page="([^"]+)"/);
    assert.ok(initialPublicationMatch, panel.webview.html);
    let publication = JSON.parse(
        initialPublicationMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/&amp;/g, '&')
    );
    assert.equal(publication.selectedInput, 2_001);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);

    await panel.receive({ type: 'conversation-viewer-previous', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2000');
    assert.equal(publication.selectedInput, 2_000);

    await panel.receive({ type: 'conversation-viewer-next', version: 1 });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, 'input-2001');
    assert.equal(publication.selectedInput, 2_001);
    assert.equal(publication.totalInputs, 2_000);
});

test('CONVERSATION-VIEWER-PARTIAL-001 derives first and latest capped positions from a real Kimi adapter', async t => {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-real-kimi-viewer-cap-')
    );
    const sourcePath = path.join(providerHome, 'wire.jsonl');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const records = [];
    for (let number = 1; number <= 2_101; number += 1) {
        records.push(JSON.stringify({
            timestamp: number,
            message: {
                type: 'TurnBegin',
                payload: { user_input: `Viewer cap input ${number}` },
            },
        }));
        records.push(JSON.stringify({
            timestamp: number,
            message: { type: 'TurnEnd', payload: {} },
        }));
    }
    await fs.promises.writeFile(sourcePath, `${records.join('\n')}\n`);
    t.after(() => fs.promises.rm(providerHome, {
        recursive: true,
        force: true,
    }));
    const adapter = new KimiConversationAdapter({
        resolveSource: () => ({ providerHome, sourcePath }),
        watchSessionChanges: () => ({ dispose() {} }),
        now: Date.now,
        setTimeout(callback) {
            callback();
            return 1;
        },
        clearTimeout() {},
    });
    t.after(() => adapter.dispose());
    const capped = await adapter.readOutline(sessionId);
    const { viewer, panel } = createViewer({
        readOutline: (_provider, id, signal) =>
            adapter.readOutline(id, signal),
        readPage: (request, signal) =>
            adapter.readPage(request, signal),
        watch: (_provider, id, callback) =>
            adapter.watch(id, callback),
    });

    await viewer.open(target(
        sessionId,
        capped.interactions[0].id,
        {
            provider: 'kimi',
            expectedRevision: capped.sourceRevision,
        }
    ));
    const realInitialPublicationMatch =
        panel.webview.html.match(/data-initial-page="([^"]+)"/);
    assert.ok(
        realInitialPublicationMatch,
        panel.webview.html
    );
    let publication = JSON.parse(
        realInitialPublicationMatch[1]
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&gt;/g, '>')
            .replace(/&lt;/g, '<')
            .replace(/&amp;/g, '&')
    );
    assert.equal(publication.selectedInput, 102);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);
    assert.equal(publication.html.includes('Viewer cap input 102'), true);

    await panel.receive({
        type: 'conversation-viewer-latest',
        version: 1,
    });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInput, 2_101);
    assert.equal(publication.totalInputs, 2_000);
    assert.equal(publication.partial, true);
    assert.equal(
        publication.html.includes('Viewer cap input 2101'),
        true
    );

    await panel.receive({
        type: 'conversation-viewer-first',
        version: 1,
    });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInteractionId, capped.firstInteractionId);
    assert.equal(publication.selectedInput, 1);
    assert.equal(publication.html.includes('Viewer cap input 1'), true);

    await panel.receive({
        type: 'conversation-viewer-next',
        version: 1,
    });
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInput, 2);
    assert.equal(publication.html.includes('Viewer cap input 2'), true);

    for (let input = 3; input <= 21; input += 1) {
        await panel.receive({
            type: 'conversation-viewer-next',
            version: 1,
        });
    }
    publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.selectedInput, 21);
    assert.equal(publication.html.includes('Viewer cap input 21'), true);
});

test('CONVERSATION-TOOL-CALL-VISIBILITY-001 publishes collapsible tool-call markup', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => ({
            ...page(request.sessionId, 'input-1', 'visible'),
            messages: [
                {
                    id: 'input-1:user',
                    interactionId: 'input-1',
                    role: 'user',
                    markdown: 'Run the tests',
                },
                {
                    id: 'input-1:tool:0',
                    interactionId: 'input-1',
                    role: 'tool',
                    markdown: '',
                    tool: {
                        name: 'Shell',
                        summary: 'Shell npm test',
                        detail: '9 passing',
                    },
                },
                {
                    id: 'input-1:assistant:0',
                    interactionId: 'input-1',
                    role: 'assistant',
                    markdown: 'All pass.',
                },
            ],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-tool-call'), true);
    assert.equal(html.includes('Shell npm test'), true);
    assert.equal(html.includes('9 passing'), true);
    assert.equal(html.includes('conversation-message-tool'), true);
});

test('CONVERSATION-PLAN-QUESTION-VISIBILITY-001 publishes plan and question markup with the settled answers', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => ({
            ...page(request.sessionId, 'input-1', 'visible'),
            messages: [
                {
                    id: 'input-1:user',
                    interactionId: 'input-1',
                    role: 'user',
                    markdown: 'Refactor the parser',
                },
                {
                    id: 'input-1:plan:0',
                    interactionId: 'input-1',
                    role: 'plan',
                    markdown: '',
                    plan: {
                        markdown: '# Rollout Plan\n\n1. step',
                        filePath: '/home/user/.kimi/plans/rollout.md',
                    },
                },
                {
                    id: 'input-1:question:0',
                    interactionId: 'input-1',
                    role: 'question',
                    markdown: '',
                    question: {
                        source: 'ExitPlanMode',
                        questions: [{
                            question: 'Approve this plan',
                            header: 'Plan',
                            options: [
                                { label: 'Full refactor', description: 'All at once' },
                                { label: 'Reject' },
                            ],
                            multiSelect: false,
                            otherLabel: 'Revise',
                            answers: ['Full refactor'],
                        }],
                        outcome: 'approved',
                    },
                },
                {
                    id: 'input-1:assistant:0',
                    interactionId: 'input-1',
                    role: 'assistant',
                    markdown: 'On it.',
                },
            ],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-message-plan'), true);
    assert.equal(html.includes('conversation-plan-label'), true);
    assert.equal(html.includes('Rollout Plan'), true);
    assert.equal(html.includes('rollout.md'), true);
    assert.equal(html.includes('conversation-message-question'), true);
    assert.equal(html.includes('Plan approval'), true);
    assert.equal(html.includes('Approve this plan'), true);
    assert.equal(html.includes('Full refactor'), true);
    assert.equal(
        html.includes('conversation-question-option-selected'),
        true
    );
    assert.equal(html.includes('Approved'), true);
});

test('CONVERSATION-DIFF-VISIBILITY-001 publishes structured diff markup inside the tool entry', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => ({
            ...page(request.sessionId, 'input-1', 'visible'),
            messages: [
                {
                    id: 'input-1:user',
                    interactionId: 'input-1',
                    role: 'user',
                    markdown: 'Apply the patch',
                },
                {
                    id: 'input-1:tool:0',
                    interactionId: 'input-1',
                    role: 'tool',
                    markdown: '',
                    tool: {
                        name: 'fileChange',
                        summary: 'fileChange update src/a.ts',
                        diffs: [{
                            path: 'src/a.ts',
                            kind: 'update',
                            additions: 1,
                            deletions: 1,
                            hunks: [{
                                oldStart: 3,
                                newStart: 3,
                                lines: [
                                    { type: 'del', text: 'const a = 1;' },
                                    { type: 'add', text: 'const a = 2;' },
                                ],
                            }],
                        }],
                    },
                },
                {
                    id: 'input-1:assistant:0',
                    interactionId: 'input-1',
                    role: 'assistant',
                    markdown: 'Done.',
                },
            ],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-diff-file'), true);
    assert.equal(html.includes('src/a.ts'), true);
    assert.equal(html.includes('conversation-diff-line-add'), true);
    assert.equal(html.includes('conversation-diff-line-del'), true);
    assert.equal(html.includes('conversation-diff-totals'), true);
    assert.equal(html.includes('@@ -3 +3 @@'), true);
    assert.equal(
        html.includes('</span>\n<span class="conversation-diff-line'),
        false,
        'block diff lines must not be separated by newline text nodes'
    );
});

function worklogPage(sessionId, options = {}) {
    const state = {
        interactionId: 'input-1',
        responseState: options.responseState || 'complete',
        ...(options.timestamp !== undefined
            ? { timestamp: options.timestamp } : {}),
        ...(options.completedAt !== undefined
            ? { completedAt: options.completedAt } : {}),
    };
    const messages = [{
        id: 'input-1:user',
        interactionId: 'input-1',
        role: 'user',
        markdown: 'Run the tests',
    }];
    if (options.withWork !== false) {
        messages.push({
            id: 'input-1:tool:0',
            interactionId: 'input-1',
            role: 'tool',
            markdown: '',
            tool: { name: 'Shell', summary: 'Shell npm test', detail: '9 passing' },
        });
    }
    if (options.withAnswer !== false) {
        messages.push({
            id: 'input-1:assistant:0',
            interactionId: 'input-1',
            role: 'assistant',
            markdown: 'All pass.',
        });
    }
    return {
        ...page(sessionId, 'input-1', 'visible'),
        messages,
        interactionStates: [state],
    };
}

function lifecycleProjectionPage(
    sessionId,
    sourceRevision,
    anchorInteractionId,
    latestState,
    options = {}
) {
    const messages = [];
    const interactionStates = [];
    if (options.includeEarlier !== false) {
        messages.push({
            id: 'input-1:user',
            interactionId: 'input-1',
            role: 'user',
            markdown: 'Read the earlier turn',
        });
        interactionStates.push({
            interactionId: 'input-1',
            responseState: 'complete',
        });
    }
    if (options.includeLatest !== false) {
        messages.push(
            {
                id: 'input-2:user',
                interactionId: 'input-2',
                role: 'user',
                markdown: 'Run the tests',
            },
            {
                id: 'input-2:tool:0',
                interactionId: 'input-2',
                role: 'tool',
                markdown: '',
                tool: { name: 'Shell', summary: 'Shell npm test' },
            },
            {
                id: `input-2:${latestState === 'inProgress'
                    ? 'progress'
                    : 'assistant'}:0`,
                interactionId: 'input-2',
                role: latestState === 'inProgress'
                    ? 'progress'
                    : 'assistant',
                markdown: latestState === 'inProgress'
                    ? 'Still running.'
                    : 'All pass.',
            }
        );
        interactionStates.push({
            interactionId: 'input-2',
            responseState: latestState,
            timestamp: 1_000,
            completedAt: 81_000,
        });
    }
    return {
        provider: 'codex',
        sessionId,
        sourceRevision,
        anchorInteractionId,
        messages,
        interactionStates,
        isStart: true,
        isEnd: true,
    };
}

test('CONVERSATION-WORKLOG-COLLAPSE-001 publishes a completed action group between work entries and the answer', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId, {
            timestamp: 1_000,
            completedAt: 81_000,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-message-worklog'), true);
    assert.equal(html.includes('Worked for 1m 20s'), true);
    const userIndex = html.indexOf('conversation-message-user');
    const worklogIndex = html.indexOf('conversation-message-worklog');
    const toolIndex = html.indexOf('conversation-message-tool');
    const answerIndex = html.indexOf('All pass.');
    assert.ok(userIndex >= 0 && worklogIndex > userIndex
        && toolIndex > worklogIndex && answerIndex > toolIndex,
        'worklog row heads the work group so expanding never moves the toggle:'
            + ` ${userIndex}/${worklogIndex}/${toolIndex}/${answerIndex}`);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 splits completed work at progress boundaries with stable action identities', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => ({
            ...page(request.sessionId, 'input-1', 'visible'),
            messages: [
                {
                    id: 'input-1:user', interactionId: 'input-1',
                    role: 'user', markdown: 'Inspect and verify the viewer',
                },
                {
                    id: 'input-1:progress:0', interactionId: 'input-1',
                    role: 'progress', markdown: 'Inspect the renderer',
                },
                {
                    id: 'input-1:tool:0', interactionId: 'input-1',
                    role: 'tool', markdown: '',
                    tool: { name: 'ReadFile', summary: 'Read viewer.ts' },
                },
                {
                    id: 'input-1:progress:1', interactionId: 'input-1',
                    role: 'progress', markdown: 'Run focused checks',
                },
                {
                    id: 'input-1:tool:1', interactionId: 'input-1',
                    role: 'tool', markdown: '',
                    tool: { name: 'Shell', summary: 'Run tests' },
                },
                {
                    id: 'input-1:assistant:0', interactionId: 'input-1',
                    role: 'assistant', markdown: 'Checks passed.',
                },
            ],
            interactionStates: [{
                interactionId: 'input-1', responseState: 'complete',
                timestamp: 1_000, completedAt: 81_000,
            }],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = decodeInitialPublication(panel.webview.html).html;
    assert.equal(
        (html.match(/conversation-message-worklog/g) || []).length,
        2,
        'each progress boundary starts a separately disclosed action group'
    );
    assert.match(html,
        /Worked for 1m 20s · Inspect the renderer/);
    assert.match(html, /Run focused checks/);
    assert.match(html,
        /data-worklog-id="input-1:worklog:input-1:progress:0"/);
    assert.match(html,
        /data-worklog-id="input-1:worklog:input-1:progress:1"/);
    assert.ok(
        html.indexOf('Inspect the renderer')
            < html.indexOf('Read viewer.ts')
            && html.indexOf('Run focused checks')
                < html.indexOf('Run tests')
            && html.indexOf('Checks passed.') > html.indexOf('Run tests'),
        'each action header precedes only its own work while the answer stays visible'
    );
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 renders Codex app-server duration in the Worked-for row', async t => {
    const adapter = new CodexConversationAdapter({
        client: {
            async request() {
                return timedCodexFixture;
            },
            dispose() {},
        },
        watchSessionChanges: () => ({ dispose() {} }),
        setTimeout: callback => {
            callback();
            return 1;
        },
        clearTimeout() {},
    });
    t.after(() => adapter.dispose());
    const { viewer, panel } = createViewer({
        readOutline: (_provider, sessionId) => adapter.readOutline(sessionId),
        readSnapshot: (_provider, sessionId, preferredInteractionId) =>
            adapter.readSnapshot(sessionId, preferredInteractionId),
        readPage: request => adapter.readPage(request),
    });

    await viewer.open(target(
        timedCodexFixture.thread.id,
        'user-timed',
        { expectedRevision: undefined }
    ));

    assert.equal(panel.webview.html.includes('Worked for 1m 16s'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 renders the sum of Codex subagent turn durations', async t => {
    const rootId = '33333333-3333-4333-8333-333333333333';
    const childId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const timedTurns = [
        {
            id: 'turn-subagent-1',
            status: 'completed',
            startedAt: 1_700_000_010,
            durationMs: 10_000,
            items: [
                { id: 'progress-subagent-1', type: 'agentMessage', text: 'First progress', phase: 'commentary' },
            ],
        },
        {
            id: 'turn-subagent-2',
            status: 'completed',
            startedAt: 1_700_000_100,
            durationMs: 20_000,
            items: [
                { id: 'answer-subagent-2', type: 'agentMessage', text: 'Finished' },
            ],
        },
    ];
    const childFixture = turns => ({
        thread: {
            id: childId,
            parentThreadId: rootId,
            agentNickname: 'Zeno',
            createdAt: 1_700_000_000,
            turns,
        },
    });
    const render = async result => {
        const adapter = new CodexConversationAdapter({
            client: {
                async request() {
                    return result;
                },
                dispose() {},
            },
            watchSessionChanges: () => ({ dispose() {} }),
            setTimeout: callback => {
                callback();
                return 1;
            },
            clearTimeout() {},
        });
        t.after(() => adapter.dispose());
        const { viewer, panel } = createViewer({
            readOutline: (_provider, sessionId) =>
                adapter.readOutline(sessionId),
            readSnapshot: (_provider, sessionId, preferredInteractionId) =>
                adapter.readSnapshot(sessionId, preferredInteractionId),
            readPage: request => adapter.readPage(request),
        });
        await viewer.open(target(rootId, `${childId}-dispatch`, {
            expectedRevision: undefined,
            subagent: { id: childId, label: 'Zeno' },
        }));
        return decodeInitialPublication(panel.webview.html).html;
    };

    const timedHtml = await render(childFixture(timedTurns));
    assert.equal(timedHtml.includes('Worked for 30s'), true);

    const untimedHtml = await render(childFixture([{
        id: 'turn-subagent-untimed',
        status: 'completed',
        items: [{
            id: 'progress-subagent-untimed',
            type: 'agentMessage',
            text: 'Untimed progress',
            phase: 'commentary',
        }],
    }, timedTurns[1]]));
    assert.equal(untimedHtml.includes('Worked for 20s'), false);
    assert.equal(untimedHtml.includes('Untimed progress'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 omits the row while in progress and falls back without timing', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId, {
            responseState: 'inProgress',
            timestamp: 1_000,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(
        panel.webview.html.includes('conversation-message-worklog'),
        false,
        'in-progress turns keep their work expanded without a row'
    );

    const { viewer: fallbackViewer, panel: fallbackPanel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId),
    });
    await fallbackViewer.open(target('session-b', 'input-1'));
    const html = fallbackPanel.webview.html;
    assert.equal(html.includes('conversation-message-worklog'), true);
    assert.equal(html.includes('&gt;Ran Shell · 1 tool&lt;/span'), true,
        'tool-only work identifies the action without inventing a progress summary');
    assert.equal(html.includes('Worked for'), false);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 collapses on a lifecycle-only completion refresh', async () => {
    let onChange;
    let responseState = 'inProgress';
    let pageReads = 0;
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            const value = outline(sessionId, ['input-1'], {
                sourceRevision: 'stable-r1',
            });
            value.interactions[0].responseState = responseState;
            return value;
        },
        readPage: async request => {
            pageReads += 1;
            const value = worklogPage(request.sessionId, {
                responseState,
                timestamp: 1_000,
                completedAt: 81_000,
            });
            if (responseState === 'inProgress') {
                value.messages = value.messages.map(message => ({
                    ...message,
                    role: message.role === 'assistant'
                        ? 'progress'
                        : message.role,
                }));
            }
            return {
                ...value,
                sourceRevision: request.expectedRevision,
            };
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    responseState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.outline[0].responseState, 'complete');
    assert.equal(pageReads, 2,
        'completion must reproject progress back to the final answer');
    assert.equal(
        publication.html.includes('conversation-message-worklog'),
        true,
        'the same lifecycle refresh must collapse retained work'
    );
    assert.equal(publication.html.includes('Worked for 1m 20s'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 reprojects the changed turn without moving a historical selection', async () => {
    let onChange;
    let latestState = 'inProgress';
    const pageAnchors = [];
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => {
            const value = outline(sessionId, ['input-1', 'input-2'], {
                sourceRevision: 'stable-r1',
            });
            value.interactions[1].responseState = latestState;
            return value;
        },
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            return {
                provider: 'codex',
                sessionId: request.sessionId,
                sourceRevision: request.expectedRevision,
                anchorInteractionId: request.anchorInteractionId,
                messages: [
                    {
                        id: 'input-1:user',
                        interactionId: 'input-1',
                        role: 'user',
                        markdown: 'Read the earlier turn',
                    },
                    {
                        id: 'input-2:user',
                        interactionId: 'input-2',
                        role: 'user',
                        markdown: 'Run the tests',
                    },
                    {
                        id: 'input-2:tool:0',
                        interactionId: 'input-2',
                        role: 'tool',
                        markdown: '',
                        tool: { name: 'Shell', summary: 'Shell npm test' },
                    },
                    {
                        id: `input-2:${latestState === 'inProgress'
                            ? 'progress'
                            : 'assistant'}:0`,
                        interactionId: 'input-2',
                        role: latestState === 'inProgress'
                            ? 'progress'
                            : 'assistant',
                        markdown: latestState === 'inProgress'
                            ? 'Still running.'
                            : 'All pass.',
                    },
                ],
                interactionStates: [
                    {
                        interactionId: 'input-1',
                        responseState: 'complete',
                    },
                    {
                        interactionId: 'input-2',
                        responseState: latestState,
                        timestamp: 1_000,
                        completedAt: 81_000,
                    },
                ],
                isStart: true,
                isEnd: true,
            };
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    latestState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-1', 'input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('conversation-message-worklog'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 bypasses a snapshot page that misses the changed turn', async () => {
    let onChange;
    let latestState = 'inProgress';
    let snapshotReads = 0;
    const pageAnchors = [];
    const currentOutline = sessionId => {
        const value = outline(sessionId, ['input-1', 'input-2'], {
            sourceRevision: 'stable-r1',
        });
        value.interactions[1].responseState = latestState;
        return value;
    };
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readSnapshot: async (_provider, sessionId, preferredInteractionId) => {
            snapshotReads += 1;
            return {
                outline: currentOutline(sessionId),
                page: lifecycleProjectionPage(
                    sessionId,
                    'stable-r1',
                    preferredInteractionId || 'input-1',
                    latestState,
                    { includeLatest: snapshotReads === 1 }
                ),
            };
        },
        readOutline: async (_provider, sessionId) => currentOutline(sessionId),
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            return lifecycleProjectionPage(
                request.sessionId,
                request.expectedRevision,
                request.anchorInteractionId,
                latestState,
                { includeEarlier: false }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'stable-r1',
    }));
    latestState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('conversation-message-worklog'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 merges a historical snapshot and the completed turn across revisions', async () => {
    let onChange;
    let latestState = 'inProgress';
    let revision = 'r1';
    let snapshotReads = 0;
    const pageAnchors = [];
    const currentOutline = sessionId => {
        const value = outline(sessionId, ['input-1', 'input-2'], {
            sourceRevision: revision,
        });
        value.interactions[1].responseState = latestState;
        return value;
    };
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readSnapshot: async (_provider, sessionId, preferredInteractionId) => {
            snapshotReads += 1;
            const snapshotPage = lifecycleProjectionPage(
                sessionId,
                revision,
                preferredInteractionId || 'input-1',
                latestState,
                { includeLatest: snapshotReads === 1 }
            );
            if (snapshotReads > 1) {
                snapshotPage.messages[0].markdown = 'Updated earlier turn';
            }
            return {
                outline: currentOutline(sessionId),
                page: snapshotPage,
            };
        },
        readOutline: async (_provider, sessionId) => currentOutline(sessionId),
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            return lifecycleProjectionPage(
                request.sessionId,
                request.expectedRevision,
                request.anchorInteractionId,
                latestState,
                { includeEarlier: false }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1', {
        expectedRevision: 'r1',
    }));
    latestState = 'complete';
    revision = 'r2';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('Updated earlier turn'), true,
        'the selected historical page must retain its content refresh');
    assert.equal(publication.html.includes('conversation-message-worklog'), true,
        'the retained completed turn must receive its final projection');
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 retries a stale changed-turn projection without falling back to history', async () => {
    let onChange;
    let latestState = 'inProgress';
    let revision = 'r1';
    const pageAnchors = [];
    const currentOutline = sessionId => {
        const value = outline(sessionId, ['input-1', 'input-2'], {
            sourceRevision: revision,
        });
        value.interactions[1].responseState = latestState;
        return value;
    };
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => currentOutline(sessionId),
        readPage: async request => {
            pageAnchors.push(request.anchorInteractionId);
            if (request.anchorInteractionId === 'input-2'
                && request.expectedRevision === 'r1') {
                revision = 'r2';
                throw new ConversationError('staleRevision');
            }
            return lifecycleProjectionPage(
                request.sessionId,
                request.expectedRevision,
                request.anchorInteractionId,
                latestState,
                request.anchorInteractionId === 'input-2'
                    ? { includeEarlier: false }
                    : { includeLatest: pageAnchors.length === 1 }
            );
        },
    });

    await viewer.open(target('session-a', 'input-1'));
    latestState = 'complete';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.deepEqual(pageAnchors, ['input-1', 'input-2', 'input-2']);
    assert.equal(publication.selectedInteractionId, 'input-1');
    assert.equal(publication.html.includes('conversation-message-worklog'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 keeps timing after a content refresh merge', async () => {
    let onChange;
    let revision = 'r1';
    const { viewer, panel } = createViewer({
        watch: (_provider, _sessionId, callback) => {
            onChange = callback;
            return { dispose() {} };
        },
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1'],
            { sourceRevision: revision }
        ),
        readPage: async request => ({
            ...worklogPage(request.sessionId, {
                timestamp: 1_000,
                completedAt: 81_000,
            }),
            sourceRevision: request.expectedRevision,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    revision = 'r2';
    onChange();
    await new Promise(resolve => setImmediate(resolve));

    const publication = panel.postedMessages.filter(message =>
        message.type === 'conversation-viewer-page').at(-1);
    assert.equal(publication.html.includes('Worked for 1m 20s'), true);
});

test('CONVERSATION-WORKLOG-COLLAPSE-001 falls back safely when finite timestamps overflow', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId, {
            timestamp: -1e308,
            completedAt: 1e308,
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('&gt;Ran Shell · 1 tool&lt;/span'), true);
    assert.equal(html.includes('Infinity'), false);
    assert.equal(html.includes('NaN'), false);
});

test('CONVERSATION-MESSAGE-BOOKMARK-001 renders a bookmark toggle inside each user input card only', async () => {
    const { viewer, panel } = createViewer({
        readOutline: async (_provider, sessionId) => outline(
            sessionId,
            ['input-1']
        ),
        readPage: async request => worklogPage(request.sessionId),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    const userIndex = html.indexOf('conversation-message-user');
    const bookmarkIndex = html.indexOf('conversation-message-bookmark');
    const markdownIndex = html.indexOf('Run the tests');
    assert.ok(userIndex >= 0 && bookmarkIndex > userIndex
        && bookmarkIndex < markdownIndex,
        'the bookmark toggle lives inside the user input card:'
            + ` ${userIndex}/${bookmarkIndex}/${markdownIndex}`);
    assert.equal(html.includes('Bookmark this input'), true);
    assert.equal(
        html.indexOf('conversation-message-bookmark', bookmarkIndex + 1),
        -1,
        'work entries and the answer carry no bookmark toggle'
    );
});

function copyPage(sessionId) {
    return {
        ...page(sessionId, 'input-1', 'visible'),
        messages: [{
            id: 'input-1:user',
            interactionId: 'input-1',
            role: 'user',
            markdown: 'Add tests for the parser',
        }, {
            id: 'input-1:assistant:0',
            interactionId: 'input-1',
            role: 'assistant',
            markdown: 'Like this:\n\n```ts\nconst answer = 42;\n```',
        }],
        interactionStates: [{
            interactionId: 'input-1',
            responseState: 'complete',
        }],
    };
}

function copyRequest(requestId, payload, overrides = {}) {
    return {
        type: 'conversation-viewer-copy',
        version: 1,
        requestId,
        subscriptionGeneration: 1,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-a',
        operation: 'copy',
        payload,
        ...overrides,
    };
}

test('CONVERSATION-COPY-ACTIONS-001 renders code block chrome and message copy controls', async () => {
    const { viewer, panel } = createViewer({
        readPage: async request => copyPage(request.sessionId),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.equal(html.includes('conversation-code-block'), true,
        'fenced code renders inside a copyable block wrapper');
    assert.equal(html.includes('conversation-code-header'), true,
        'the block chrome sits on its own header strip');
    const headerIndex = html.indexOf('conversation-code-header');
    const langIndex = html.indexOf('conversation-code-lang');
    const codeCopyIndex = html.indexOf('conversation-code-copy');
    const codeIndex = html.indexOf('language-ts');
    assert.ok(headerIndex >= 0 && langIndex > headerIndex
        && codeCopyIndex > headerIndex && codeIndex > codeCopyIndex,
        'the header strip carries the label and copy control above the code');
    const userIndex = html.indexOf('conversation-message-user');
    const userTextIndex = html.indexOf('Add tests for the parser');
    const starIndex = html.indexOf('conversation-message-bookmark');
    const userCornerIndex = html.indexOf('conversation-message-corner');
    assert.ok(userIndex >= 0 && starIndex > userIndex
        && userCornerIndex > starIndex && userCornerIndex < userTextIndex,
        'the user card corner cluster sits with the star above its content');
    const userCopyIndex = html.indexOf('conversation-message-copy');
    assert.ok(userCopyIndex > userCornerIndex
        && userCopyIndex < userTextIndex,
        'the user copy control lives in the corner cluster');
    const assistantIndex = html.indexOf('conversation-message-assistant');
    const answerTextIndex = html.indexOf('Like this:');
    const answerActionsIndex = html.indexOf(
        'conversation-message-actions'
    );
    assert.ok(assistantIndex >= 0 && answerTextIndex > assistantIndex
        && answerActionsIndex > answerTextIndex,
        'the assistant action row sits below its content');
    assert.equal(
        html.indexOf('conversation-message-actions', answerActionsIndex + 1),
        -1,
        'only the assistant answer carries a bottom action row'
    );
    assert.equal(
        html.includes('conversation-message-time'),
        false,
        'providers without timing expose no clock on the action row'
    );
});

test('CONVERSATION-FIND-001 renders a hidden find bar wired for in-page search', async () => {
    const { viewer, panel } = createViewer({
        readPage: async request => copyPage(request.sessionId),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    assert.match(
        html,
        /<div class="conversation-find" data-conversation-find hidden>/,
        'the find bar ships hidden until the webview opens it'
    );
    const workspaceIndex = html.indexOf('conversation-workspace');
    const findIndex = html.indexOf('data-conversation-find');
    const inputIndex = html.indexOf('data-find-input');
    const countIndex = html.indexOf('data-find-count');
    const previousIndex = html.indexOf('data-find-previous');
    const nextIndex = html.indexOf('data-find-next');
    const closeIndex = html.indexOf('data-find-close');
    assert.ok(workspaceIndex >= 0 && findIndex > workspaceIndex,
        'the find bar lives inside the conversation workspace overlay');
    assert.ok(inputIndex > findIndex && countIndex > inputIndex
        && previousIndex > countIndex && nextIndex > previousIndex
        && closeIndex > nextIndex,
        'the bar pairs the query input and match count with previous, next, and close controls');
    assert.equal(
        html.indexOf('data-conversation-find', findIndex + 1),
        -1,
        'exactly one find bar renders'
    );
    assert.match(html, /type="search"[^>]*data-find-input/);
    assert.equal(html.includes('Find in conversation'), true);
    assert.equal(html.includes('Previous match'), true);
    assert.equal(html.includes('Next match'), true);
    assert.ok(
        findIndex < html.indexOf('conversationFindScripts.js'),
        'the find bar markup ships before its controller script tag'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 clocks the answer action row when the provider exposes timing', async () => {
    const timestamp = Date.now() - 120_000;
    const completedAt = Date.now();
    const { viewer, panel } = createViewer({
        readPage: async request => ({
            ...copyPage(request.sessionId),
            interactionStates: [{
                interactionId: 'input-1',
                responseState: 'complete',
                timestamp,
                completedAt,
            }],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    const html = panel.webview.html;
    const matches = [...html.matchAll(
        /conversation-message-time\\&quot; title=\\&quot;([^\\]+?)\\&quot;/g
    )];
    assert.equal(matches.length, 2,
        'the user corner and the answer row both carry a clock');
    assert.equal(
        matches[0][1],
        formatConversationClockTime(timestamp, Date.now()).title,
        'the user corner clocks the input time'
    );
    assert.equal(
        matches[1][1],
        formatConversationClockTime(completedAt, Date.now()).title,
        'the answer row clocks the completion time'
    );
    const copyIndex = html.indexOf('conversation-message-copy');
    const timeIndex = html.indexOf('conversation-message-time');
    assert.ok(
        timeIndex >= 0 && timeIndex < copyIndex,
        'the user clock sits left of the copy control'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 omits the clock when timing overflows the Date range', async () => {
    const { viewer, panel } = createViewer({
        readPage: async request => ({
            ...copyPage(request.sessionId),
            interactionStates: [{
                interactionId: 'input-1',
                responseState: 'complete',
                completedAt: 1e308,
            }],
        }),
    });

    await viewer.open(target('session-a', 'input-1'));
    assert.equal(
        panel.webview.html.includes('conversation-message-time'),
        false,
        'finite-but-invalid timestamps render no clock'
    );
});

test('CONVERSATION-COPY-ACTIONS-001 settles copies through the Host clipboard', async () => {
    const clips = [];
    const { viewer, panel } = createViewer({
        writeClipboardText: async text => {
            clips.push(text);
        },
        readPage: async request => copyPage(request.sessionId),
    });
    await viewer.open(target('session-a', 'input-1'));

    await panel.receive(copyRequest('copy-1', {
        kind: 'message',
        messageId: 'input-1:assistant:0',
    }));
    assert.deepEqual(clips, ['Like this:\n\n```ts\nconst answer = 42;\n```'],
        'message copies resolve the raw markdown from Host state');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-1',
        success: true,
    });

    await panel.receive(copyRequest('copy-2', {
        kind: 'code',
        text: 'const answer = 42;\n',
    }));
    assert.deepEqual(clips.at(-1), 'const answer = 42;\n');
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-2',
        success: true,
    });

    await panel.receive(copyRequest('copy-3', {
        kind: 'message',
        messageId: 'input-9:user',
    }));
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-3',
        success: false,
        error: 'invalid',
    }, 'unknown messages settle as invalid without touching the clipboard');
    assert.equal(clips.length, 2);

    await panel.receive(copyRequest('copy-4', {
        kind: 'code',
        text: 'stale',
    }, { subscriptionGeneration: 2 }));
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-4',
        success: false,
        error: 'invalid',
    }, 'stale generations settle as invalid without touching the clipboard');
    assert.equal(clips.length, 2);

    await panel.receive(copyRequest('copy-5', {
        kind: 'message',
        messageId: 'input-1:user',
    }, { sessionId: 'session-b' }));
    assert.deepEqual(panel.postedMessages.at(-1), {
        type: 'conversation-viewer-copy-result',
        version: 1,
        requestId: 'copy-5',
        success: false,
        error: 'invalid',
    }, 'wrong-target copies settle as invalid without touching the clipboard');
    assert.equal(clips.length, 2);
});

test('CONVERSATION-OVERSIZED-TURN-001 renders a bounded oversized turn with its input, omission notice, and final answer', async () => {
    const sessionId = 'oversized-kimi-turn';
    const interactionId = 'input-oversized';
    const interaction = {
        id: interactionId,
        timestamp: 1_000,
        completedAt: 2_000,
        userMarkdown: 'Inspect the large run',
        userPreview: 'Inspect the large run',
        userGraphemeCount: 21,
        assistantMarkdown: ['Final bounded answer.'],
        toolCalls: Array.from({ length: 160 }, (_item, index) => ({
            position: 0,
            name: 'Shell',
            summary: `Shell command ${index}`,
            detail: 'x'.repeat(4_000),
        })),
        responseState: 'complete',
    };
    const boundedPage = buildConversationPage([interaction], {
        provider: 'kimi',
        sessionId,
        anchorInteractionId: interactionId,
        direction: 'around',
    }, 'r1');
    const { viewer, panel } = createViewer({
        readOutline: async () => ({
            provider: 'kimi',
            sessionId,
            sourceRevision: 'r1',
            interactions: [{
                id: interactionId,
                timestamp: interaction.timestamp,
                completedAt: interaction.completedAt,
                userPreview: interaction.userPreview,
                userGraphemeCount: interaction.userGraphemeCount,
                responseState: interaction.responseState,
            }],
            totalInteractions: 1,
            partial: false,
        }),
        readPage: async () => boundedPage,
    });

    await viewer.open(target(sessionId, interactionId, { provider: 'kimi' }));

    assert.match(panel.webview.html, /Inspect the large run/);
    assert.match(
        panel.webview.html,
        /Work was omitted to keep this turn within the conversation size limit\./
    );
    assert.match(panel.webview.html, /Final bounded answer\./);
    assert.match(panel.webview.html, /conversation-message-worklog/);
    const inputIndex = panel.webview.html.indexOf('Inspect the large run');
    const omissionIndex = panel.webview.html.indexOf(
        'Work was omitted to keep this turn within the conversation size limit.'
    );
    const answerIndex = panel.webview.html.indexOf('Final bounded answer.');
    assert.ok(
        inputIndex >= 0 && omissionIndex > inputIndex && answerIndex > omissionIndex,
        `bounded turn order was ${inputIndex}/${omissionIndex}/${answerIndex}`
    );
});

test('WORKTREE-CHANGES-PANEL-001 the viewer publishes collected working items for a group session', async t => {
    const fixture = await worktreeChangesFixture(t);
    const baseline = {
        commitSha: fixture.baselineSha,
        capturedAt: Date.now(),
        source: { kind: 'branch', fullRef: 'refs/heads/main' },
    };
    const worktreeKey = {
        repositoryKey: await fs.promises.realpath(path.join(fixture.repo, '.git')),
        canonicalWorktreePath: await fs.promises.realpath(fixture.worktreePath),
    };
    const { viewer, panel } = createViewer({
        changes: {
            resolveSessionIdentity: async () => ({
                worktreeKey,
                navigationIdentity: 'nav',
            }),
            resolveWorktreeKey: async () => undefined,
            findGroupByWorktreeKey: () => ({
                groupId: 'group-1',
                primaryMemberId: 'member-1',
                members: [{
                    memberId: 'member-1',
                    repositoryKey: worktreeKey.repositoryKey,
                    worktreeKey,
                    branchName: 'agent-pivot/task',
                    path: worktreeKey.canonicalWorktreePath,
                    state: 'ready',
                    baseline,
                }],
            }),
            listRetiredIdentities: () => [],
            collector: new ChangesCollector(),
            openWorkingChangeDiff: async () => {},
            openTaskResultReview: async () => {},
            showWorktreeInSourceControl: async () => {},
        },
    });
    t.after(() => viewer.dispose());

    await viewer.open({
        projectId: 'project',
        provider: 'codex',
        sessionId: 'session-1',
        workspaceName: 'Workspace',
        interactionId: 'input-1',
        expectedRevision: 'r1',
        displayName: 'Task session',
        duplicateDisplayName: false,
    });

    let state;
    for (let attempt = 0; attempt < 50 && !state; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        state = panel.postedMessages
            .filter(message => message.type === 'conversation-viewer-changes')
            .filter(message => message.version === 2)
            .at(-1)?.changes;
    }
    assert.ok(state, 'a changes state is published');
    assert.equal(state.kind, 'ready');
    assert.equal(state.aggregate.workingItemCount, 1);
    assert.deepEqual(state.detail.items.map(item => item.path),
        ['changed.ts'],
        'the modified file reaches the webview');
    const member = state.members[0];
    assert.equal(member.headSha,
        git(fixture.worktreePath, ['rev-parse', 'HEAD']),
        'the member view carries the collected HEAD sha');
    assert.deepEqual(member.upstream, { status: 'none' },
        'the fixture worktree has no tracking branch — a stated fact');
});

test('WORKTREE-CHANGES-PANEL-001 disposing the viewer resets the changes controller and its watcher', async t => {
    const fixture = await worktreeChangesFixture(t);
    const baseline = {
        commitSha: fixture.baselineSha,
        capturedAt: Date.now(),
        source: { kind: 'branch', fullRef: 'refs/heads/main' },
    };
    const worktreeKey = {
        repositoryKey: await fs.promises.realpath(path.join(fixture.repo, '.git')),
        canonicalWorktreePath: await fs.promises.realpath(fixture.worktreePath),
    };
    const watchers = [];
    const { viewer, panel } = createViewer({
        changes: {
            resolveSessionIdentity: async () => ({
                worktreeKey,
                navigationIdentity: 'nav',
            }),
            resolveWorktreeKey: async () => undefined,
            findGroupByWorktreeKey: () => ({
                groupId: 'group-1',
                primaryMemberId: 'member-1',
                members: [{
                    memberId: 'member-1',
                    repositoryKey: worktreeKey.repositoryKey,
                    worktreeKey,
                    branchName: 'agent-pivot/task',
                    path: worktreeKey.canonicalWorktreePath,
                    state: 'ready',
                    baseline,
                }],
            }),
            listRetiredIdentities: () => [],
            collector: new ChangesCollector(),
            openWorkingChangeDiff: async () => {},
            openTaskResultReview: async () => {},
            showWorktreeInSourceControl: async () => {},
            watchRepositoryChanges: (_paths, _onChange) => {
                const watcher = { disposed: false,
                    dispose() { this.disposed = true; } };
                watchers.push(watcher);
                return watcher;
            },
        },
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-1'));

    let state;
    for (let attempt = 0; attempt < 50 && !state; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        state = panel.postedMessages
            .filter(message => message.type === 'conversation-viewer-changes')
            .filter(message => message.version === 2)
            .at(-1)?.changes;
    }
    assert.ok(state, 'a changes state is published');
    assert.ok(watchers.length > 0, 'the active collection owns a watcher');

    viewer.dispose();
    assert.ok(watchers.every(watcher => watcher.disposed),
        'disposal resets the changes controller and disposes its watcher');

    const published = panel.postedMessages
        .filter(message => message.type === 'conversation-viewer-changes')
        .length;
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(
        panel.postedMessages
            .filter(message => message.type === 'conversation-viewer-changes')
            .length,
        published,
        'no changes collection or publication outlives the viewer');
});

test('WORKTREE-CHANGES-PANEL-001 drops changes actions stranded by a session switch', async t => {
    const fixture = await worktreeChangesFixture(t);
    const baseline = {
        commitSha: fixture.baselineSha,
        capturedAt: Date.now(),
        source: { kind: 'branch', fullRef: 'refs/heads/main' },
    };
    const worktreeKey = {
        repositoryKey: await fs.promises.realpath(path.join(fixture.repo, '.git')),
        canonicalWorktreePath: await fs.promises.realpath(fixture.worktreePath),
    };
    let reviewCalls = 0;
    let scmCalls = 0;
    const { viewer, panel } = createViewer({
        changes: {
            resolveSessionIdentity: async () => ({
                worktreeKey,
                navigationIdentity: 'nav',
            }),
            resolveWorktreeKey: async () => undefined,
            findGroupByWorktreeKey: () => ({
                groupId: 'group-1',
                primaryMemberId: 'member-1',
                members: [{
                    memberId: 'member-1',
                    repositoryKey: worktreeKey.repositoryKey,
                    worktreeKey,
                    branchName: 'agent-pivot/task',
                    path: worktreeKey.canonicalWorktreePath,
                    state: 'ready',
                    baseline,
                }],
            }),
            listRetiredIdentities: () => [],
            collector: new ChangesCollector(),
            openWorkingChangeDiff: async () => {},
            openTaskResultReview: async () => {
                reviewCalls += 1;
            },
            showWorktreeInSourceControl: async () => {
                scmCalls += 1;
            },
        },
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-1'));

    let publication;
    for (let attempt = 0; attempt < 50 && !publication; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        publication = panel.postedMessages
            .filter(message => message.type === 'conversation-viewer-changes')
            .filter(message => message.version === 2)
            .at(-1);
    }
    assert.ok(publication, 'a changes state is published');
    const generationA = publication.subscriptionGeneration;
    const intent = (overrides) => ({
        type: 'conversation-viewer-changes-review',
        version: 1,
        subscriptionGeneration: generationA,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-1',
        memberId: 'member-1',
        ...overrides,
    });

    // The correctly correlated intent still executes.
    await panel.receive(intent());
    assert.equal(reviewCalls, 1, 'the current intent reaches the review');

    // A stale generation, a foreign session, or a foreign project fails
    // closed without touching the controller.
    await panel.receive(intent({ subscriptionGeneration: generationA - 1 }));
    await panel.receive(intent({ sessionId: 'session-2' }));
    await panel.receive(intent({ projectId: 'project-b' }));
    assert.equal(reviewCalls, 1,
        'stale or foreign intents are dropped before dispatch');

    // Switch sessions: the pre-switch intent is stranded on the old
    // generation and session identity, and must not act on session-2 even
    // though its member IDs overlap.
    await viewer.follow(target('session-2'));
    await panel.receive(intent());
    await panel.receive(intent({
        type: 'conversation-viewer-changes-open-scm',
    }));
    assert.equal(reviewCalls, 1,
        'a pre-switch review intent must not act on the new session');
    assert.equal(scmCalls, 0,
        'a pre-switch open-SCM intent must not act on the new session');
});

test('WORKTREE-CHANGES-COMMITS-001 commits requests bind to generation and session like changes actions', async t => {
    const fixture = await worktreeChangesFixture(t);
    // One commit past the baseline, so the since-start page is non-empty.
    await fs.promises.writeFile(
        path.join(fixture.worktreePath, 'committed.ts'), 'c\n');
    git(fixture.worktreePath, ['add', 'committed.ts']);
    git(fixture.worktreePath, ['commit', '-m', 'task commit', '-q']);
    const baseline = {
        commitSha: fixture.baselineSha,
        capturedAt: Date.now(),
        source: { kind: 'branch', fullRef: 'refs/heads/main' },
    };
    const worktreeKey = {
        repositoryKey: await fs.promises.realpath(path.join(fixture.repo, '.git')),
        canonicalWorktreePath: await fs.promises.realpath(fixture.worktreePath),
    };
    const { viewer, panel } = createViewer({
        changes: {
            resolveSessionIdentity: async () => ({
                worktreeKey,
                navigationIdentity: 'nav',
            }),
            resolveWorktreeKey: async () => undefined,
            findGroupByWorktreeKey: () => ({
                groupId: 'group-1',
                primaryMemberId: 'member-1',
                members: [{
                    memberId: 'member-1',
                    repositoryKey: worktreeKey.repositoryKey,
                    worktreeKey,
                    branchName: 'agent-pivot/task',
                    path: worktreeKey.canonicalWorktreePath,
                    state: 'ready',
                    baseline,
                }],
            }),
            listRetiredIdentities: () => [],
            collector: new ChangesCollector(),
            commitsCollector: new CommitsCollector(),
            openWorkingChangeDiff: async () => {},
            openTaskResultReview: async () => {},
            openCommitFileDiff: async () => {},
            openCommitReview: async () => {},
            showWorktreeInSourceControl: async () => {},
        },
    });
    t.after(() => viewer.dispose());

    await viewer.open(target('session-1'));

    let publication;
    for (let attempt = 0; attempt < 50 && !publication; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20));
        publication = panel.postedMessages
            .filter(message => message.type === 'conversation-viewer-changes')
            .filter(message => message.version === 2)
            .at(-1);
    }
    assert.ok(publication, 'a changes state is published');
    const generationA = publication.subscriptionGeneration;
    const request = overrides => ({
        type: 'conversation-viewer-commits-list',
        version: 1,
        requestId: 'req-1',
        subscriptionGeneration: generationA,
        projectId: 'project-a',
        provider: 'codex',
        sessionId: 'session-1',
        memberId: 'member-1',
        scope: 'since-start',
        offset: 0,
        ...overrides,
    });

    // The correctly bound request gets a real, correlated response.
    await panel.receive(request());
    const response = panel.postedMessages
        .filter(message => message.type === 'conversation-viewer-commits')
        .at(-1);
    assert.ok(response, 'a commits response is published');
    assert.equal(response.requestId, 'req-1');
    assert.equal(response.subscriptionGeneration, generationA);
    assert.equal(response.memberId, 'member-1');
    assert.equal(response.commits.length, 1,
        'the real collector lists the fixture commit since baseline — got: '
            + JSON.stringify(response));
    assert.equal(response.sectionComplete, true);
    assert.equal(response.baselineRow.sha, fixture.baselineSha);

    // A request stranded by a session switch is dropped without a response.
    await viewer.follow(target('session-2'));
    const before = panel.postedMessages.length;
    await panel.receive(request({ requestId: 'req-stale' }));
    assert.ok(!panel.postedMessages.slice(before).some(message =>
        message.type === 'conversation-viewer-commits'),
        'a pre-switch commits request never reaches the new session');
});
