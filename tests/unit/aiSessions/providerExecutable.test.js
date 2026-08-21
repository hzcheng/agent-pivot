'use strict';

// Characterization tests for the provider executable probe helpers that moved
// from the composition root into the provider directory capability. They pin
// the current behavior: absolute-path probing, PATH walking with PATHEXT
// semantics, and bounded child-process execution results.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
    resolveAiProviderExecutable,
    runBoundedAiProviderHelp,
} = require('../../../out/aiSessions/providerDirectoryCapability');

test('resolveAiProviderExecutable blanks and absolute paths', () => {
    assert.equal(resolveAiProviderExecutable(''), null);
    assert.equal(resolveAiProviderExecutable('/definitely/not/here/codex'), null);
    assert.equal(resolveAiProviderExecutable(process.execPath), process.execPath);
});

test('resolveAiProviderExecutable finds node on PATH', () => {
    const found = resolveAiProviderExecutable(process.platform === 'win32' ? 'node.exe' : 'node');
    assert.ok(found, 'node must resolve via PATH');
    assert.ok(path.isAbsolute(found));
});

test('resolveAiProviderExecutable returns null for unknown commands', () => {
    assert.equal(resolveAiProviderExecutable('definitely-not-a-real-command-xyz'), null);
});

test('runBoundedAiProviderHelp captures a successful run', async () => {
    const result = await runBoundedAiProviderHelp(
        process.execPath, ['-e', 'process.stdout.write("ok")'], { timeoutMs: 5000, maxOutputBytes: 1024 }
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'ok');
    assert.equal(result.timedOut, false);
});

test('runBoundedAiProviderHelp maps spawn failure to a null exit code', async () => {
    const result = await runBoundedAiProviderHelp(
        '/definitely/not/here', [], { timeoutMs: 1000, maxOutputBytes: 1024 }
    );
    assert.equal(result.exitCode, null);
    assert.equal(result.timedOut, false);
});

test('runBoundedAiProviderHelp flags timeouts', async () => {
    const result = await runBoundedAiProviderHelp(
        process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 50, maxOutputBytes: 1024 }
    );
    assert.equal(result.timedOut, true);
});
