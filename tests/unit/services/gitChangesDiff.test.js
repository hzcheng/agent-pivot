'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function loadService(executed, options = {}) {
    const fakeVscode = {
        Uri: {
            file: fsPath => ({
                scheme: 'file',
                fsPath,
                with(change) {
                    return {
                        ...this, ...change,
                        with(next) { return { ...this, ...next }; },
                    };
                },
            }),
        },
        workspace: {
            registerTextDocumentContentProvider: () => ({ dispose() {} }),
        },
        commands: {
            executeCommand: async (command, ...args) => {
                executed.push([command, ...args]);
                if (command === 'vscode.changes' && options.failChanges !== false) {
                    throw new Error('unknown command');
                }
                return undefined;
            },
        },
        window: {
            showQuickPick: async () => options.quickPick,
        },
    };
    const previousLoad = Module._load;
    Module._load = function (request, ...rest) {
        if (request === 'vscode') {
            return fakeVscode;
        }
        return previousLoad.call(this, request, ...rest);
    };
    try {
        delete require.cache[
            require.resolve('../../../out/services/gitChangesDiff')];
        return require('../../../out/services/gitChangesDiff');
    } finally {
        Module._load = previousLoad;
    }
}

function diffQuery(uri) {
    return JSON.parse(uri.query);
}

test('WORKTREE-CHANGES-PANEL-001 unstaged files diff index against the working tree', async () => {
    const executed = [];
    const service = loadService(executed);
    await service.openWorkingChangeDiff('/wt/api', {
        group: 'changes', xy: ' M', path: 'src/a.ts',
    });
    assert.equal(executed.length, 1);
    const [command, left, right, title] = executed[0];
    assert.equal(command, 'vscode.diff');
    assert.deepEqual(diffQuery(left),
        { cwd: '/wt/api', ref: '', path: 'src/a.ts' },
        'left side is the index (empty ref)');
    assert.equal(right.scheme, 'file');
    assert.equal(right.fsPath, '/wt/api/src/a.ts',
        'right side is the working tree file');
    assert.equal(title, 'src/a.ts');
});

test('WORKTREE-CHANGES-PANEL-001 staged files diff HEAD against the index', async () => {
    const executed = [];
    const service = loadService(executed);
    await service.openWorkingChangeDiff('/wt/api', {
        group: 'staged', xy: 'M ', path: 'src/a.ts',
    });
    const [, left, right] = executed[0];
    assert.equal(diffQuery(left).ref, 'HEAD');
    assert.equal(diffQuery(right).ref, '', 'right side is the index');
});

test('WORKTREE-CHANGES-PANEL-001 untracked files open directly, deletions open one-sided', async () => {
    const executed = [];
    const service = loadService(executed);
    await service.openWorkingChangeDiff('/wt/api', {
        group: 'untracked', xy: '??', path: 'src/new.ts',
    });
    assert.equal(executed[0][0], 'vscode.open',
        'untracked opens the file itself, aligned with SCM');

    await service.openWorkingChangeDiff('/wt/api', {
        group: 'changes', xy: ' D', path: 'src/gone.ts',
    });
    const [command, left, right] = executed[1];
    assert.equal(command, 'vscode.diff');
    assert.equal(diffQuery(left).path, 'src/gone.ts');
    assert.equal(diffQuery(right).ref, '~empty~',
        'deleted files diff against an empty right side');
});

test('WORKTREE-CHANGES-PANEL-001 renames carry the original path on the git side', async () => {
    const executed = [];
    const service = loadService(executed);
    await service.openWorkingChangeDiff('/wt/api', {
        group: 'staged', xy: 'R ', path: 'src/new.ts',
        originalPath: 'src/old.ts',
    });
    const [, left, right, title] = executed[0];
    assert.equal(diffQuery(left).path, 'src/old.ts');
    assert.equal(diffQuery(right).path, 'src/new.ts');
    assert.equal(title, 'src/old.ts → src/new.ts');
});

async function repoFixture(t) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-pivot-review-'));
    const git = args => childProcess.execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(['init', '-b', 'main']);
    git(['config', 'user.name', 'Agent Pivot Tests']);
    git(['config', 'user.email', 'tests@example.invalid']);
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'a1\n');
    await fs.promises.writeFile(path.join(dir, 'c.txt'), 'c1\n');
    git(['add', '.']);
    git(['commit', '-m', 'base']);
    const baseline = git(['rev-parse', 'HEAD']);
    // a.txt modified, c.txt deleted; untracked files never join a diff.
    await fs.promises.writeFile(path.join(dir, 'a.txt'), 'a2\n');
    await fs.promises.unlink(path.join(dir, 'c.txt'));
    t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
    return { dir, baseline };
}

function reviewEntries(executed) {
    const call = executed.find(entry => entry[0] === 'vscode.changes');
    return call ? call[2] : null;
}

test('WORKTREE-CHANGES-PANEL-001 task result review opens one multi-diff with [label, original, modified] triples', async t => {
    const repo = await repoFixture(t);
    const executed = [];
    const service = loadService(executed, { failChanges: false });

    await service.openTaskResultReview(repo.dir, repo.baseline, 'Task result');

    assert.equal(executed.length, 1, 'the multi-diff opens without a diff fallback');
    const [command, title, resources] = executed[0];
    assert.equal(command, 'vscode.changes');
    assert.equal(title, 'Task result');
    // vscode.changes validates [label, original, modified] triples; pairs
    // fail argument validation and silently opened only the first file.
    assert.equal(resources.length, 2, 'a.txt modified + c.txt deleted');
    for (const [label, original, modified] of resources) {
        assert.equal(label.scheme, 'file', 'the label URI identifies the file');
        assert.equal(diffQuery(original).ref, repo.baseline,
            'the original side reads the baseline commit');
    }
    const modified = Object.fromEntries(
        resources.map(entry => [path.basename(entry[0].fsPath), entry[2]]));
    assert.equal(modified['a.txt'].scheme, 'file',
        'an existing worktree file opens its working-tree document');
    assert.equal(diffQuery(modified['c.txt']).ref, '~empty~',
        'a deleted file renders an empty modified side instead of a missing file');
});

test('WORKTREE-CHANGES-PANEL-001 task result review falls back to a per-file list and reports the failure', async t => {
    const repo = await repoFixture(t);
    const executed = [];
    const errors = [];
    const service = loadService(executed, {
        failChanges: true,
        quickPick: { label: 'c.txt', index: 1 },
    });

    await service.openTaskResultReview(repo.dir, repo.baseline, 'Task result',
        (message, error) => errors.push([message, error]));

    assert.equal(errors.length, 1,
        'a rejected vscode.changes must reach the log sink, never vanish');
    assert.equal(errors[0][1].message, 'unknown command');
    const diff = executed.find(entry => entry[0] === 'vscode.diff');
    assert.ok(diff, 'the picked file opens a single diff');
    assert.equal(diffQuery(diff[1]).path, 'c.txt');
    assert.equal(diffQuery(diff[2]).ref, '~empty~');
    assert.equal(diff[3], 'c.txt');
});

test('WORKTREE-CHANGES-PANEL-001 task result review includes untracked files with an empty baseline side', async t => {
    const repo = await repoFixture(t);
    await fs.promises.writeFile(path.join(repo.dir, 'new.txt'), 'new\n');
    const executed = [];
    const service = loadService(executed, { failChanges: false });

    await service.openTaskResultReview(repo.dir, repo.baseline, 'Task result');

    assert.equal(executed.length, 1, 'the multi-diff opens without a diff fallback');
    const [command, , resources] = executed[0];
    assert.equal(command, 'vscode.changes');
    // Task result ⊃ Working changes (PRD §4.3): the untracked file joins
    // the tracked diff (a.txt modified + c.txt deleted + new.txt untracked).
    assert.equal(resources.length, 3);
    const byName = Object.fromEntries(
        resources.map(entry => [path.basename(entry[0].fsPath), entry]));
    assert.ok(byName['new.txt'], 'the untracked file is part of the review');
    assert.equal(diffQuery(byName['new.txt'][1]).ref, '~empty~',
        'an untracked file has no baseline side — empty original');
    assert.equal(byName['new.txt'][2].scheme, 'file',
        'an untracked file renders its working-tree document');
});
