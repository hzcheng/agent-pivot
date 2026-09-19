'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { CodexLiveFeed } = require('../../../out/aiSessions/conversation/codexLiveFeed');
const { readCodexManagedRun } = require('../../../out/aiSessions/codexManagedRun');
const { findPendingAiSessionTerminalMatch } = require('../../../out/aiSessions/pendingTerminals');

async function until(predicate) {
    for (let n = 0; n < 500; n++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail('managed terminal did not reach the expected state');
}

for (const scenario of ['new', 'resume', 'multiple-roots', 'switch-new', 'switch-fork']) test(`SESSION-COMMAND-BUILDER-001 ${scenario}: real launcher relays partial text, ignores helpers, rebinds and cleans up`,
    { skip: process.platform === 'win32', timeout: 20000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-run-'));
    const home = path.join(root, 'home');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(home); fs.mkdirSync(bin);
    fs.copyFileSync(path.join(__dirname, '../../fixtures/aiSessions/codexManagedCli.js'), path.join(bin, 'codex'));
    fs.chmodSync(path.join(bin, 'codex'), 0o700);
    const markerPath = path.join(root, 'terminal.done');
    const control = path.join(root, 'control');
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../../out/aiSessions/codexTerminalMain.js'),
        JSON.stringify({ args: scenario === 'resume'
            ? ['resume', '--dangerously-bypass-approvals-and-sandbox', '--cd', root, 'root-a', 'hello']
            : ['--cd', root, ...(scenario === 'multiple-roots' ? ['--add-dir', home] : []), 'hello'], cwd: root, markerPath })], {
        env: { ...process.env, CODEX_HOME: home, PATH: bin + path.delimiter + process.env.PATH,
            AP_TEST_WS: require.resolve('ws'), AP_TEST_CONTROL: control,
            AP_TEST_SWITCH_METHOD: scenario === 'switch-new' ? 'thread/start' : scenario === 'switch-fork' ? 'thread/fork' : 'thread/resume' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostic = ''; child.stderr.on('data', data => { diagnostic += data; });
    const done = new Promise(resolve => child.once('exit', code => resolve(code)));
    let feed;
    t.after(async () => {
        feed?.dispose();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        await done;
        fs.rmSync(root, { recursive: true, force: true });
    });
    await until(() => fs.existsSync(control + '.created') || child.exitCode !== null);
    assert.equal(child.exitCode, null, diagnostic);
    const read = () => readCodexManagedRun(markerPath + '.stream.json');
    assert.equal(read().sessionId, 'root-a', 'ephemeral title helper cannot replace the terminal root');
    const run = read();
    const lifecycle = JSON.parse(fs.readFileSync(control + '.lifecycle', 'utf8'));
    assert.equal(lifecycle.params.cwd, root);
    assert.deepEqual(lifecycle.params.runtimeWorkspaceRoots, scenario === 'multiple-roots' ? [root, home] : [root]);
    if (scenario === 'resume') {
        assert.equal(lifecycle.params.approvalPolicy, 'never');
        assert.equal(lifecycle.params.sandbox, 'danger-full-access');
    }
    const sessions = { available: true, sessions: [
        { id: 'wrong', cwd: root, updatedAt: new Date().toISOString() },
        { id: 'root-a', cwd: root, updatedAt: new Date().toISOString() },
    ] };
    assert.equal(findPendingAiSessionTerminalMatch({ markerPath, identity: { provider: 'codex', cwd: root },
        createdAt: new Date(run.startedAt - 1000).toISOString(), excludedSessionIds: [] },
    sessions, new Set(), (p, id) => p + id, []).id, 'root-a');
    feed = new CodexLiveFeed(run.socketPath);
    let partials = 0;
    feed.watch('root-a', () => {
        const turn = feed.read('root-a')?.turns[0];
        if (turn?.status === 'inProgress' && turn.items[1]?.text) partials++;
    });
    // Empty resumed history still completes the subscription before the new turn.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(read().sessionId, 'root-a', 'the viewer connection cannot select a terminal chat');
    fs.writeFileSync(control + '.go', '');
    await until(() => feed.read('root-a')?.turns[0]?.status === 'completed');
    assert.ok(partials > 1, 'text must arrive before completion');
    assert.equal(feed.read('root-a').turns[0].items[1].text, '0123456789');
    fs.writeFileSync(control + '.switch', '');
    await until(() => fs.existsSync(control + '.switched'));
    assert.equal(read().sessionId, 'root-b');
    const switchedRequest = JSON.parse(fs.readFileSync(control + '.lifecycle', 'utf8'));
    assert.deepEqual(switchedRequest.params.runtimeWorkspaceRoots, scenario === 'multiple-roots' ? [root, home] : [root], 'root switches must retain the entire directory scope');
    assert.equal(fs.existsSync(path.join(home, 'agent-pivot-streaming/root-a.json')), false);
    feed.dispose();
    fs.writeFileSync(control + '.finish', '');
    assert.equal(await done, 0, diagnostic);
    assert.equal(fs.existsSync(markerPath + '.stream.json'), false);
    assert.deepEqual(fs.readdirSync(path.join(home, 'agent-pivot-streaming')), []);
    assert.equal(fs.existsSync(run.socketPath), false);
});

test('SESSION-COMMAND-BUILDER-001 preserves profile and unsupported CLI launches, and contains companion startup failures',
    { skip: process.platform === 'win32', timeout: 20000 }, async t => {
    for (const scenario of ['profile', 'unsupported', 'server-failure', 'terminate-during-listen', 'wrong-scope']) {
        await t.test(scenario, async t => {
            const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-fallback-'));
            const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
            fs.copyFileSync(path.join(__dirname, '../../fixtures/aiSessions/codexManagedCli.js'), path.join(bin, 'codex'));
            fs.chmodSync(path.join(bin, 'codex'), 0o700);
            const markerPath = path.join(root, 'terminal.done');
            const control = path.join(root, 'control');
            const args = scenario === 'profile' ? ['resume', '-p', 'my-profile', 'existing-chat'] : ['--cd', root];
            const preload = path.join(root, 'terminate.js');
            fs.writeFileSync(preload, `const http=require('http');const listen=http.Server.prototype.listen;http.Server.prototype.listen=function(...a){const cb=a.pop();a.push(()=>{process.emit('SIGTERM');cb();});return listen.apply(this,a);};`);
            const child = spawn(process.execPath, [...(scenario === 'terminate-during-listen' ? ['-r', preload] : []), path.resolve(__dirname, '../../../out/aiSessions/codexTerminalMain.js'),
                JSON.stringify({ args, cwd: root, markerPath })], {
                env: { ...process.env, CODEX_HOME: root, PATH: bin + path.delimiter + process.env.PATH,
                    AP_TEST_WS: require.resolve('ws'), AP_TEST_CONTROL: control,
                    ...(scenario === 'unsupported' ? { AP_TEST_UNSUPPORTED: '1' } : {}),
                    ...(scenario === 'server-failure' ? { AP_TEST_SERVER_FAIL: '1' } : {}),
                    ...(scenario === 'wrong-scope' ? { AP_TEST_WRONG_ROOTS: '1' } : {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = ''; child.stderr.on('data', data => { stderr += data; });
            const done = new Promise(resolve => child.once('exit', resolve));
            t.after(async () => {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
                await done; fs.rmSync(root, { recursive: true, force: true });
            });
            assert.equal(await done, ['server-failure', 'terminate-during-listen', 'wrong-scope'].includes(scenario) ? 1 : 0, stderr);
            assert.equal(fs.existsSync(markerPath + '.stream.json'), false);
            if (!['server-failure', 'terminate-during-listen', 'wrong-scope'].includes(scenario)) {
                assert.deepEqual(JSON.parse(fs.readFileSync(control + '.ordinary', 'utf8')), args);
                assert.match(stderr, /live text is unavailable/);
            } else {
                assert.equal(fs.existsSync(control + '.ordinary'), false, 'never replay a failed managed launch automatically');
                if (scenario !== 'wrong-scope') assert.equal(fs.existsSync(control + '.terminalSpawned'), false, 'a cancelled or failed startup must not spawn a TUI');
            }
        });
    }
});
