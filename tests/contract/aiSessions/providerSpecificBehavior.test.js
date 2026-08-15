'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');
const helpers = require('../../../out/aiSessions/sessionHelpers');
const providers = require('../../../out/aiSessions/providers');
const CodexSessionService = require('../../../out/services/codexSessionService').default;
const KimiSessionService = require('../../../out/services/kimiSessionService').default;
const ClaudeSessionService = require('../../../out/services/claudeSessionService').default;

function setEnvironment(t, name, value) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
    });
}

function writeCodexSessionMetaFile(sessionsDir, sessionId, payload) {
    const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, `${JSON.stringify({
        timestamp: payload.timestamp,
        type: 'session_meta',
        payload,
    })}\n`, 'utf8');
    return sessionFile;
}

function loadTerminalService() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return { window: { terminals: [], createTerminal() {}, showWarningMessage() {} } };
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve('../../../out/aiSessions/terminalService')];
        return require('../../../out/aiSessions/terminalService').default;
    } finally {
        Module._load = previousLoad;
    }
}

test('SESSION-CODEX-SUBAGENT-SESSION-FILTER-001 excludes subagent and headless sessions and rejects their restored terminals', t => {
    const root = makeTempDirectory(t, 'provider-codex-filter-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '13');
    const indexedNormalId = '11111111-1111-4111-8111-111111111111';
    const indexedSubagentId = '22222222-2222-4222-8222-222222222222';
    const fileNormalId = '33333333-3333-4333-8333-333333333333';
    const fileSubagentId = '44444444-4444-4444-8444-444444444444';
    const parentOnlyId = '55555555-5555-4555-8555-555555555555';
    const malformedIndexedId = '66666666-6666-4666-8666-666666666666';
    const indexedExecId = '77777777-7777-4777-8777-777777777777';
    const fileExecId = '88888888-8888-4888-8888-888888888888';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const writeMeta = (sessionId, timestamp, extra = {}) => writeCodexSessionMetaFile(
        sessionsDir,
        sessionId,
        { id: sessionId, session_id: sessionId, cwd: '/work/app', timestamp, ...extra }
    );

    writeMeta(indexedNormalId, '2026-07-13T01:00:00.000Z', { source: 'vscode' });
    const indexedSubagentFile = writeMeta(indexedSubagentId, '2026-07-13T02:00:00.000Z', {
        source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
        parent_thread_id: indexedNormalId,
    });
    writeMeta(fileNormalId, '2026-07-13T03:00:00.000Z', { source: 'vscode' });
    const fileSubagentFile = writeMeta(fileSubagentId, '2026-07-13T04:00:00.000Z', {
        source: { subagent: { thread_spawn: { parent_thread_id: indexedNormalId, depth: 1 } } },
        parent_thread_id: indexedNormalId,
    });
    writeMeta(parentOnlyId, '2026-07-13T05:00:00.000Z', {
        source: 'vscode', parent_thread_id: indexedNormalId,
    });
    const indexedExecFile = writeMeta(indexedExecId, '2026-07-13T06:00:00.000Z', {
        source: 'exec', originator: 'codex_exec', thread_source: 'user',
    });
    const fileExecFile = writeMeta(fileExecId, '2026-07-13T07:00:00.000Z', {
        source: 'exec', originator: 'codex_exec', thread_source: 'user',
    });
    fs.writeFileSync(path.join(sessionsDir, `${malformedIndexedId}.jsonl`), 'not-json\n', 'utf8');
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), [
        { id: indexedNormalId, thread_name: 'Parent', updated_at: '2026-07-13T01:00:00.000Z' },
        { id: indexedSubagentId, thread_name: 'Worker', updated_at: '2026-07-13T02:00:00.000Z' },
        { id: malformedIndexedId, thread_name: 'Index fallback', updated_at: '2026-07-13T06:00:00.000Z' },
        { id: indexedExecId, thread_name: 'Headless review', updated_at: '2026-07-13T07:00:00.000Z' },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'utf8');

    const result = new CodexSessionService().getSessions();
    assert.equal(result.available, true);
    assert.deepEqual(new Set(result.sessions.map(session => session.id)), new Set([
        indexedNormalId, fileNormalId, parentOnlyId, malformedIndexedId,
    ]));
    for (const excludedFile of [indexedSubagentFile, fileSubagentFile, indexedExecFile, fileExecFile]) {
        assert.equal(fs.existsSync(excludedFile), true, 'filtering must not mutate provider files');
    }

    const assignments = helpers.assignAiSessionsToProjects(
        [{ project: { id: 'app' }, path: '/work/app' }],
        result.sessions,
        session => session.cwd
    );
    assert.deepEqual(new Set((assignments.get('app') || []).map(session => session.id)), new Set([
        indexedNormalId, fileNormalId, parentOnlyId,
    ]));

    const AiSessionTerminalService = loadTerminalService();
    const terminalService = new AiSessionTerminalService(
        path.join(root, 'storage'),
        providers.AI_SESSION_PROVIDER_IDS.map(providers.getAiSessionProviderDefinition),
        0
    );
    const restoredSubagent = {
        name: 'Codex restored',
        creationOptions: { env: { AGENT_PIVOT_CODEX_SESSION_ID: indexedSubagentId } },
    };
    assert.equal(terminalService.resolveTerminalSession(restoredSubagent, () => result.sessions), null);
});

test('SESSION-CODEX-SESSION-ACTIVITY-TIMESTAMP-001 uses the session JSONL mtime as activity advances', t => {
    const root = makeTempDirectory(t, 'provider-codex-activity-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '14');
    const sessionId = '77777777-7777-4777-8777-777777777777';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/app',
        timestamp: '2026-07-14T01:00:00.000Z', source: 'vscode',
    });
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), `${JSON.stringify({
        id: sessionId, thread_name: 'Active session', updated_at: '2026-07-14T02:00:00.000Z',
    })}\n`, 'utf8');

    const firstActivityAt = new Date('2026-07-14T03:00:00.000Z');
    fs.utimesSync(sessionFile, firstActivityAt, firstActivityAt);
    const service = new CodexSessionService();
    assert.equal(service.getSessions(true).sessions[0].updatedAt, firstActivityAt.toISOString());

    fs.appendFileSync(sessionFile, '{"type":"event"}\n', 'utf8');
    const secondActivityAt = new Date('2026-07-14T04:00:00.000Z');
    fs.utimesSync(sessionFile, secondActivityAt, secondActivityAt);
    assert.equal(service.getSessions(true).sessions[0].updatedAt, secondActivityAt.toISOString());
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 Codex exposes the stable creation time apart from activity', t => {
    const root = makeTempDirectory(t, 'provider-codex-created-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '14');
    const sessionId = '88888888-8888-4888-8888-888888888888';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/app',
        timestamp: '2026-07-14T01:00:00.000Z', source: 'vscode',
    });
    const laterActivity = new Date('2026-07-15T03:00:00.000Z');
    fs.utimesSync(sessionFile, laterActivity, laterActivity);

    const session = new CodexSessionService().getSessions(true).sessions[0];
    assert.equal(session.createdAt, '2026-07-14T01:00:00.000Z',
        'createdAt is the rollout session_meta timestamp');
    assert.equal(session.updatedAt, laterActivity.toISOString(),
        'updatedAt still floats with file activity');
});

test('PERSIST-CODEX-SESSION-META-CACHE-001 reuses unchanged metadata and index reads, then invalidates each by signature', t => {
    const root = makeTempDirectory(t, 'provider-codex-meta-cache-');
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '16');
    const sessionId = '88888888-8888-4888-8888-888888888888';
    setEnvironment(t, 'CODEX_HOME', root);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/app',
        timestamp: '2026-07-16T01:00:00.000Z', source: 'vscode',
    });
    const indexPath = path.join(root, 'session_index.jsonl');
    fs.writeFileSync(indexPath, `${JSON.stringify({
        id: sessionId, thread_name: 'Cached Index', updated_at: '2026-07-16T02:00:00.000Z',
    })}\n`, 'utf8');

    const originalOpenSync = fs.openSync;
    const originalReadFileSync = fs.readFileSync;
    let sessionMetaOpenCount = 0;
    let sessionIndexReadCount = 0;
    fs.openSync = function (filePath) {
        if (filePath === sessionFile) sessionMetaOpenCount++;
        return originalOpenSync.apply(this, arguments);
    };
    fs.readFileSync = function (filePath) {
        if (filePath === indexPath) sessionIndexReadCount++;
        return originalReadFileSync.apply(this, arguments);
    };
    t.after(() => {
        fs.openSync = originalOpenSync;
        fs.readFileSync = originalReadFileSync;
    });

    const service = new CodexSessionService();
    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].name, 'Cached Index');
    const firstMetaReads = sessionMetaOpenCount;
    const firstIndexReads = sessionIndexReadCount;
    assert.ok(firstMetaReads > 0);
    assert.ok(firstIndexReads > 0);

    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].id, sessionId);
    assert.equal(sessionMetaOpenCount, firstMetaReads, 'unchanged metadata must stay cached');
    assert.equal(sessionIndexReadCount, firstIndexReads, 'unchanged index must stay cached');

    writeCodexSessionMetaFile(sessionsDir, sessionId, {
        id: sessionId, session_id: sessionId, cwd: '/work/renamed-and-longer',
        timestamp: '2026-07-16T03:00:00.000Z', source: 'vscode',
    });
    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].cwd, '/work/renamed-and-longer');
    assert.ok(sessionMetaOpenCount > firstMetaReads, 'changed metadata signature must reread disk');

    fs.writeFileSync(indexPath, `${JSON.stringify({
        id: sessionId, thread_name: 'Changed Index Name', updated_at: '2026-07-16T04:00:00.000Z',
    })}\n`, 'utf8');
    assert.equal(service.getSessions({ forceRefresh: true }).sessions[0].name, 'Changed Index Name');
    assert.ok(sessionIndexReadCount > firstIndexReads, 'changed index signature must reread disk');
});

test('SESSION-KIMI-NESTED-SUBAGENT-BOUNDARY-001 discovers only UUID directories at the work-dir session boundary', t => {
    const root = makeTempDirectory(t, 'provider-kimi-subagents-');
    const workDir = '/work/app';
    const sessionId = '77777777-7777-4777-8777-777777777777';
    setEnvironment(t, 'KIMI_SHARE_DIR', root);
    fs.writeFileSync(path.join(root, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: workDir }] }), 'utf8');
    const workDirHash = crypto.createHash('md5').update(workDir, 'utf8').digest('hex');
    const sessionDir = path.join(root, 'sessions', workDirHash, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}', 'utf8');
    const nested = path.join(sessionDir, 'subagents', 'a12345678');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'wire.jsonl'), '{}\n', 'utf8');

    const result = new KimiSessionService().getSessions({ candidatePaths: [workDir] });
    assert.equal(result.available, true);
    assert.deepEqual(result.sessions.map(session => session.id), [sessionId]);
    assert.equal(result.scannedFiles, 1);
});

test('WORKTREE-GROUPS-HISTORY-IDENTITY-001 Claude derives createdAt from the first event and Kimi stays degradable', t => {
    const root = makeTempDirectory(t, 'provider-claude-created-');
    const sessionId = '99999999-9999-4999-8999-999999999999';
    setEnvironment(t, 'CLAUDE_HOME', root);
    const sessionDir = path.join(root, 'projects', '-work-app');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, `${sessionId}.jsonl`), [
        JSON.stringify({ type: 'system', sessionId }),
        JSON.stringify({
            type: 'user', sessionId, cwd: '/work/app',
            timestamp: '2026-07-10T08:00:00.000Z',
            message: { role: 'user', content: 'hello' },
        }),
        JSON.stringify({
            type: 'assistant', sessionId,
            timestamp: '2026-07-10T09:00:00.000Z',
            message: { role: 'assistant', content: 'hi' },
        }),
        '',
    ].join('\n'), 'utf8');

    const claude = new ClaudeSessionService().getSessions({ candidatePaths: ['/work/app'] });
    assert.equal(claude.sessions[0].createdAt, '2026-07-10T08:00:00.000Z',
        'the first valid event timestamp is the stable creation time');
    assert.equal(claude.sessions[0].updatedAt, '2026-07-10T09:00:00.000Z');

    const kimiRoot = makeTempDirectory(t, 'provider-kimi-created-');
    const kimiWorkDir = '/work/app';
    setEnvironment(t, 'KIMI_SHARE_DIR', kimiRoot);
    fs.writeFileSync(path.join(kimiRoot, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: kimiWorkDir }] }), 'utf8');
    const hash = crypto.createHash('md5').update(kimiWorkDir, 'utf8').digest('hex');
    const kimiSessionDir = path.join(kimiRoot, 'sessions', hash, sessionId);
    fs.mkdirSync(kimiSessionDir, { recursive: true });
    fs.writeFileSync(path.join(kimiSessionDir, 'wire.jsonl'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(kimiSessionDir, 'state.json'), '{}', 'utf8');
    const kimi = new KimiSessionService().getSessions({ candidatePaths: [kimiWorkDir] });
    assert.equal(kimi.sessions[0].createdAt, undefined,
        'Kimi exposes no stable creation time: generation judgment fails closed');
});

test('SESSION-CLAUDE-SESSION-001 finds cwd in the middle of a large top-level file and excludes nested subagents', t => {
    const root = makeTempDirectory(t, 'provider-claude-session-');
    const sessionId = '11111111-1111-4111-8111-111111111111';
    setEnvironment(t, 'CLAUDE_HOME', root);
    const sessionDir = path.join(root, 'projects', '-work-app');
    fs.mkdirSync(sessionDir, { recursive: true });
    const fillerLine = `${JSON.stringify({
        type: 'assistant', message: { role: 'assistant', content: 'x'.repeat(4096) },
    })}\n`;
    const cwdLine = `${JSON.stringify({
        sessionId, cwd: '/work/app', timestamp: '2026-01-01T00:00:00.000Z',
    })}\n`;
    fs.writeFileSync(
        path.join(sessionDir, `${sessionId}.jsonl`),
        fillerLine.repeat(40) + cwdLine + fillerLine.repeat(40),
        'utf8'
    );
    const nestedSubagentDir = path.join(sessionDir, sessionId, 'subagents');
    fs.mkdirSync(nestedSubagentDir, { recursive: true });
    fs.writeFileSync(path.join(nestedSubagentDir, 'agent-a1234567890abcdef.jsonl'), cwdLine, 'utf8');

    const result = new ClaudeSessionService().getSessions({ candidatePaths: ['/work/app'] });
    assert.equal(result.available, true);
    assert.deepEqual(result.sessions.map(session => session.id), [sessionId]);
    assert.equal(result.sessions[0].cwd, '/work/app');
    assert.equal(result.scannedFiles, 1);
});

test('SESSION-CLAUDE-SUBAGENT-LIFECYCLE-001 keeps Claude running while any background subagent is active', t => {
    const root = makeTempDirectory(t, 'provider-claude-lifecycle-subagents-');
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const runStartedAtMs = Date.parse('2026-07-31T07:00:00.000Z');
    setEnvironment(t, 'CLAUDE_HOME', root);
    const sessionDir = path.join(root, 'projects', '-work-app');
    const sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    const subagentDir = path.join(sessionDir, sessionId, 'subagents');
    fs.mkdirSync(subagentDir, { recursive: true });
    fs.writeFileSync(sessionFile, [{
        sessionId,
        cwd: '/work/app',
        timestamp: '2026-07-31T07:00:01.000Z',
        type: 'user',
        uuid: 'main-user',
        message: { role: 'user', content: 'Run parallel reviews.' },
    }, {
        sessionId,
        timestamp: '2026-07-31T07:00:05.000Z',
        type: 'assistant',
        uuid: 'main-waiting',
        message: {
            role: 'assistant',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Waiting for reviewers.' }],
        },
    }].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    const completedSubagent = path.join(
        subagentDir,
        'agent-a1111111111111111.jsonl'
    );
    fs.writeFileSync(completedSubagent, [{
        timestamp: '2026-07-31T07:00:02.000Z',
        type: 'user',
        uuid: 'completed-user',
        message: { role: 'user', content: 'Review one.' },
    }, {
        timestamp: '2026-07-31T07:00:03.000Z',
        type: 'assistant',
        uuid: 'completed-assistant',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
    }].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    const runningSubagent = path.join(
        subagentDir,
        'agent-a2222222222222222.jsonl'
    );
    fs.writeFileSync(runningSubagent, [{
        timestamp: '2026-07-31T07:00:04.000Z',
        type: 'user',
        uuid: 'running-user',
        message: { role: 'user', content: 'Review two.' },
    }, {
        timestamp: '2026-07-31T07:00:06.000Z',
        type: 'assistant',
        uuid: 'running-assistant',
        message: {
            role: 'assistant',
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', name: 'Read' }],
        },
    }].map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');

    const service = new ClaudeSessionService();
    service.getSessions({ forceRefresh: true });
    const request = { sessionId, runStartedAtMs };
    const running = service.getLifecycleSignals([request])[sessionId];
    assert.ok(running);
    assert.equal(running.phase, 'running');
    assert.equal(running.executionState, 'running');
    assert.match(running.token, /^claude:subagent-running:/);

    fs.appendFileSync(runningSubagent, `${JSON.stringify({
        timestamp: '2026-07-31T07:00:07.000Z',
        type: 'assistant',
        uuid: 'running-completed',
        message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
    })}\n`, 'utf8');
    const completed = service.getLifecycleSignals([request])[sessionId];
    assert.ok(completed);
    assert.equal(completed.phase, 'needsAttention');
    assert.equal(completed.reason, 'completed');
    assert.equal(completed.executionState, 'stopped');
});

test('SESSION-CLAUDE-SESSION-SERVICE-001 stats each session file once instead of once per sort comparison', t => {
    const root = makeTempDirectory(t, 'provider-claude-sort-');
    setEnvironment(t, 'CLAUDE_HOME', root);
    const sessionDir = path.join(root, 'projects', '-work-app');
    fs.mkdirSync(sessionDir, { recursive: true });

    // Enough files that an O(n log n) comparator is clearly distinguishable
    // from an O(n) decorate-sort pass.
    const sessionCount = 32;
    const sessionIds = [];
    for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = crypto.randomUUID();
        sessionIds.push(sessionId);
        fs.writeFileSync(
            path.join(sessionDir, `${sessionId}.jsonl`),
            `${JSON.stringify({
                sessionId, cwd: '/work/app', timestamp: '2026-01-01T00:00:00.000Z',
            })}\n`,
            'utf8'
        );
    }

    let stats = 0;
    const realStatSync = fs.statSync;
    fs.statSync = function countingStatSync(...args) {
        stats += 1;
        return realStatSync.apply(fs, args);
    };
    t.after(() => { fs.statSync = realStatSync; });

    const service = new ClaudeSessionService();
    stats = 0;
    const result = service.getSessions({ forceRefresh: true, candidatePaths: ['/work/app'] });

    assert.equal(result.available, true);
    assert.equal(result.sessions.length, sessionCount);
    // Ordering by recency must not cost a syscall per comparison. The
    // projects-tree signature that arms the conversation-source fast path
    // costs exactly one stat per project directory (one here). Allow a small
    // constant of extra probes, but nothing that scales with log n.
    assert.ok(
        stats <= sessionCount * 2 + 1,
        `expected at most ${sessionCount * 2 + 1} statSync calls for ${sessionCount} sessions, saw ${stats}`
    );
});

test('SESSION-CODEX-SESSION-SERVICE-001 stats each session file once per change poll', t => {
    const root = makeTempDirectory(t, 'provider-codex-fingerprint-');
    setEnvironment(t, 'CODEX_HOME', root);
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '14');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionCount = 32;
    for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = crypto.randomUUID();
        writeCodexSessionMetaFile(sessionsDir, sessionId, {
            id: sessionId, session_id: sessionId, cwd: '/work/app',
            timestamp: '2026-07-14T01:00:00.000Z', source: 'vscode',
        });
    }
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), '', 'utf8');

    let stats = 0;
    const realStatSync = fs.statSync;
    fs.statSync = function countingStatSync(...args) {
        stats += 1;
        return realStatSync.apply(fs, args);
    };
    t.after(() => { fs.statSync = realStatSync; });

    const service = new CodexSessionService();
    stats = 0;
    // watchSessionChanges runs this every 3s per provider.
    const fingerprint = service.getSessionFingerprint();

    assert.ok(fingerprint.length > 0);
    // Listing already stats every file to order by recency; the signature must
    // reuse that instead of stat'ing the same paths a second time. One extra
    // call covers session_index.jsonl.
    assert.ok(
        stats <= sessionCount + 4,
        `expected at most ${sessionCount + 4} statSync calls for ${sessionCount} sessions, saw ${stats}`
    );
});

function countingStats(t) {
    const counter = { count: 0 };
    const realStatSync = fs.statSync;
    fs.statSync = function countingStatSync(...args) {
        counter.count += 1;
        return realStatSync.apply(fs, args);
    };
    t.after(() => { fs.statSync = realStatSync; });
    return counter;
}

function makeClaudeStore(root, sessionCount) {
    const sessionDir = path.join(root, 'projects', '-work-app');
    fs.mkdirSync(sessionDir, { recursive: true });
    for (let index = 0; index < sessionCount; index += 1) {
        fs.writeFileSync(path.join(sessionDir, `${crypto.randomUUID()}.jsonl`), '{}\n', 'utf8');
    }
}

function makeCodexStore(root, sessionCount) {
    const sessionsDir = path.join(root, 'sessions', '2026', '07', '14');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const files = [];
    for (let index = 0; index < sessionCount; index += 1) {
        const sessionId = crypto.randomUUID();
        files.push(writeCodexSessionMetaFile(sessionsDir, sessionId, {
            id: sessionId, session_id: sessionId, cwd: '/work/app',
            timestamp: '2026-07-14T01:00:00.000Z', source: 'vscode',
        }));
    }
    fs.writeFileSync(path.join(root, 'session_index.jsonl'), '', 'utf8');
    return files;
}

function makeKimiStore(root, sessionCount) {
    const workDir = '/work/app';
    fs.writeFileSync(
        path.join(root, 'kimi.json'),
        JSON.stringify({ work_dirs: [{ path: workDir }] }),
        'utf8'
    );
    const sessionsDir = path.join(
        root, 'sessions', crypto.createHash('md5').update(workDir, 'utf8').digest('hex')
    );
    for (let index = 0; index < sessionCount; index += 1) {
        const sessionDir = path.join(sessionsDir, crypto.randomUUID());
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(path.join(sessionDir, 'state.json'), '{}', 'utf8');
        fs.writeFileSync(path.join(sessionDir, 'wire.jsonl'), '{}\n', 'utf8');
    }
}

test('SESSION-FINGERPRINT-HASH-001 stats each Claude session file once per change poll', t => {
    const root = makeTempDirectory(t, 'provider-claude-fingerprint-');
    setEnvironment(t, 'CLAUDE_HOME', root);
    const sessionCount = 32;
    makeClaudeStore(root, sessionCount);

    const counter = countingStats(t);
    const service = new ClaudeSessionService();
    counter.count = 0;
    const fingerprint = service.getSessionFingerprint();

    assert.ok(fingerprint.length > 0);
    // The listing pass already stats every file to order by recency; the
    // fingerprint must reuse that instead of stat'ing every path a second time.
    assert.ok(
        counter.count <= sessionCount + 2,
        `expected at most ${sessionCount + 2} statSync calls for ${sessionCount} sessions, saw ${counter.count}`
    );
});

test('SESSION-FINGERPRINT-HASH-001 fingerprints stay bounded as stores grow', t => {
    const claudeRoot = makeTempDirectory(t, 'provider-claude-bounded-');
    setEnvironment(t, 'CLAUDE_HOME', claudeRoot);
    makeClaudeStore(claudeRoot, 32);

    const codexRoot = makeTempDirectory(t, 'provider-codex-bounded-');
    setEnvironment(t, 'CODEX_HOME', codexRoot);
    makeCodexStore(codexRoot, 32);

    const kimiRoot = makeTempDirectory(t, 'provider-kimi-bounded-');
    setEnvironment(t, 'KIMI_SHARE_DIR', kimiRoot);
    makeKimiStore(kimiRoot, 32);

    // watchSessionChanges recomputes these every 3s per provider; the answer to
    // "did anything change" must not be a store-sized string.
    const limit = 128;
    const claude = new ClaudeSessionService().getSessionFingerprint();
    const codex = new CodexSessionService().getSessionFingerprint();
    const kimi = new KimiSessionService().getSessionFingerprint();
    assert.ok(claude.length > 0 && claude.length <= limit,
        `claude fingerprint is ${claude.length} chars, limit ${limit}`);
    assert.ok(codex.length > 0 && codex.length <= limit,
        `codex fingerprint is ${codex.length} chars, limit ${limit}`);
    assert.ok(kimi.length > 0 && kimi.length <= limit,
        `kimi fingerprint is ${kimi.length} chars, limit ${limit}`);
});

test('SESSION-FINGERPRINT-HASH-001 fingerprints are stable without changes and move with content', t => {
    const root = makeTempDirectory(t, 'provider-codex-stability-');
    setEnvironment(t, 'CODEX_HOME', root);
    const [sessionFile] = makeCodexStore(root, 4);

    const service = new CodexSessionService();
    const first = service.getSessionFingerprint();
    assert.equal(service.getSessionFingerprint(), first,
        'an unchanged store must keep its fingerprint between polls');

    fs.appendFileSync(sessionFile, '{}\n', 'utf8');
    assert.notEqual(service.getSessionFingerprint(), first,
        'appending to a session file must change the fingerprint');
});
