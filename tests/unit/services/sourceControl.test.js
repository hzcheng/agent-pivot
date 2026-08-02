'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const { createFakeVscode } = require('../../helpers/fakeVscode');

function loadSourceControl(fakeVscode) {
    const modulePath = require.resolve('../../../out/services/sourceControl');
    delete require.cache[modulePath];
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require(modulePath);
    } finally {
        Module._load = previousLoad;
    }
}

function createVscodeHarness(overrides = {}) {
    const api = {
        openRepository: async () => ({}),
    };
    return createFakeVscode({
        workspace: { fs: { stat: async () => ({ type: 2 }) } },
        window: { showWarningMessage: async () => undefined },
        commands: { executeCommand: async () => undefined },
        extensions: {
            getExtension: () => ({
                exports: { getAPI: () => api },
            }),
        },
        Uri: { file: value => ({ scheme: 'file', fsPath: value }) },
        ...overrides,
    });
}

test('ARCH-SESSION-WORKTREE-001 mounts the worktree in Source Control and focuses the view', async () => {
    const fakeVscode = createVscodeHarness();
    const { showWorktreeInSourceControl } = loadSourceControl(fakeVscode);

    await showWorktreeInSourceControl('/repo/.worktree/feature-x');

    const surfaces = fakeVscode.calls.map(call =>
        `${call.surface}.${call.method || ''}`);
    assert.ok(surfaces.includes('Uri.file'));
    assert.ok(surfaces.includes('commands.executeCommand'));
    const focus = fakeVscode.calls.find(call =>
        call.surface === 'commands' && call.method === 'executeCommand');
    assert.deepEqual(focus.args, ['workbench.view.scm']);
    assert.equal(fakeVscode.calls.some(call =>
        call.surface === 'window' && call.method === 'showWarningMessage'), false);
});

test('ARCH-SESSION-WORKTREE-001 warns instead of failing on missing paths or a missing Git extension', async () => {
    const missingPath = createVscodeHarness({
        workspace: {
            fs: {
                stat: async () => {
                    throw new Error('ENOENT');
                },
            },
        },
    });
    const missingModule = loadSourceControl(missingPath);
    await missingModule.showWorktreeInSourceControl('/repo/.worktree/gone');
    const missingWarning = missingPath.calls.find(call =>
        call.surface === 'window' && call.method === 'showWarningMessage');
    assert.match(missingWarning.args[0], /no longer exists/);
    assert.equal(missingPath.calls.some(call =>
        call.surface === 'commands'), false);

    const noGit = createVscodeHarness({
        extensions: { getExtension: () => undefined },
    });
    const noGitModule = loadSourceControl(noGit);
    await noGitModule.showWorktreeInSourceControl('/repo/.worktree/feature-x');
    const noGitWarning = noGit.calls.find(call =>
        call.surface === 'window' && call.method === 'showWarningMessage');
    assert.match(noGitWarning.args[0], /Git extension is unavailable/);
});
