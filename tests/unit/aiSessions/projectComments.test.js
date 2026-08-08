'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    addProjectCommentTag,
    buildProjectCommentPrompt,
    collectProjectCommentTagVocabulary,
    createProjectComment,
    PROJECT_COMMENT_LIMITS,
    recordProjectCommentDispatch,
    removeProjectCommentTag,
    reorderProjectComments,
    setProjectCommentStatus,
    updateProjectCommentText,
    validateProjectComments,
} = require('../../../out/aiSessions/conversation/projectComments');

function makeComment(overrides = {}) {
    return {
        id: 'note-a',
        text: 'Telemetry overflows at 400px.',
        tags: ['bug'],
        status: 'open',
        createdAt: 1000,
        dispatches: [],
        ...overrides,
    };
}

test('PROJECT-COMMENTS-001 creates notes with normalized tags and optional source', () => {
    const comment = createProjectComment('note-1', {
        text: '  Ship the inbox tab.  ',
        tags: [' Idea ', 'idea', 'UX'],
        source: {
            provider: 'kimi',
            sessionId: 'session-1',
            quote: 'quoted output',
        },
    }, 1234);
    assert.deepEqual(comment, {
        id: 'note-1',
        text: 'Ship the inbox tab.',
        tags: ['Idea', 'UX'],
        status: 'open',
        createdAt: 1234,
        source: {
            provider: 'kimi',
            sessionId: 'session-1',
            quote: 'quoted output',
        },
        dispatches: [],
    });

    assert.throws(
        () => createProjectComment('note-2', { text: '   ' }, 1),
        /invalid/
    );
    assert.throws(
        () => createProjectComment('note-3', { text: 'ok', tags: [''] }, 1),
        /invalid/
    );
    assert.throws(
        () => createProjectComment('note-4', {
            text: 'ok',
            tags: ['a', 'b', 'c', 'd', 'e', 'f'],
        }, 1),
        /invalid/
    );
    assert.throws(
        () => createProjectComment('note-5', {
            text: 'ok',
            source: { provider: 'gpt', sessionId: 's' },
        }, 1),
        /invalid/
    );
});

test('PROJECT-COMMENTS-001 adds and removes tags case-insensitively within per-note budget', () => {
    const base = makeComment({ tags: ['bug'] });
    const added = addProjectCommentTag(base, ' UX ');
    assert.deepEqual(added.tags, ['bug', 'UX']);
    assert.deepEqual(base.tags, ['bug']);

    const duplicate = addProjectCommentTag(added, 'ux');
    assert.deepEqual(duplicate.tags, ['bug', 'UX']);

    let comment = added;
    ['a', 'b', 'c'].forEach(tag => {
        comment = addProjectCommentTag(comment, tag);
    });
    assert.equal(comment.tags.length, 5);
    assert.throws(
        () => addProjectCommentTag(comment, 'overflow'),
        /limit/
    );

    const removed = removeProjectCommentTag(comment, 'BUG');
    assert.deepEqual(removed.tags, ['UX', 'a', 'b', 'c']);
    const noop = removeProjectCommentTag(comment, 'missing');
    assert.deepEqual(noop.tags, comment.tags);
});

test('PROJECT-COMMENTS-001 toggles status manually and editing never reopens a done note', () => {
    const open = makeComment();
    const done = setProjectCommentStatus(open, 'done', 2000);
    assert.equal(done.status, 'done');
    assert.equal(done.doneAt, 2000);

    const edited = updateProjectCommentText(done, 'rewritten', 3000);
    assert.equal(edited.status, 'done');
    assert.equal(edited.doneAt, 2000);
    assert.equal(edited.text, 'rewritten');
    assert.equal(edited.updatedAt, 3000);

    const reopened = setProjectCommentStatus(edited, 'open', 4000);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.doneAt, undefined);

    const unchanged = setProjectCommentStatus(reopened, 'open', 5000);
    assert.equal(unchanged.status, 'open');
    assert.equal(unchanged.doneAt, undefined);
});

test('PROJECT-COMMENTS-001 appends dispatch history without touching status and trims to the budget', () => {
    const comment = makeComment();
    const dispatched = recordProjectCommentDispatch(comment, {
        provider: 'kimi',
        sessionId: 'session-9',
        at: 6000,
    });
    assert.equal(dispatched.status, 'open');
    assert.deepEqual(dispatched.dispatches, [{
        provider: 'kimi',
        sessionId: 'session-9',
        at: 6000,
    }]);
    assert.deepEqual(comment.dispatches, []);

    let heavy = makeComment({
        dispatches: Array.from(
            { length: PROJECT_COMMENT_LIMITS.maxDispatchesPerComment },
            (_unused, index) => ({
                provider: 'codex',
                sessionId: 'session-' + index,
                at: index,
            })
        ),
    });
    heavy = recordProjectCommentDispatch(heavy, {
        provider: 'claude',
        sessionId: 'session-new',
        at: 9999,
    });
    assert.equal(
        heavy.dispatches.length,
        PROJECT_COMMENT_LIMITS.maxDispatchesPerComment
    );
    assert.equal(heavy.dispatches.at(-1).sessionId, 'session-new');
    assert.equal(heavy.dispatches[0].sessionId, 'session-1');
});

test('PROJECT-COMMENTS-001 builds the dispatch prompt with tag and source branches', () => {
    const plain = buildProjectCommentPrompt(makeComment({
        tags: [],
        source: undefined,
    }));
    assert.match(plain, /请处理下面这条项目笔记/);
    assert.match(plain, /\[项目笔记\]\nTelemetry overflows at 400px\./);
    assert.doesNotMatch(plain, /标签/);
    assert.doesNotMatch(plain, /出处/);

    const rich = buildProjectCommentPrompt(makeComment({
        tags: ['bug', 'UX'],
        source: {
            provider: 'codex',
            sessionId: 'session-1',
            quote: 'overflowed horizontally at 400px',
        },
    }));
    assert.match(rich, /\[项目笔记\]（标签：bug、UX）/);
    assert.match(rich, /出处（来自 codex session 的记录）：/);
    assert.match(rich, /```text\noverflowed horizontally at 400px\n```/);

    const sourceWithoutQuote = buildProjectCommentPrompt(makeComment({
        source: { provider: 'kimi', sessionId: 'session-2' },
    }));
    assert.match(sourceWithoutQuote, /出处（来自 kimi session 的记录）：/);
    assert.doesNotMatch(sourceWithoutQuote, /```/);
});

test('PROJECT-COMMENTS-001 reorders notes only through a full permutation', () => {
    const comments = [
        makeComment(),
        makeComment({ id: 'note-b', text: 'Second.' }),
        makeComment({ id: 'note-c', text: 'Third.' }),
    ];
    const reordered = reorderProjectComments(comments, [
        'note-c', 'note-a', 'note-b',
    ]);
    assert.deepEqual(
        reordered.map(comment => comment.id),
        ['note-c', 'note-a', 'note-b']
    );
    assert.deepEqual(
        comments.map(comment => comment.id),
        ['note-a', 'note-b', 'note-c']
    );

    assert.throws(
        () => reorderProjectComments(comments, ['note-a', 'note-b']),
        /invalid/
    );
    assert.throws(
        () => reorderProjectComments(comments, [
            'note-a', 'note-b', 'note-c', 'note-a',
        ]),
        /invalid/
    );
    assert.throws(
        () => reorderProjectComments(comments, [
            'note-a', 'note-b', 'missing',
        ]),
        /invalid/
    );
});

test('PROJECT-COMMENTS-001 enforces note count, unique ids, and the distinct tag vocabulary', () => {
    validateProjectComments([]);
    validateProjectComments([makeComment()]);

    assert.throws(
        () => validateProjectComments([
            makeComment(),
            makeComment({ text: 'duplicate id' }),
        ]),
        /invalid/
    );

    const tags = [];
    for (let index = 0; index < 20; index += 1) {
        tags.push('tag-' + index);
    }
    const vocabularyOk = [
        makeComment({ tags: tags.slice(0, 5) }),
        makeComment({ id: 'note-b', tags: tags.slice(5, 10) }),
        makeComment({ id: 'note-c', tags: tags.slice(10, 15) }),
        makeComment({ id: 'note-d', tags: tags.slice(15, 20) }),
    ];
    validateProjectComments(vocabularyOk);
    assert.deepEqual(
        collectProjectCommentTagVocabulary(vocabularyOk).length,
        20
    );
    assert.throws(
        () => validateProjectComments(vocabularyOk.concat([
            makeComment({ id: 'note-e', tags: ['tag-overflow'] }),
        ])),
        /invalid/
    );

    // Case-insensitive duplicates across the vocabulary count once.
    assert.deepEqual(
        collectProjectCommentTagVocabulary([
            makeComment({ tags: ['Bug'] }),
            makeComment({ id: 'note-b', tags: ['bug', 'UX'] }),
        ]),
        ['Bug', 'UX']
    );
});
