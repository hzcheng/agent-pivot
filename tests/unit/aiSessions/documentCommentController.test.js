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

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 sends a bounded batch in one prompt and rolls back provider failures', async () => {
    for (const fails of [false, true]) {
        const h = createHarness(fails ? { submitPrompt: async () => { throw new Error('offline'); } } : {});
        await activate(h.controller);
        for (let i = 0; i < 2; i++) {
            await h.controller.enqueue(request('batch-add-' + i, 'add', {
                anchor: { selectedText: 'Passage ' + i, prefix: '', suffix: '', headingPath: [] }, text: 'Comment ' + i,
            }, i));
        }
        const ids = h.controller.snapshot.comments.map(c => c.id);
        const send = request('batch-send', 'sendDocumentComment', { commentIds: ids }, 2);
        await h.controller.enqueue(send);
        assert.equal(h.posted.at(-1).success, !fails);
        assert.ok(h.controller.snapshot.comments.every(c => c.status === (fails ? 'draft' : 'sent')));
        if (!fails) {
            assert.equal(h.submitted.length, 1);
            assert.match(h.submitted[0].prompt, /Comment 0/);
            assert.match(h.submitted[0].prompt, /Comment 1/);
            await h.controller.enqueue(send);
            assert.equal(h.submitted.length, 1);
        }
    }
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 rejects invalid batch identities before dispatch', async () => {
    const { parseConversationViewerMessage } = require('../../../out/aiSessions/conversation/viewerProtocol');
    for (const ids of [[], ['same', 'same'], Array.from({ length: 21 }, (_, i) => 'id-' + i), [null]]) {
        assert.equal(parseConversationViewerMessage(request('invalid-batch', 'sendDocumentComment', { commentIds: ids }, 0)), undefined);
    }
    const h = createHarness();
    await activate(h.controller);
    await h.controller.enqueue(request('unknown-batch', 'sendDocumentComment', { commentIds: ['unknown'] }, 0));
    assert.equal(h.submitted.length, 0);
    assert.equal(h.posted.at(-1).success, false);
    assert.equal(h.controller.snapshot.revision, 0);
});

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

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 rebases a new draft after another window advances the file revision', async () => {
    let persisted = { revision: 0, comments: [] };
    let saveAttempts = 0;
    const { controller, posted } = createHarness({
        documentCommentStore: {
            load: async () => ({
                revision: persisted.revision,
                comments: persisted.comments.map(comment => ({
                    ...comment,
                    anchor: { ...comment.anchor, headingPath: [...comment.anchor.headingPath] },
                })),
            }),
            save: async (_target, next) => {
                saveAttempts += 1;
                if (saveAttempts === 1) {
                    persisted = {
                        revision: 1,
                        comments: [{
                            id: 'other-window-comment',
                            documentVersion: DOCUMENT.documentVersion,
                            anchor: {
                                selectedText: 'Existing note.', prefix: '', suffix: '', headingPath: [],
                            },
                            text: 'Saved elsewhere.', status: 'draft', createdAt: 500,
                        }],
                    };
                    throw new Error('Markdown document comments changed in another window.');
                }
                persisted = next;
            },
        },
    });
    await activate(controller);

    await controller.enqueue(request('add-after-concurrent-save', 'add', {
        anchor: {
            selectedText: 'Ship the rollback plan.', prefix: '', suffix: '', headingPath: [],
        },
        text: 'Keep this comment too.',
    }, 0));

    assert.equal(posted.at(-1).success, true,
        'a safe additive mutation should not make the user retry after another window saves first');
    assert.equal(persisted.revision, 2);
    assert.deepEqual(persisted.comments.map(comment => comment.text), [
        'Keep this comment too.', 'Saved elsewhere.',
    ]);
});

test('CONVERSATION-MARKDOWN-WORKSPACE-001 saves a renderer anchor after removing empty heading crumbs', async () => {
    const { controller, posted, saved } = createHarness();
    await activate(controller);

    await controller.enqueue(request('add-renderer-anchor', 'add', {
        anchor: {
            selectedText: 'Ship the rollback plan.',
            prefix: 'Migration: ',
            suffix: ' Before release.',
            // Rendered headings can be visually empty (for example an
            // image-only heading), and older live Webviews can retain that
            // crumb while the extension Host is reloaded underneath them.
            headingPath: ['', 'Migration', '   '],
        },
        text: 'Explain the operational fallback.',
    }, 0));

    assert.equal(posted.at(-1).success, true);
    assert.equal(saved.length, 1);
    assert.deepEqual(controller.snapshot.comments[0].anchor.headingPath, ['Migration']);
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

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 derives a source line hint for an unambiguous reader selection', async () => {
    const { controller } = createHarness();
    await controller.activate({
        target: { projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md' },
        documentVersion: DOCUMENT.documentVersion,
        markdown: '# Release\n\nKeep the *rollback strategy* visible with a guard.\n\nKeep the rollback strategy visible.',
        viewerTarget: VIEWER_TARGET, subscriptionGeneration: 7,
    });
    await controller.enqueue(request('add-line-hint', 'add', {
        anchor: {
            selectedText: 'Keep the rollback strategy visible with a guard.', prefix: '', suffix: '', headingPath: ['Release'],
        },
        text: 'Keep this passage reviewable after harmless edits.',
    }, 0));
    assert.deepEqual(controller.snapshot.comments[0].anchor.rangeHint,
        { startLine: 3, endLine: 3 });
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

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 relocates single-emphasis reader text after an unrelated edit', async () => {
    const { controller } = createHarness({
        documentCommentStore: { load: async () => ({ revision: 1, comments: [{
            id: 'comment-single-emphasis', documentVersion: DOCUMENT.documentVersion,
            anchor: { selectedText: 'Rollback strategy', prefix: '', suffix: '', headingPath: ['Release'] },
            text: 'Keep this phrase anchored.', status: 'sent', createdAt: 1,
        }] }), save: async () => undefined },
    });
    await controller.activate({
        target: { projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md' },
        documentVersion: 'sha256:document-single-emphasis',
        markdown: '# Release\n\n_unrelated update_\n\n*Rollback* _strategy_\n',
        viewerTarget: VIEWER_TARGET, subscriptionGeneration: 7,
    });
    assert.equal(controller.snapshot.comments[0].status, 'sent');
    assert.equal(controller.snapshot.comments[0].documentVersion, 'sha256:document-single-emphasis');
});

test('MARKDOWN-DOCUMENT-COMMENTS-CONTROLLER-001 keeps intraword underscores intact while relocating', async () => {
    const { controller } = createHarness({
        documentCommentStore: { load: async () => ({ revision: 1, comments: [{
            id: 'comment-identifier', documentVersion: DOCUMENT.documentVersion,
            anchor: { selectedText: 'foo_bar_baz', prefix: '', suffix: '', headingPath: [] },
            text: 'Keep this identifier anchored.', status: 'sent', createdAt: 1,
        }] }), save: async () => undefined },
    });
    await controller.activate({
        target: { projectId: 'project-a', workspaceRootId: 'workspace-root-a', relativePath: 'docs/plan.md' },
        documentVersion: 'sha256:document-identifier',
        markdown: 'Unrelated introduction.\n\n`foo_bar_baz` remains a stable identifier.\n',
        viewerTarget: VIEWER_TARGET, subscriptionGeneration: 7,
    });
    assert.equal(controller.snapshot.comments[0].status, 'sent');
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
