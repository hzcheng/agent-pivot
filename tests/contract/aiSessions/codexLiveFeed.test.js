'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WebSocketServer } = require('ws');
const { CodexLiveFeed } = require('../../../out/aiSessions/conversation/codexLiveFeed');
const { CodexConversationAdapter } = require('../../../out/aiSessions/conversation/codexAdapter');
const { watchConversationTranscript } = require('../../../out/aiSessions/conversation/transcriptWatch');

async function until(predicate) {
    for (let i = 0; i < 200; i++) {
        if (predicate()) { return; }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail('condition did not settle');
}

async function harness(t, loaded = true, afterResume) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-live-'));
    const socketPath = path.join(directory, 's');
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const requests = [];
    let client;
    const turn = { id: 'turn-a', status: 'inProgress', items: [
        { id: 'user-a', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
    ] };
    wss.on('connection', socket => {
        client = socket;
        socket.on('message', data => {
            const request = JSON.parse(data);
            if (request.id === undefined) { return; }
            requests.push(request);
            let result = {};
            if (request.method === 'thread/loaded/list') { result = { data: loaded ? ['session-a'] : [], nextCursor: null }; }
            if (request.method === 'thread/resume') { result = { thread: { id: 'session-a', turns: [turn] } }; }
            socket.send(JSON.stringify({ id: request.id, result }));
            if (request.method === 'thread/resume') { afterResume?.(socket); }
        });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const feed = new CodexLiveFeed(socketPath);
    t.after(async () => {
        feed.dispose();
        wss.clients.forEach(socket => socket.terminate());
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return { feed, requests, turn, notify(method, params) {
        client.send(JSON.stringify({ method, params: { threadId: 'session-a', ...params } }));
    }, close() { client.terminate(); } };
}

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 live deltas reach the adapter before completion and reconcile with final items', { skip: process.platform === 'win32' }, async t => {
    const h = await harness(t);
    let invalidations = 0;
    const adapter = new CodexConversationAdapter({
        client: { async request() { return { thread: { id: 'session-a', turns: [h.turn] } }; }, dispose() {} },
        liveFeed: h.feed,
        watchSessionChanges: () => ({ dispose() {} }),
        readContentSignature: () => 'stable',
        setTimeout, clearTimeout,
    });
    t.after(() => adapter.dispose());
    const watch = adapter.watch('session-a', streaming => { if (streaming) { invalidations++; } });
    await until(() => h.feed.read('session-a'));
    const before = await adapter.readSnapshot('session-a');
    h.notify('item/started', { turnId: 'turn-a', item: { id: 'agent-a', type: 'agentMessage', text: '' } });
    h.notify('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'agent-a', delta: 'Hello 🌍' });
    await until(() => h.feed.read('session-a').turns[0].items.length === 2
        && h.feed.read('session-a').turns[0].items[1].text === 'Hello 🌍');
    const live = await adapter.readSnapshot('session-a');
    assert.notEqual(live.outline.sourceRevision, before.outline.sourceRevision);
    assert.ok(JSON.stringify(live.page).includes('Hello 🌍'));
    assert.equal(live.outline.interactions.length, 1);
    assert.equal(live.outline.interactions[0].responseState, 'inProgress');
    h.notify('item/completed', { turnId: 'turn-a', item: { id: 'agent-a', type: 'agentMessage', text: 'Hello 🌍 final' } });
    h.notify('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
    await until(() => h.feed.read('session-a').turns[0].status === 'completed');
    const final = await adapter.readSnapshot('session-a');
    assert.equal(final.outline.interactions[0].responseState, 'complete');
    assert.ok(JSON.stringify(final.page).includes('Hello 🌍 final'));
    assert.ok(invalidations >= 3);
    assert.deepEqual(h.requests.map(request => request.method), ['initialize', 'thread/loaded/list', 'thread/resume']);
    watch.dispose();
    assert.equal(h.feed.read('session-a'), undefined);
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 a mid-turn attach still receives deltas for items missing from the snapshot', { skip: process.platform === 'win32' }, async t => {
    // Verified against a real 0.155 companion: thread/resume mid-turn omits
    // the already-started agentMessage item from the turn snapshot, while
    // later deltas carry its real id. The feed must synthesize the item
    // from the method-scoped delta instead of dropping the stream.
    const h = await harness(t);
    let changes = 0;
    h.feed.watch('session-a', () => { changes++; });
    await until(() => h.feed.read('session-a'));
    assert.equal(h.feed.read('session-a').turns[0].items.length, 1,
        'the snapshot has only the user item');
    h.notify('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'agent-a', delta: 'Hello' });
    h.notify('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'agent-a', delta: ' there' });
    await until(() => h.feed.read('session-a').turns[0].items.length === 2
        && h.feed.read('session-a').turns[0].items[1].text === 'Hello there');
    h.notify('item/completed', { turnId: 'turn-a', item: { id: 'agent-a', type: 'agentMessage', text: 'Hello there, full text' } });
    await until(() => h.feed.read('session-a').turns[0].items[1].text === 'Hello there, full text');
    assert.ok(changes >= 3, 'deltas and completion each publish');
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 detach retains in-flight text and re-seeds the next attach snapshot', { skip: process.platform === 'win32' }, async t => {
    // Verified against a real 0.155 companion: the resume snapshot of a
    // running turn omits the already-started agentMessage item. Without
    // retention, switching away mid-turn loses everything already streamed.
    const h = await harness(t);
    let watch = h.feed.watch('session-a', () => {});
    await until(() => h.feed.read('session-a'));
    h.notify('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'agent-a', delta: 'streamed before detach' });
    await until(() => h.feed.read('session-a').turns[0].items[1]?.text === 'streamed before detach');
    watch.dispose();
    assert.equal(h.feed.read('session-a'), undefined, 'detach releases the live view');

    // Re-attach: the fresh snapshot still lacks the item, so the retained
    // text re-seeds it instead of reverting to the user message alone.
    watch = h.feed.watch('session-a', () => {});
    await until(() => h.feed.read('session-a')?.turns[0].items.length === 2);
    assert.equal(h.feed.read('session-a').turns[0].items[1].text, 'streamed before detach');

    // The stream continues from the retained prefix and completion still
    // replaces the item wholesale.
    h.notify('item/agentMessage/delta', { turnId: 'turn-a', itemId: 'agent-a', delta: ' + after reattach' });
    await until(() => h.feed.read('session-a').turns[0].items[1].text === 'streamed before detach + after reattach');
    h.notify('item/completed', { turnId: 'turn-a', item: { id: 'agent-a', type: 'agentMessage', text: 'final' } });
    h.notify('turn/completed', { turn: { id: 'turn-a', status: 'completed' } });
    await until(() => h.feed.read('session-a').turns[0].items[1].text === 'final');
    watch.dispose();
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 viewing an unloaded thread never resumes it', { skip: process.platform === 'win32' }, async t => {
    const h = await harness(t, false);
    h.feed.watch('session-a', () => {});
    await until(() => h.requests.length >= 2);
    assert.deepEqual(h.requests.map(request => request.method), ['initialize', 'thread/loaded/list']);
    assert.equal(h.feed.read('session-a'), undefined);
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 disconnect drops transient data and requests a durable refresh', { skip: process.platform === 'win32' }, async t => {
    const h = await harness(t);
    let calls = 0;
    h.feed.watch('session-a', () => { calls++; });
    await until(() => h.feed.read('session-a'));
    h.close();
    await until(() => !h.feed.read('session-a'));
    assert.equal(calls, 2);
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 watched transcript appends refresh immediately and stop after disposal', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-transcript-'));
    const file = path.join(dir, 'wire.jsonl');
    fs.writeFileSync(file, '{}\n');
    let calls = 0;
    const watcher = watchConversationTranscript(() => file, () => { calls++; });
    t.after(() => { watcher.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
    const initial = calls;
    fs.appendFileSync(file, '{"text":"new"}\n');
    await until(() => calls > initial);
    watcher.dispose();
    const finished = calls;
    fs.appendFileSync(file, '{}\n');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(calls, finished);
});


test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 resume response and immediate following deltas are not lost', { skip: process.platform === 'win32' }, async t => {
    const h = await harness(t, true, socket => {
        for (const [method, params] of [
            ['item/started', { item: { id: 'agent-a', type: 'agentMessage', text: '' } }],
            ['item/agentMessage/delta', { itemId: 'agent-a', delta: 'first' }],
            ['item/agentMessage/delta', { itemId: 'agent-a', delta: ' second' }],
        ]) {
            socket.send(JSON.stringify({ method, params: { threadId: 'session-a', turnId: 'turn-a', ...params } }));
        }
    });
    h.feed.watch('session-a', () => {});
    await until(() => h.feed.read('session-a')?.turns[0].items[1]?.text === 'first second');
});

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 oversized live tail falls back without an endless resume loop', { skip: process.platform === 'win32' }, async t => {
    const h = await harness(t, true, socket => {
        socket.send(JSON.stringify({ method: 'item/started', params: { threadId: 'session-a', turnId: 'turn-a',
            item: { id: 'oversized', type: 'agentMessage', text: 'x'.repeat(4 * 1024 * 1024) } } }));
    });
    h.feed.watch('session-a', () => {});
    await until(() => h.requests.length === 3);
    await new Promise(resolve => setTimeout(resolve, 3200));
    assert.equal(h.feed.read('session-a'), undefined);
    assert.equal(h.requests.filter(request => request.method === 'thread/resume').length, 1);
});


test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 stale disposal cannot remove a replacement subscription', { skip: process.platform === 'win32' }, async t => {
    const h = await harness(t);
    const previous = h.feed.watch('session-a', () => {});
    await until(() => h.feed.read('session-a'));
    previous.dispose();
    const replacement = h.feed.watch('session-a', () => {});
    previous.dispose();
    await until(() => h.feed.read('session-a'));
    replacement.dispose();
    assert.equal(h.feed.read('session-a'), undefined);
});
