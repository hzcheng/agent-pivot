'use strict';

// Characterization tests for the shell-owned vscode.git API acquisition
// helper. The fake-vscode Module hook mirrors the other dashboard tests.

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadAcquisition(vscode) {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return vscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        delete require.cache[require.resolve('../../../out/dashboard/gitApiAcquisition')];
        return require('../../../out/dashboard/gitApiAcquisition');
    } finally {
        Module._load = previousLoad;
    }
}

test('getVsCodeGitApiForWorktreeMonitoring returns undefined without the git extension', async () => {
    const { getVsCodeGitApiForWorktreeMonitoring } = loadAcquisition({
        extensions: { getExtension: () => undefined },
    });
    assert.equal(await getVsCodeGitApiForWorktreeMonitoring(), undefined);
});

test('getVsCodeGitApiForWorktreeMonitoring activates an inactive extension', async () => {
    let activations = 0;
    const api = {
        repositories: [],
        onDidOpenRepository: () => ({ dispose() {} }),
        onDidCloseRepository: () => ({ dispose() {} }),
    };
    const { getVsCodeGitApiForWorktreeMonitoring } = loadAcquisition({
        extensions: {
            getExtension: () => ({
                isActive: false,
                activate: async () => { activations += 1; return { getAPI: () => api }; },
            }),
        },
    });
    assert.equal(await getVsCodeGitApiForWorktreeMonitoring(), api);
    assert.equal(activations, 1);
});

test('getVsCodeGitApiForWorktreeMonitoring rejects a malformed API surface', async () => {
    const { getVsCodeGitApiForWorktreeMonitoring } = loadAcquisition({
        extensions: {
            getExtension: () => ({
                isActive: true,
                exports: { getAPI: () => ({ repositories: 'not-an-array' }) },
            }),
        },
    });
    assert.equal(await getVsCodeGitApiForWorktreeMonitoring(), undefined);
});
