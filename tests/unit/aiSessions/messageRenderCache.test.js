'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ConversationContentSignatureRegistry,
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

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation message render cache serves repeat renders without re-rendering', () => {
    const cache = new ConversationMessageRenderCache();
    let renders = 0;
    const render = () => {
        renders += 1;
        return '<article>html</article>';
    };

    const first = cache.render('input-1:user', signature(), render);
    assert.equal(first.html, '<article>html</article>');
    const second = cache.render('input-1:user', signature(), render);
    assert.equal(second.html, '<article>html</article>');
    assert.equal(renders, 1);
    assert.equal(second.version, first.version,
        'a cache hit must keep the entry version stable');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation message render cache re-renders on any signature change and bumps the version', () => {
    const cache = new ConversationMessageRenderCache();
    let renders = 0;
    const render = () => `<article>${++renders}</article>`;

    const base = cache.render('input-1:user', signature(), render);
    const thinking = cache.render('input-1:user', signature({ showThinking: true }), render);
    assert.equal(thinking.html, '<article>2</article>');
    assert.ok(thinking.version > base.version);
    const state = cache.render('input-1:user', signature({ responseState: 'inProgress' }), render);
    assert.equal(state.html, '<article>3</article>');
    const clocked = cache.render('input-1:user', signature({
        clock: { label: '10:00', title: 'Today 10:00' },
    }), render);
    assert.equal(clocked.html, '<article>4</article>');
    assert.equal(cache.render('input-1:user', signature({
        clock: { label: '10:00', title: 'Today 10:00' },
    }), render).version, clocked.version);
    // Another session reusing the same deterministic message id must miss.
    const otherSession = cache.render('input-1:user', signature({
        sessionId: 'session-b',
        clock: { label: '10:00', title: 'Today 10:00' },
    }), render);
    assert.equal(otherSession.html, '<article>5</article>');
    assert.ok(otherSession.version > clocked.version);
    assert.equal(renders, 5);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation message render cache invalidates every message of an interaction', () => {
    const cache = new ConversationMessageRenderCache();
    let renders = 0;
    const render = () => `<article>${++renders}</article>`;

    cache.render('input-1:user', signature(), render);
    cache.render('input-1:assistant:0', signature(), render);
    const untouched = cache.render('input-2:user', signature(), render);
    assert.equal(renders, 3);

    cache.invalidateInteraction('input-1');
    const rerendered = cache.render('input-1:user', signature(), render);
    assert.equal(rerendered.html, '<article>4</article>');
    assert.ok(rerendered.version > untouched.version,
        'an invalidated re-render must advance the content version');
    assert.equal(cache.render('input-1:assistant:0', signature(), render).html, '<article>5</article>');
    assert.equal(cache.render('input-2:user', signature(), render).html, '<article>3</article>');
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation message render cache evicts least recently used entries beyond the byte budget', () => {
    const cache = new ConversationMessageRenderCache(100);
    const render = value => () => value;

    cache.render('a:user', signature(), render('x'.repeat(40)));
    cache.render('b:user', signature(), render('y'.repeat(40)));
    // Touch a so b becomes the oldest entry.
    assert.equal(cache.render('a:user', signature(), render('ignored')).html, 'x'.repeat(40));
    cache.render('c:user', signature(), render('z'.repeat(40)));

    assert.equal(cache.size, 2);
    assert.equal(cache.render('b:user', signature(), render('new')).html, 'new');
    assert.equal(cache.trackedBytes <= 100, true);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation message render cache keeps the freshest entry even when it alone exceeds the budget', () => {
    const cache = new ConversationMessageRenderCache(10);
    cache.render('a:user', signature(), () => 'x'.repeat(50));
    assert.equal(cache.render('a:user', signature(), () => 'ignored').html, 'x'.repeat(50));
    assert.equal(cache.size, 1);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation content signature registry mints collision-free tokens for exact streams', () => {
    const registry = new ConversationContentSignatureRegistry();
    const streamOf = (...parts) => JSON.stringify(parts);

    const first = registry.tokenFor(streamOf('input-1:user', 'user', 'sig-a', '1'));
    assert.equal(registry.tokenFor(streamOf('input-1:user', 'user', 'sig-a', '1')), first,
        'an identical render stream must reuse its token');
    const rerendered = registry.tokenFor(streamOf('input-1:user', 'user', 'sig-a', '2'));
    assert.notEqual(rerendered, first,
        'a re-rendered message must produce a different token');
    const reordered = registry.tokenFor(streamOf('input-1:assistant:0', 'assistant', 'sig-b', '2', 'input-1:user', 'user', 'sig-a', '1'));
    assert.notEqual(reordered, first);
    const withWorklog = registry.tokenFor(streamOf('input-1:user', 'user', 'sig-a', '1', 'input-1:worklog', '5200'));
    assert.notEqual(withWorklog, first);
});

test('CONVERSATION-LARGE-SESSION-PERFORMANCE-001 conversation content signature registry evicts least recently used streams beyond its bound', () => {
    const registry = new ConversationContentSignatureRegistry(2);
    const first = registry.tokenFor('stream-a');
    registry.tokenFor('stream-b');
    assert.equal(registry.tokenFor('stream-a'), first, 'recency touch');
    const third = registry.tokenFor('stream-c');

    assert.equal(registry.size, 2);
    const reminted = registry.tokenFor('stream-b');
    assert.notEqual(reminted, first,
        'an evicted stream mints a fresh token');
    assert.equal(registry.size, 2);
    assert.equal(registry.tokenFor('stream-c'), third,
        'a retained stream keeps its token');
});
