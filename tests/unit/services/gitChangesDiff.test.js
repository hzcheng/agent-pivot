'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadService(executed) {
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
                if (command === 'vscode.changes') {
                    throw new Error('unknown command');
                }
                return undefined;
            },
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
