'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    MarkdownDocumentCommentController,
} = require('../../../out/aiSessions/conversation/documentCommentController');

const VIEWER_TARGET = Object.freeze({
    projectId: 'project-a', provider: 'codex', sessionId: 'session-a',
});
const DOCUMENT = Object.freeze({
    workspaceRootId: 'workspace-root-a',
    relativePath: 'docs/plan.md',
    documentVersion: 'sha256:document-a',
});

function createHarness(overrides = {}) {
    const posted = [];
    const saved = [];
    const submitted = [];
    let now = 1000;
    const controller = new MarkdownDocumentCommentController({
        documentCommentStore: {
            load: async () => ({ revision: 0, comments: [] }),
            save: async (target, snapshot) => saved.push({ target, snapshot }),
        },
        submitPrompt: async (target, prompt) => submitted.push({ target, prompt }),
        getTarget: () => VIEWER_TARGET,
        getSubscriptionGeneration: () => 7,
        getPanel: () => ({ webview: { postMessage: async message => {
            posted.push(message); return true;
        } } }),
        now: () => now,
        ...overrides,
    });
    return { controller, posted, saved, submitted, setNow: value => { now = value; } };
}

function request(requestId, operation, payload, expectedRevision, document = DOCUMENT) {
    return {
        type: operation === 'sendDocumentComment'
            ? 'conversation-viewer-send-document-comment'
            : 'conversation-viewer-document-comment-mutation',
        version: 1,
        requestId,
        subscriptionGeneration: 7,
        ...VIEWER_TARGET,
        operation,
        expectedRevision,
        document,
        payload,
    };
}

async function activate(controller, version = DOCUMENT.documentVersion) {
    await controller.activate({
        target: {
            projectId: VIEWER_TARGET.projectId,
            workspaceRootId: DOCUMENT.workspaceRootId,
            relativePath: DOCUMENT.relativePath,
        },
        documentVersion: version,
        viewerTarget: VIEWER_TARGET,
        subscriptionGeneration: 7,
    });
}

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 persists file-anchored drafts, settlements, and AI dispatches', async () => {
    const { controller, posted, saved, submitted, setNow } = createHarness();
    await activate(controller);
    await controller.enqueue(request('add-a', 'add', {
        anchor: {
            selectedText: 'Ship the rollback plan.',
            prefix: 'Migration:', suffix: 'Before release.', headingPath: ['Migration'],
        },
        text: 'Explain the operational fallback.',
    }, 0));
    assert.equal(controller.snapshot.revision, 1);
    const comment = controller.snapshot.comments[0];
    assert.equal(comment.status, 'draft');
    assert.deepEqual(saved[0].target, {
        projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md',
    });
    assert.equal(posted.at(-1).success, true);
    assert.equal(posted.at(-1).document.documentVersion, DOCUMENT.documentVersion);

    setNow(2000);
    await controller.enqueue(request('send-a', 'sendDocumentComment', { commentId: comment.id }, 1));
    assert.equal(submitted.length, 1);
    assert.match(submitted[0].prompt, /文件：docs\/plan\.md/);
    assert.match(submitted[0].prompt, /Ship the rollback plan/);
    assert.match(submitted[0].prompt, /markdown-document-comment-id:[a-f0-9]{32}/);
    assert.match(submitted[0].prompt, /```markdown-suggestion/);
    assert.match(submitted[0].prompt, /"selectedText":"引用原文的精确文本"/);
    assert.equal(controller.snapshot.comments[0].status, 'sent');
    assert.deepEqual(controller.snapshot.comments[0].conversationRef, {
        provider: 'codex', sessionId: 'session-a',
    });

    await controller.enqueue(request('resolve-a', 'setStatus', {
        commentId: comment.id, status: 'resolved',
    }, 3));
    assert.equal(controller.snapshot.comments[0].status, 'resolved');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 rejects stale document identity and marks version-mismatched anchors outdated', async () => {
    const stored = {
        revision: 3,
        comments: [{
            id: 'comment-a', documentVersion: DOCUMENT.documentVersion,
            anchor: { selectedText: 'Old text.', prefix: '', suffix: '', headingPath: [] },
            text: 'Review this.', status: 'sent', createdAt: 1,
        }],
    };
    const { controller, posted, saved } = createHarness({
        documentCommentStore: {
            load: async () => stored,
            save: async (_target, snapshot) => saved.push(snapshot),
        },
    });
    await activate(controller, 'sha256:document-b');
    assert.equal(controller.snapshot.revision, 4);
    assert.equal(controller.snapshot.comments[0].status, 'outdated');
    assert.equal(saved.length, 1);

    await controller.enqueue(request('wrong-document', 'delete', { commentId: 'comment-a' }, 4, {
        ...DOCUMENT, documentVersion: 'sha256:document-c',
    }));
    assert.equal(posted.at(-1).success, false);
    assert.equal(posted.at(-1).error, 'stale');
    assert.equal(controller.snapshot.comments.length, 1);
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 preserves a uniquely relocated anchor after an unrelated edit', async () => {
    const { controller } = createHarness({
        documentCommentStore: { load: async () => ({ revision: 1, comments: [{
            id: 'comment-relocate', documentVersion: DOCUMENT.documentVersion,
            anchor: { selectedText: 'Keep this.', prefix: 'Before ', suffix: ' After', headingPath: [] },
            text: 'Review it.', status: 'sent', createdAt: 1,
        }] }), save: async () => undefined },
    });
    await controller.activate({
        target: { projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md' },
        documentVersion: 'sha256:document-next',
        markdown: 'New introduction. Before Keep this. After more text.',
        viewerTarget: VIEWER_TARGET, subscriptionGeneration: 7,
    });
    assert.equal(controller.snapshot.comments[0].status, 'sent');
    assert.equal(controller.snapshot.comments[0].documentVersion, 'sha256:document-next');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 relocates duplicate quotes only with a unique heading or line hint', async () => {
    const { controller } = createHarness({
        documentCommentStore: { load: async () => ({ revision: 1, comments: [
            {
                id: 'comment-heading', documentVersion: DOCUMENT.documentVersion,
                anchor: { selectedText: 'Deploy carefully.', prefix: '', suffix: '', headingPath: ['Release'] },
                text: 'Review the release advice.', status: 'sent', createdAt: 1,
            },
            {
                id: 'comment-range', documentVersion: DOCUMENT.documentVersion,
                anchor: {
                    selectedText: 'Verify rollback.', prefix: '', suffix: '', headingPath: ['Missing'],
                    rangeHint: { startLine: 7, endLine: 7 },
                },
                text: 'Keep this check.', status: 'sent', createdAt: 1,
            },
        ] }), save: async () => undefined },
    });
    await controller.activate({
        target: { projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md' },
        documentVersion: 'sha256:document-next',
        markdown: [
            '# Draft', 'Deploy carefully.', 'Verify rollback.', '', '# Release',
            'Deploy carefully.', 'Verify rollback.',
        ].join('\n'),
        viewerTarget: VIEWER_TARGET, subscriptionGeneration: 7,
    });
    assert.equal(controller.snapshot.comments[0].status, 'sent');
    assert.equal(controller.snapshot.comments[0].documentVersion, 'sha256:document-next');
    assert.equal(controller.snapshot.comments[1].status, 'sent');
    assert.equal(controller.snapshot.comments[1].documentVersion, 'sha256:document-next');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 keeps an interrupted outbox state when a prompt rollback cannot persist', async () => {
    let saves = 0;
    const { controller, posted } = createHarness({
        documentCommentStore: {
            load: async () => ({ revision: 0, comments: [] }),
            save: async () => {
                saves += 1;
                if (saves === 3) { throw new Error('rollback storage unavailable'); }
            },
        },
        submitPrompt: async () => { throw new Error('prompt staging unavailable'); },
    });
    await activate(controller);
    await controller.enqueue(request('add-for-failure', 'add', {
        anchor: { selectedText: 'Keep this.', prefix: '', suffix: '', headingPath: [] },
        text: 'Review it.',
    }, 0));
    const comment = controller.snapshot.comments[0];
    await controller.enqueue(request('send-with-failed-rollback', 'sendDocumentComment', {
        commentId: comment.id,
    }, 1));
    assert.equal(posted.at(-1).success, false);
    assert.equal(controller.snapshot.comments[0].status, 'sending',
        'a failed dispatch must retain the durable outbox state, never a false sent result');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 relocates reader text across safe Markdown formatting', async () => {
    const { controller } = createHarness({
        documentCommentStore: { load: async () => ({ revision: 1, comments: [{
            id: 'comment-formatted', documentVersion: DOCUMENT.documentVersion,
            anchor: { selectedText: 'Rollback strategy', prefix: '', suffix: '', headingPath: ['Release'] },
            text: 'Keep the reader-visible wording anchored.', status: 'sent', createdAt: 1,
        }] }), save: async () => undefined },
    });
    await controller.activate({
        target: { projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md' },
        documentVersion: 'sha256:document-formatted',
        markdown: '# Release\n\n**Rollback** [strategy](docs/restore.md)\n',
        viewerTarget: VIEWER_TARGET, subscriptionGeneration: 7,
    });
    assert.equal(controller.snapshot.comments[0].status, 'sent');
    assert.equal(controller.snapshot.comments[0].documentVersion, 'sha256:document-formatted');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 retains bounded AI replies with the durable file comment', async () => {
    const { controller, saved } = createHarness();
    await activate(controller);
    await controller.enqueue(request('add-for-reply-history', 'add', {
        anchor: { selectedText: 'Keep this.', prefix: '', suffix: '', headingPath: [] },
        text: 'Explain the trade-off.',
    }, 0));
    const comment = controller.snapshot.comments[0];
    await controller.enqueue(request('send-for-reply-history', 'sendDocumentComment', {
        commentId: comment.id,
    }, 1));

    await controller.recordReplies([{
        commentId: comment.id,
        messageId: 'assistant-document-reply-a',
        markdown: 'The safe fallback is to stop and restore the prior state.',
        provider: 'codex', sessionId: 'session-a',
    }]);

    assert.deepEqual(controller.snapshot.comments[0].discussion, [{
        messageId: 'assistant-document-reply-a',
        markdown: 'The safe fallback is to stop and restore the prior state.',
        createdAt: 1000,
        provider: 'codex', sessionId: 'session-a',
    }]);
    assert.deepEqual(saved.at(-1).snapshot.comments[0].discussion,
        controller.snapshot.comments[0].discussion,
        'the reply must survive a viewer recreation rather than only a transcript cache');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 recovers a settlement that the Webview cannot receive', async () => {
    const recoveries = [];
    const { controller } = createHarness({
        getPanel: () => ({ webview: { postMessage: async () => false } }),
        onPublicationFailure: async settlement => recoveries.push(settlement),
    });
    await activate(controller);
    await controller.enqueue(request('delivery-failure', 'add', {
        anchor: { selectedText: 'Keep this.', prefix: '', suffix: '', headingPath: [] },
        text: 'Persist this despite a transient Webview failure.',
    }, 0));
    assert.equal(recoveries.length, 1);
    assert.equal(recoveries[0].requestId, 'delivery-failure');
    assert.equal(recoveries[0].success, true);
});
