'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openValidatedConversationSource, isConversationSourceContinuation } = require('../../../out/aiSessions/conversation/source');
const KimiSessionService = require('../../../out/services/kimiSessionService').default;
const CodexSessionService = require('../../../out/services/codexSessionService').default;
const ClaudeSessionService = require('../../../out/services/claudeSessionService').default;

const fixturesRoot = path.resolve(__dirname, '../../fixtures/providers');
const knownSessionId = '11111111-1111-4111-8111-111111111111';

async function withProviderFixture(t, provider, callback) {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), `steward-${provider}-conversation-source-`));
    const providerHome = path.join(sandbox, 'provider-home');
    await fs.promises.cp(path.join(fixturesRoot, provider, 'home'), providerHome, { recursive: true });
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));

    const environmentVariable = provider === 'codex' ? 'CODEX_HOME'
        : provider === 'kimi' ? 'KIMI_SHARE_DIR'
        : 'CLAUDE_HOME';
    const previousHome = process.env[environmentVariable];
    process.env[environmentVariable] = providerHome;
    try {
        await callback(providerHome);
    } finally {
        if (previousHome === undefined) {
            delete process.env[environmentVariable];
        } else {
            process.env[environmentVariable] = previousHome;
        }
    }
}

async function createClaudeDuplicateFixture(providerHome, sessionId, candidatePaths) {
    for (let index = 0; index < candidatePaths.length; index++) {
        const projectDirectory = path.join(providerHome, 'projects', `-duplicate-${index}`);
        await fs.promises.mkdir(projectDirectory, { recursive: true });
        await fs.promises.writeFile(
            path.join(projectDirectory, `${sessionId}.jsonl`),
            `${JSON.stringify({ sessionId, cwd: candidatePaths[index] })}\n`
        );
    }
}

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-001 resolves known sources and rejects escaped or ambiguous files', async t => {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'steward-conversation-source-'));
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const safeHome = path.join(sandbox, 'provider-home');
    const outside = path.join(sandbox, 'outside.jsonl');
    const escapedSymlink = path.join(safeHome, 'escaped.jsonl');
    await fs.promises.mkdir(safeHome, { recursive: true });
    await fs.promises.writeFile(outside, '{"outside":true}\n');
    await fs.promises.symlink(outside, escapedSymlink);

    await withProviderFixture(t, 'kimi', async () => {
        const kimi = new KimiSessionService();
        const kimiSource = kimi.resolveConversationSource(knownSessionId, ['/fixtures/project']);
        assert.match(kimiSource.sourcePath, /wire\.jsonl$/);

        const opened = await openValidatedConversationSource(kimiSource);
        assert.equal(opened.canonicalPath.startsWith(opened.canonicalProviderHome), true);
        await opened.handle.close();
    });

    const escaped = await openValidatedConversationSource({
        providerHome: safeHome,
        sourcePath: escapedSymlink,
    });
    assert.equal(escaped, null);

    await withProviderFixture(t, 'claude', async providerHome => {
        const claude = new ClaudeSessionService();
        const duplicateId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        await createClaudeDuplicateFixture(providerHome, duplicateId, [
            '/fixtures/project-a',
            '/fixtures/project-b',
        ]);
        assert.equal(
            claude.resolveConversationSource(duplicateId, ['/fixtures/project-a', '/fixtures/project-b']),
            null
        );
        assert.equal(
            claude.resolveConversationSource(duplicateId, ['/unmatched/workspace']),
            null
        );
    });
});

test('claude conversation source resolution reuses the scanned session-file index', async t => {
    await withProviderFixture(t, 'claude', async () => {
        const claude = new ClaudeSessionService();

        // First resolve scans the projects tree and indexes the session file.
        const first = claude.resolveConversationSource(knownSessionId, ['/fixtures/project']);
        assert.match(first.sourcePath, /11111111-1111-4111-8111-111111111111\.jsonl$/);

        let scans = 0;
        const originalGetSessionFiles = claude.getSessionFiles;
        claude.getSessionFiles = (...args) => {
            scans++;
            return originalGetSessionFiles.apply(claude, args);
        };

        // Indexed resolves must not rescan the tree on every conversation load.
        const second = claude.resolveConversationSource(knownSessionId, ['/fixtures/project']);
        assert.equal(second.sourcePath, first.sourcePath);
        assert.equal(scans, 0);

        // A candidate-path mismatch still declines through the full scan.
        assert.equal(claude.resolveConversationSource(knownSessionId, ['/unmatched/workspace']), null);
        assert.equal(scans, 1);
        scans = 0;

        // A disappeared file invalidates the index entry and rescans.
        await fs.promises.rm(first.sourcePath);
        assert.equal(claude.resolveConversationSource(knownSessionId, ['/fixtures/project']), null);
        assert.equal(scans, 1);
    });
});

test('claude conversation source resolution keeps declining indexed duplicates', async t => {
    await withProviderFixture(t, 'claude', async providerHome => {
        const claude = new ClaudeSessionService();
        const duplicateId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
        await createClaudeDuplicateFixture(providerHome, duplicateId, [
            '/fixtures/project-a',
            '/fixtures/project-b',
        ]);

        // The first resolve scans, records the duplicate, and declines.
        assert.equal(claude.resolveConversationSource(duplicateId, []), null);
        // A cached fast path must never resolve an ambiguous session id.
        assert.equal(claude.resolveConversationSource(duplicateId, []), null);

        // Once only one file remains, a rescan resolves it again.
        const remaining = path.join(providerHome, 'projects', '-duplicate-1', `${duplicateId}.jsonl`);
        await fs.promises.rm(path.join(providerHome, 'projects', '-duplicate-0', `${duplicateId}.jsonl`));
        const resolved = claude.resolveConversationSource(duplicateId, []);
        assert.equal(resolved.sourcePath, remaining);
    });
});

test('claude conversation source fast path self-corrects when a duplicate appears after indexing', async t => {
    await withProviderFixture(t, 'claude', async providerHome => {
        const claude = new ClaudeSessionService();

        // Index the fixture sessions, then resolve through the fast path.
        const indexed = claude.resolveConversationSource(knownSessionId, ['/fixtures/project']);
        assert.ok(indexed?.sourcePath);

        // A duplicate appearing after the indexing scan is served from the
        // index until the next scan observes it (documented window).
        const projectDirectory = path.join(providerHome, 'projects', '-duplicate-late');
        await fs.promises.mkdir(projectDirectory, { recursive: true });
        await fs.promises.writeFile(
            path.join(projectDirectory, `${knownSessionId}.jsonl`),
            `${JSON.stringify({ sessionId: knownSessionId, cwd: '/fixtures/project' })}\n`
        );
        assert.equal(
            claude.resolveConversationSource(knownSessionId, ['/fixtures/project'])?.sourcePath,
            indexed.sourcePath
        );

        // The next scan marks the id ambiguous and the resolver declines.
        claude.getSessions(true);
        assert.equal(
            claude.resolveConversationSource(knownSessionId, ['/fixtures/project']),
            null
        );
    });
});

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-002 revalidates opened files and distinguishes replacement from append continuation', async t => {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'steward-conversation-identity-'));
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const providerHome = path.join(sandbox, 'provider-home');
    const sourcePath = path.join(providerHome, 'conversation.jsonl');
    const outside = path.join(sandbox, 'outside.jsonl');
    const initial = '{"event":"a"}\n';
    await fs.promises.mkdir(providerHome, { recursive: true });
    await fs.promises.writeFile(sourcePath, initial);
    await fs.promises.writeFile(outside, '{"outside":true}\n');

    const originalStat = await fs.promises.stat(sourcePath);
    const portableBefore = await openValidatedConversationSource(
        { providerHome, sourcePath },
        { forcePortableIdentity: true }
    );
    await fs.promises.writeFile(sourcePath, '{"event":"b"}\n');
    await fs.promises.utimes(sourcePath, originalStat.atime, originalStat.mtime);
    const portableReplacement = await openValidatedConversationSource(
        { providerHome, sourcePath },
        { forcePortableIdentity: true }
    );
    assert.notEqual(portableReplacement.identity, portableBefore.identity);
    assert.equal(await isConversationSourceContinuation(portableBefore, portableReplacement), false);
    await portableBefore.handle.close();
    await portableReplacement.handle.close();

    await fs.promises.writeFile(sourcePath, initial);
    const portableAppendBefore = await openValidatedConversationSource(
        { providerHome, sourcePath },
        { forcePortableIdentity: true }
    );
    const nativeAppendBefore = await openValidatedConversationSource({ providerHome, sourcePath });
    await fs.promises.appendFile(sourcePath, '{"event":"next"}\n');
    const portableAppendAfter = await openValidatedConversationSource(
        { providerHome, sourcePath },
        { forcePortableIdentity: true }
    );
    const nativeAppendAfter = await openValidatedConversationSource({ providerHome, sourcePath });
    assert.equal(await isConversationSourceContinuation(portableAppendBefore, portableAppendAfter), true);
    assert.equal(await isConversationSourceContinuation(nativeAppendBefore, nativeAppendAfter), true);
    assert.equal(await isConversationSourceContinuation(
        { ...nativeAppendBefore, birthtimeMs: nativeAppendBefore.birthtimeMs + 1 },
        nativeAppendAfter
    ), false);
    await portableAppendBefore.handle.close();
    await nativeAppendBefore.handle.close();
    await portableAppendAfter.handle.close();
    await nativeAppendAfter.handle.close();

    await fs.promises.writeFile(sourcePath, initial);
    const replaceWithOutsideSymlink = async (resolvedPath, flags) => {
        await fs.promises.unlink(resolvedPath);
        await fs.promises.symlink(outside, resolvedPath);
        return fs.promises.open(resolvedPath, flags);
    };
    assert.equal(await openValidatedConversationSource(
        { providerHome, sourcePath },
        { openFile: replaceWithOutsideSymlink }
    ), null);

    await fs.promises.unlink(sourcePath);
    await fs.promises.writeFile(sourcePath, initial);
    assert.equal(await openValidatedConversationSource(
        { providerHome, sourcePath },
        { noFollowFlag: 0, openFile: replaceWithOutsideSymlink }
    ), null);
});

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-004 rejects an opened handle after an ancestor symlink race is restored', async t => {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'steward-conversation-ancestor-race-'));
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const providerHome = path.join(sandbox, 'provider-home');
    const sourceDirectory = path.join(providerHome, 'nested');
    const sourcePath = path.join(sourceDirectory, 'conversation.jsonl');
    const outsideDirectory = path.join(sandbox, 'outside');
    const preservedDirectory = path.join(providerHome, 'nested-preserved');
    await fs.promises.mkdir(sourceDirectory, { recursive: true });
    await fs.promises.mkdir(outsideDirectory, { recursive: true });
    await fs.promises.writeFile(sourcePath, '{"inside":true}\n');
    await fs.promises.writeFile(path.join(outsideDirectory, 'conversation.jsonl'), '{"outside":true}\n');

    const swapAncestorOnlyWhileOpening = async (resolvedPath, flags) => {
        await fs.promises.rename(sourceDirectory, preservedDirectory);
        await fs.promises.symlink(outsideDirectory, sourceDirectory);
        const handle = await fs.promises.open(resolvedPath, flags);
        await fs.promises.unlink(sourceDirectory);
        await fs.promises.rename(preservedDirectory, sourceDirectory);
        return handle;
    };
    const opened = await openValidatedConversationSource(
        { providerHome, sourcePath },
        {
            noFollowFlag: fs.constants.O_NOFOLLOW || 0,
            openFile: swapAncestorOnlyWhileOpening,
        }
    );
    await opened?.handle.close();
    assert.equal(opened, null);
});

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-005 rejects an in-place same-inode rewrite that regrows', async t => {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'steward-conversation-inode-rewrite-'));
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const providerHome = path.join(sandbox, 'provider-home');
    const sourcePath = path.join(providerHome, 'conversation.jsonl');
    const original = Buffer.concat([
        Buffer.alloc(64 * 1024, 'a'),
        Buffer.alloc(8 * 1024, 'b'),
    ]);
    await fs.promises.mkdir(providerHome, { recursive: true });
    await fs.promises.writeFile(sourcePath, original);

    const before = await openValidatedConversationSource({ providerHome, sourcePath });
    const rewriteHandle = await fs.promises.open(sourcePath, 'w');
    await rewriteHandle.write(Buffer.alloc(original.length + 1024, 'z'));
    await rewriteHandle.close();
    const after = await openValidatedConversationSource({ providerHome, sourcePath });
    assert.equal(before.device, after.device);
    assert.equal(before.inode, after.inode);
    assert.equal(before.birthtimeMs, after.birthtimeMs);
    assert.equal(after.size >= before.size, true);
    assert.equal(await isConversationSourceContinuation(before, after), false);
    await before.handle.close();
    await after.handle.close();
});

test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-003 Codex exposes no filesystem conversation content resolver', async t => {
    await withProviderFixture(t, 'codex', async () => {
        assert.equal(
            typeof new CodexSessionService().resolveConversationSource,
            'undefined'
        );
    });
});
