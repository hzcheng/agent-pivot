'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findPendingAiSessionTerminalMatch } = require('../../../out/aiSessions/pendingTerminals');

test('SESSION-COMMAND-BUILDER-001 pending managed terminal never guesses another chat in the same directory', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-pending-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const markerPath = path.join(dir, 'new.done');
    const pending = { markerPath, identity: { provider: 'codex', cwd: '/work' },
        createdAt: '2026-09-19T00:00:00Z', excludedSessionIds: [] };
    const wrong = { id: 'other-terminal', cwd: '/work', updatedAt: '2026-09-19T00:00:05Z' };
    fs.writeFileSync(markerPath + '.stream.json', JSON.stringify({ version: 1, state: 'starting' }), { mode: 0o600 });
    const match = findPendingAiSessionTerminalMatch(pending, { available: true, sessions: [wrong] },
        new Set(), (p, id) => p + ':' + id, []);
    assert.equal(match, null, 'wait for this terminal’s identified root, never choose a same-directory helper or neighboring terminal');
});

test('SESSION-COMMAND-BUILDER-001 records the pending identity before dispatch and validates live metadata', t => {
    const { createSingleUseLaunchSpecFactory } = require('../../../out/aiSessions/runtimeLaunch');
    const { readCodexManagedRun, processStartIdentity, writePrivateJson, resolveCodexManagedSocket } = require('../../../out/aiSessions/codexManagedRun');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-metadata-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const markerPath = path.join(dir, 'new.done');
    const create = createSingleUseLaunchSpecFactory(() => ({ executable: 'env', markerPath,
        args: ['ELECTRON_RUN_AS_NODE=1', process.execPath, '/extension/codexTerminal.js', JSON.stringify({ markerPath, cwd: dir, args: [] })] }));
    const spec = create();
    const runId = JSON.parse(spec.args[3]).runId;
    assert.match(runId, /^[a-f0-9]{32}$/);
    const file = markerPath + '.stream.json';
    assert.equal(JSON.parse(fs.readFileSync(file)).runId, runId);
    assert.equal(readCodexManagedRun(file), undefined, 'starting metadata is not a live thread');
    assert.throws(create, /already created/);
    const run = { version: 1, runId, state: 'running', pid: process.pid,
        processStart: processStartIdentity(process.pid), cwd: dir, startedAt: Date.now(), sessionId: 'root-a' };
    writePrivateJson(file, run);
    assert.equal(readCodexManagedRun(file).sessionId, 'root-a');
    writePrivateJson(file, { ...run, processStart: 'wrong-process-start' });
    assert.equal(readCodexManagedRun(file), undefined);
    writePrivateJson(file, run);
    fs.chmodSync(file, 0o644);
    assert.equal(readCodexManagedRun(file), undefined, 'publicly writable/readable metadata is rejected');
    fs.chmodSync(file, 0o600);
    const link = path.join(dir, 'link'); fs.symlinkSync(file, link);
    assert.equal(readCodexManagedRun(link), undefined);
    assert.equal(resolveCodexManagedSocket('../escape'), undefined);
    assert.equal(processStartIdentity(-1), undefined);
    fs.writeFileSync(file, '{invalid');
    assert.equal(readCodexManagedRun(file), undefined);
});
