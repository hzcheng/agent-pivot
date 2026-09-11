'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    buildMarkdownDocumentCommentPrompt,
    createMarkdownDocumentComment,
    setMarkdownDocumentCommentStatus,
    validateMarkdownDocumentComments,
} = require('../../../out/aiSessions/conversation/documentComments');

const target = {
    projectId: 'project-a',
    workspaceRootId: 'root-a',
    relativePath: 'docs/architecture-plan.md',
};

function input(overrides = {}) {
    return {
        documentVersion: 'sha256:document-a',
        anchor: {
            selectedText: 'The migration runs before restart.',
            prefix: 'Rollback strategy',
            suffix: 'Verify the database state.',
            headingPath: ['Operations', 'Rollback strategy'],
            rangeHint: { startLine: 42, endLine: 42 },
        },
        text: 'Explain the recovery path if this fails.',
        ...overrides,
    };
}

test('MARKDOWN-DOCUMENT-COMMENTS-001 creates file-anchored drafts and builds bounded AI context', () => {
    const comment = createMarkdownDocumentComment('comment-a', input(), 1000);
    assert.equal(comment.status, 'draft');
    assert.deepEqual(comment.anchor.headingPath, [
        'Operations', 'Rollback strategy',
    ]);
    const prompt = buildMarkdownDocumentCommentPrompt(target, comment);
    assert.match(prompt, /文件：docs\/architecture-plan\.md/);
    assert.match(prompt, /章节：Operations > Rollback strategy/);
    assert.match(prompt, /The migration runs before restart\./);
    assert.match(prompt, /Explain the recovery path/);
    assert.match(prompt, /markdown-document-comment-id:comment-a/);
});

test('CONVERSATION-MARKDOWN-WORKSPACE-001 sends compact context without repeating or truncating the selection', () => {
    const selectedText = 'Unique selected passage. '.repeat(50);
    const comment = createMarkdownDocumentComment('comment-a', input({
        anchor: { ...input().anchor, selectedText,
            prefix: 'DISTANT_PREFIX' + '前'.repeat(400) + 'NEAR_PREFIX',
            suffix: 'NEAR_SUFFIX' + '后'.repeat(400) + 'DISTANT_SUFFIX' },
    }), 1000);
    const before = JSON.stringify(comment);
    const prompt = buildMarkdownDocumentCommentPrompt(target, comment);
    assert.equal(prompt.split(comment.anchor.selectedText).length - 1, 1);
    assert.match(prompt, /NEAR_PREFIX/);
    assert.match(prompt, /NEAR_SUFFIX/);
    assert.doesNotMatch(prompt, /DISTANT_PREFIX|DISTANT_SUFFIX/);
    assert.ok(Array.from(prompt).length - Array.from(comment.anchor.selectedText).length < 650);
    assert.equal(JSON.stringify(comment), before, 'saved re-anchoring context must remain intact');
    assert.match(prompt, /markdown-document-comment-id:comment-a/);
    assert.match(prompt, /```markdown-suggestion/);
});

test('CONVERSATION-MARKDOWN-WORKSPACE-001 omits empty context and keeps short comments compact', () => {
    const comment = createMarkdownDocumentComment('comment-a', input({
        anchor: { ...input().anchor, prefix: '', suffix: '' },
    }), 1000);
    const prompt = buildMarkdownDocumentCommentPrompt(target, comment);
    assert.doesNotMatch(prompt, /前文：|后文：/);
    assert.ok(Array.from(prompt).length < 450);
    assert.ok(prompt.includes(comment.text));
});

test('MARKDOWN-DOCUMENT-COMMENTS-001 records sent, resolved, and outdated states without losing the anchor', () => {
    const draft = createMarkdownDocumentComment('comment-a', input(), 1000);
    const sent = setMarkdownDocumentCommentStatus(draft, 'sent', 2000, {
        provider: 'codex', sessionId: 'session-a', messageId: 'message-a',
    });
    assert.equal(sent.sentAt, 2000);
    assert.deepEqual(sent.conversationRef, {
        provider: 'codex', sessionId: 'session-a', messageId: 'message-a',
    });
    const resolved = setMarkdownDocumentCommentStatus(sent, 'resolved', 3000);
    assert.equal(resolved.resolvedAt, 3000);
    const outdated = setMarkdownDocumentCommentStatus(resolved, 'outdated', 4000);
    assert.equal(outdated.status, 'outdated');
    assert.equal(outdated.resolvedAt, undefined);
    assert.equal(outdated.anchor.selectedText, draft.anchor.selectedText);
});

test('MARKDOWN-DOCUMENT-COMMENTS-001 rejects unsafe document targets and ambiguous anchors', () => {
    const comment = createMarkdownDocumentComment('comment-a', input(), 1000);
    assert.throws(
        () => buildMarkdownDocumentCommentPrompt({ ...target, relativePath: '../secret.md' }, comment),
        /invalid/
    );
    assert.throws(
        () => createMarkdownDocumentComment('comment-b', input({
            anchor: { ...input().anchor, rangeHint: { startLine: 8, endLine: 7 } },
        }), 1000),
        /invalid/
    );
    assert.throws(
        () => validateMarkdownDocumentComments([
            comment,
            { ...comment },
        ]),
        /invalid/
    );
});
