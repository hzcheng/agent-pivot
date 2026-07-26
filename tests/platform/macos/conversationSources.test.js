'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    openValidatedConversationSource,
    isConversationSourceContinuation,
} = require('../../../out/aiSessions/conversation/source');
const ClaudeSessionService =
    require('../../../out/services/claudeSessionService').default;

test('macOS native identity includes device, inode, and birth time', async t => {
    const root = await fs.promises.mkdtemp(path.join(
        os.tmpdir(),
        'steward-macos-conversation-source-'
    ));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const providerHome = path.join(root, 'provider-home');
    const sourcePath = path.join(providerHome, 'conversation.jsonl');
    await fs.promises.mkdir(providerHome, { recursive: true });
    await fs.promises.writeFile(sourcePath, '{"event":"first"}\n');

    const before = await openValidatedConversationSource({
        providerHome,
        sourcePath,
    });
    assert.ok(before);
    assert.match(before.identity, /^inode:/);
    assert.ok(Number.isFinite(before.device) && before.device > 0);
    assert.ok(Number.isFinite(before.inode) && before.inode > 0);
    assert.ok(Number.isFinite(before.birthtimeMs));

    await fs.promises.appendFile(sourcePath, '{"event":"second"}\n');
    const after = await openValidatedConversationSource({
        providerHome,
        sourcePath,
    });
    assert.ok(after);
    assert.equal(await isConversationSourceContinuation(before, after), true);
    assert.equal(await isConversationSourceContinuation(
        { ...before, birthtimeMs: before.birthtimeMs + 1 },
        after
    ), false);
    await before.handle.close();
    await after.handle.close();
});

test('provider source resolution normalizes uppercase Claude UUID input', async t => {
    const root = await fs.promises.mkdtemp(path.join(
        os.tmpdir(),
        'steward-macos-claude-conversation-source-'
    ));
    t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
    const claudeHome = path.join(root, 'claude-home');
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sourcePath = path.join(
        claudeHome,
        'projects',
        '-workspace',
        `${sessionId}.jsonl`
    );
    await fs.promises.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.promises.writeFile(sourcePath, `${JSON.stringify({
        sessionId,
        cwd: '/workspace',
    })}\n`);
    const previous = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = claudeHome;
    try {
        assert.deepEqual(
            new ClaudeSessionService().resolveConversationSource(
                sessionId.toUpperCase(),
                ['/workspace']
            ),
            { providerHome: claudeHome, sourcePath }
        );
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_HOME;
        else process.env.CLAUDE_HOME = previous;
    }
});
