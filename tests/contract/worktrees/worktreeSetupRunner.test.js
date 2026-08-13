'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    normalizeWorktreeSetupCommand,
    WorktreeSetupError,
    WorktreeSetupRunner,
} = require('../../../out/worktrees/worktreeSetupRunner');

test('WORKTREE-PROVISIONING-SETUP-001 validates one shell-free setup argv', () => {
    assert.deepEqual(normalizeWorktreeSetupCommand(['npm', 'ci']), ['npm', 'ci']);
    assert.deepEqual(normalizeWorktreeSetupCommand([]), []);
    assert.deepEqual(normalizeWorktreeSetupCommand(['', 'ci']), []);
    assert.deepEqual(normalizeWorktreeSetupCommand('npm ci'), []);
    assert.deepEqual(normalizeWorktreeSetupCommand(['npm', 'bad\narg']), []);
});

test('WORKTREE-PROVISIONING-SETUP-001 executes argv directly in the created worktree', async t => {
    const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-setup-'));
    const markerPath = path.join(worktreePath, 'setup-marker.txt');
    t.after(() => fs.promises.rm(worktreePath, { recursive: true, force: true }));
    const runner = new WorktreeSetupRunner();

    await runner.run([
        process.execPath,
        '-e',
        'require("node:fs").writeFileSync("setup-marker.txt", process.cwd())',
    ], worktreePath, () => false);

    assert.equal(await fs.promises.readFile(markerPath, 'utf8'), worktreePath);
});

test('WORKTREE-PROVISIONING-SETUP-001 cancellation before launch runs no command', async () => {
    let calls = 0;
    const runner = new WorktreeSetupRunner({
        runCommand: async () => {
            calls += 1;
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, cancelled: false };
        },
    });

    await assert.rejects(
        runner.run(['npm', 'ci'], '/repo/worktree', () => true),
        error => error instanceof WorktreeSetupError && error.code === 'cancelled'
    );
    assert.equal(calls, 0);
});

test('WORKTREE-PROVISIONING-SETUP-001 bounds failures without exposing unbounded output', async () => {
    const runner = new WorktreeSetupRunner({
        runCommand: async () => ({
            exitCode: 1,
            stdout: '',
            stderr: 'x'.repeat(5000),
            timedOut: false,
            cancelled: false,
        }),
    });

    await assert.rejects(
        runner.run(['npm', 'ci'], '/repo/worktree', () => false),
        error => error instanceof WorktreeSetupError
            && error.code === 'setup-failed'
            && error.message.length < 700
    );
});

test('WORKTREE-PROVISIONING-SETUP-001 cancellation terminates the owned process tree', async t => {
    if (process.platform === 'win32') {
        t.skip('POSIX process-group contract');
        return;
    }
    const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-setup-tree-'));
    const markerPath = path.join(worktreePath, 'orphan-marker.txt');
    t.after(() => fs.promises.rm(worktreePath, { recursive: true, force: true }));
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 150);
    const childScript = [
        'const {spawn}=require("node:child_process");',
        'spawn(process.execPath,["-e",',
        '"setTimeout(()=>require(\\"node:fs\\").writeFileSync(\\"orphan-marker.txt\\",\\"bad\\"),800)"],',
        '{stdio:"ignore"});',
        'setInterval(()=>{},1000);',
    ].join('');

    await assert.rejects(
        new WorktreeSetupRunner().run(
            [process.execPath, '-e', childScript], worktreePath, () => cancelled),
        error => error instanceof WorktreeSetupError && error.code === 'cancelled'
    );
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(fs.existsSync(markerPath), false, 'cancel must not leave a setup descendant alive');
});

test('WORKTREE-PROVISIONING-SETUP-001 cancellation escalates when setup ignores graceful termination', async t => {
    if (process.platform === 'win32') {
        t.skip('POSIX signal escalation contract');
        return;
    }
    const worktreePath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-setup-kill-'));
    t.after(() => fs.promises.rm(worktreePath, { recursive: true, force: true }));
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 150);
    const startedAt = Date.now();

    await assert.rejects(
        new WorktreeSetupRunner().run([
            process.execPath,
            '-e',
            'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)',
        ], worktreePath, () => cancelled),
        error => error instanceof WorktreeSetupError && error.code === 'cancelled'
    );
    assert.ok(Date.now() - startedAt < 3_000, 'forced cancellation must remain bounded');
});
