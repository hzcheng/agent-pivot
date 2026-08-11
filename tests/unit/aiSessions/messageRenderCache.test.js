'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationContentSignature,
    ConversationMessageRenderCache,
    createMessageRenderSignature,
} = require('../../../out/aiSessions/conversation/messageRenderCache');

function signature(overrides = {}) {
    return createMessageRenderSignature({
        sessionId: 'session-a',
        showThinking: false,
        responseState: 'complete',
        ...overrides,
    });
}

test('conversation message render cache serves repeat renders without re-rendering', () => {
    const cache = new ConversationMessageRenderCache();
    let renders = 0;
    const render = () => {
        renders += 1;
        return '<article>html</article>';
    };

    assert.equal(cache.render('input-1:user', signature(), render), '<article>html</article>');
    assert.equal(cache.render('input-1:user', signature(), render), '<article>html</article>');
    assert.equal(renders, 1);
});

test('conversation message render cache re-renders on any signature change', () => {
    const cache = new ConversationMessageRenderCache();
    let renders = 0;
    const render = () => `<article>${++renders}</article>`;
    const base = signature();

    cache.render('input-1:user', base, render);
    assert.equal(cache.render('input-1:user', signature({ showThinking: true }), render), '<article>2</article>');
    assert.equal(cache.render('input-1:user', signature({ responseState: 'inProgress' }), render), '<article>3</article>');
    assert.equal(cache.render('input-1:user', signature({
        clock: { label: '10:00', title: 'Today 10:00' },
    }), render), '<article>4</article>');
    assert.equal(cache.render('input-1:user', signature({
        clock: { label: '10:00', title: 'Today 10:00' },
    }), render), '<article>4</article>');
    // Another session reusing the same deterministic message id must miss.
    assert.equal(cache.render('input-1:user', signature({
        sessionId: 'session-b',
        clock: { label: '10:00', title: 'Today 10:00' },
    }), render), '<article>5</article>');
    assert.equal(renders, 5);
});

test('conversation message render cache invalidates every message of an interaction', () => {
    const cache = new ConversationMessageRenderCache();
    let renders = 0;
    const render = () => `<article>${++renders}</article>`;

    cache.render('input-1:user', signature(), render);
    cache.render('input-1:assistant:0', signature(), render);
    cache.render('input-2:user', signature(), render);
    assert.equal(renders, 3);

    cache.invalidateInteraction('input-1');
    assert.equal(cache.render('input-1:user', signature(), render), '<article>4</article>');
    assert.equal(cache.render('input-1:assistant:0', signature(), render), '<article>5</article>');
    assert.equal(cache.render('input-2:user', signature(), render), '<article>3</article>');
});

test('conversation message render cache evicts least recently used entries beyond the byte budget', () => {
    const cache = new ConversationMessageRenderCache(100);
    const render = value => () => value;

    cache.render('a:user', signature(), render('x'.repeat(40)));
    cache.render('b:user', signature(), render('y'.repeat(40)));
    // Touch a so b becomes the oldest entry.
    assert.equal(cache.render('a:user', signature(), render('ignored')), 'x'.repeat(40));
    cache.render('c:user', signature(), render('z'.repeat(40)));

    assert.equal(cache.size, 2);
    assert.equal(cache.render('b:user', signature(), render('new')), 'new');
    assert.equal(cache.trackedBytes <= 100, true);
});

test('conversation message render cache keeps the freshest entry even when it alone exceeds the budget', () => {
    const cache = new ConversationMessageRenderCache(10);
    cache.render('a:user', signature(), () => 'x'.repeat(50));
    assert.equal(cache.render('a:user', signature(), () => 'ignored'), 'x'.repeat(50));
    assert.equal(cache.size, 1);
});

test('conversation content signature tracks the ordered message stream', () => {
    const left = new ConversationContentSignature();
    const right = new ConversationContentSignature();
    const message = (id, role) => ({ id, role });

    left.mixMessage(message('input-1:user', 'user'), 'sig-a');
    right.mixMessage(message('input-1:user', 'user'), 'sig-a');
    assert.equal(left.toString(), right.toString());

    right.mixMessage(message('input-1:assistant:0', 'assistant'), 'sig-b');
    assert.notEqual(left.toString(), right.toString());

    const reordered = new ConversationContentSignature();
    reordered.mixMessage(message('input-1:assistant:0', 'assistant'), 'sig-b');
    reordered.mixMessage(message('input-1:user', 'user'), 'sig-a');
    assert.notEqual(left.toString(), reordered.toString());

    const worklog = new ConversationContentSignature();
    worklog.mixMessage(message('input-1:user', 'user'), 'sig-a');
    worklog.mix('input-1:worklog').mix('5200');
    assert.notEqual(left.toString(), worklog.toString());
});
