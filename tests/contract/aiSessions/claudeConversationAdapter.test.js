'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ClaudeConversationAdapter } = require('../../../out/aiSessions/conversation/claudeAdapter');
const { CONVERSATION_LIMITS } = require('../../../out/aiSessions/conversation/types');

const fixturePath = path.resolve(
    __dirname,
    '../../fixtures/conversations/claude/session.jsonl'
);
const sessionId = '22222222-2222-4222-8222-222222222222';

function immediateTimers() {
    return {
        setTimeout(callback) {
            callback();
            return 1;
        },
        clearTimeout() {},
    };
}

async function createFixture(t) {
    const providerHome = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'steward-claude-conversation-')
    );
    const sourcePath = path.join(providerHome, 'session.jsonl');
    await fs.promises.copyFile(fixturePath, sourcePath);
    t.after(() => fs.promises.rm(providerHome, { recursive: true, force: true }));
    return { providerHome, sourcePath };
}

function createAdapter(source, overrides = {}) {
    return new ClaudeConversationAdapter({
        resolveSource: () => source,
        watchSessionChanges: () => ({ dispose() {} }),
        now: Date.now,
        ...immediateTimers(),
        ...overrides,
    });
}

async function readWholeConversation(adapter) {
    const outline = await adapter.readOutline(sessionId);
    const page = await adapter.readPage({
        provider: 'claude',
        sessionId,
        anchorInteractionId: outline.interactions[0].id,
        direction: 'around',
    });
    return { outline, page };
}

test('SESSION-AI-SESSION-CONVERSATION-ADAPTER-001 Claude normalizes only top-level visible user and assistant text', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.deepEqual(outline.interactions.map(item => item.userPreview), [
        'Explain the parser',
        'Review [Attachment]',
        '[2 Attachments]',
    ]);
    assert.deepEqual(
        outline.interactions.map(item => item.id),
        ['claude-user-1', 'claude-user-2', 'claude-user-3']
    );
    assert.equal(page.messages.filter(message => message.role === 'assistant').length, 3);
    assert.equal(
        page.messages.some(message =>
            /tool_result|secret-thought|local\/path|private\.invalid/.test(message.markdown)
        ),
        false
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-002 excludes assistant tool blocks and synthetic user-role tool results', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const { outline, page } = await readWholeConversation(adapter);
    assert.equal(
        outline.interactions.some(item => item.id.startsWith('synthetic-')),
        false
    );
    assert.equal(page.messages.filter(message => message.role === 'assistant').length, 3);
    assert.equal(
        page.messages.some(message => /read_file|search/.test(message.markdown)),
        false
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-003 parses append-only suffixes without changing prior UUID identities', async t => {
    const source = await createFixture(t);
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());

    const first = await adapter.readOutline(sessionId);
    const unchanged = await adapter.readOutline(sessionId);
    assert.equal(unchanged.sourceRevision, first.sourceRevision);
    const originalIds = first.interactions.map(item => item.id);
    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'user',
            uuid: 'claude-user-4',
            message: { role: 'user', content: [{ type: 'text', text: 'Describe the suffix' }] },
        })}\n`
    );
    const appended = await adapter.readOutline(sessionId);
    assert.notEqual(appended.sourceRevision, first.sourceRevision);
    assert.deepEqual(
        appended.interactions.slice(0, originalIds.length).map(item => item.id),
        originalIds
    );
    assert.deepEqual(
        appended.interactions.map(item => item.userPreview),
        [
            'Explain the parser',
            'Review [Attachment]',
            '[2 Attachments]',
            'Describe the suffix',
        ]
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-004 surfaces timeout when no interaction was completed', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        Buffer.alloc(CONVERSATION_LIMITS.readChunkBytes + 1, 0x20)
    );
    let clockReads = 0;
    const adapter = createAdapter(source, {
        now() {
            clockReads += 1;
            return clockReads <= 3 ? 0 : CONVERSATION_LIMITS.jsonlScanTimeoutMs;
        },
    });
    t.after(() => adapter.dispose());

    await assert.rejects(
        adapter.readOutline(sessionId),
        error => error.name === 'ConversationError' && error.code === 'timeout'
    );
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-005 keeps provider caches and watches independently disposable', async t => {
    const source = await createFixture(t);
    let providerCallback;
    let providerDisposeCount = 0;
    const adapter = createAdapter(source, {
        watchSessionChanges(callback) {
            providerCallback = callback;
            return { dispose() { providerDisposeCount += 1; } };
        },
    });
    await adapter.readOutline(sessionId);
    let changes = 0;
    const watched = adapter.watch(sessionId, () => { changes += 1; });
    providerCallback();
    assert.equal(changes, 1);
    watched.dispose();
    assert.equal(providerDisposeCount, 1);
    adapter.dispose();
    assert.equal(providerDisposeCount, 1);
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-006 attaches a later assistant suffix to the completed EOF interaction', async t => {
    const source = await createFixture(t);
    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'user',
            uuid: 'claude-live-user',
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Follow the response' }],
            },
        })}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const first = await adapter.readOutline(sessionId);
    assert.equal(first.interactions[0].responseState, 'complete');

    await fs.promises.appendFile(
        source.sourcePath,
        `${JSON.stringify({
            type: 'assistant',
            uuid: 'claude-live-assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Visible suffix response' }],
            },
        })}\n`
    );
    const second = await adapter.readPage({
        provider: 'claude',
        sessionId,
        anchorInteractionId: 'claude-live-user',
        direction: 'around',
    });
    assert.deepEqual(
        second.messages.map(message => [message.role, message.markdown]),
        [
            ['user', 'Follow the response'],
            ['assistant', 'Visible suffix response'],
        ]
    );
    assert.notEqual(second.sourceRevision, first.sourceRevision);
});

test('SESSION-AI-SESSION-CLAUDE-CONVERSATION-007 changes revision after a same-size same-mtime source rewrite', async t => {
    const source = await createFixture(t);
    const firstRecord = {
        type: 'user',
        uuid: 'claude-rewritten-user',
        message: {
            role: 'user',
            content: [{ type: 'text', text: 'Alpha' }],
        },
    };
    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify(firstRecord)}\n`
    );
    const adapter = createAdapter(source);
    t.after(() => adapter.dispose());
    const first = await adapter.readOutline(sessionId);
    const statBeforeReset = await fs.promises.stat(source.sourcePath);

    await fs.promises.writeFile(
        source.sourcePath,
        `${JSON.stringify({
            ...firstRecord,
            message: {
                role: 'user',
                content: [{ type: 'text', text: 'Bravo' }],
            },
        })}\n`
    );
    await fs.promises.utimes(
        source.sourcePath,
        statBeforeReset.atimeMs / 1000,
        statBeforeReset.mtimeMs / 1000
    );
    const rebuilt = await adapter.readOutline(sessionId);
    assert.equal(rebuilt.interactions[0].userPreview, 'Bravo');
    assert.notEqual(rebuilt.sourceRevision, first.sourceRevision);
});
