'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const commands = require('../../../out/aiSessions/commandBuilders');
const { serializeDirectLaunchCommand } = require('../../../out/aiSessions/launchSpec');

// SESSION-COMMAND-BUILDER-001

const cwd = '/fixtures/project';
const directoryScope = Object.freeze({
    workspaceNavigationIdentity: 'navigation:/fixtures/project',
    workspaceScopeIdentity: 'scope:/fixtures/project',
    workspaceRootHostPaths: Object.freeze([cwd]),
    primaryRootId: 'root:/fixtures/project',
    primaryCwd: cwd,
    additionalDirectories: Object.freeze([]),
});
const markerPath = '/fixtures/markers/session.done';
const sessionId = '11111111-1111-4111-8111-111111111111';
const title = "Fixture owner's request";
const providers = [{
    id: 'codex',
    resumeSpec: commands.buildCodexResumeLaunchSpec,
    newSpec: commands.buildCodexNewSessionLaunchSpec,
    expectedResume: {
        executable: 'codex', args: ['resume', '--cd', cwd, sessionId], markerPath,
        windowsDirectShell: 'current',
    },
    expectedNew: {
        executable: 'codex', args: ['--cd', cwd, title], markerPath,
        windowsDirectShell: 'powershell',
    },
    resumeCommand: `codex resume --cd '${cwd}' '${sessionId}'`,
    newCommand: `codex --cd '${cwd}' 'Fixture owner'\\''s request'`,
}, {
    id: 'kimi',
    resumeSpec: commands.buildKimiResumeLaunchSpec,
    newSpec: commands.buildKimiNewSessionLaunchSpec,
    expectedResume: {
        executable: 'kimi', args: ['--work-dir', cwd, '--resume', sessionId], markerPath,
        windowsDirectShell: 'current',
    },
    expectedNew: {
        executable: 'kimi', args: ['--work-dir', cwd, '--prompt', title], markerPath,
        windowsDirectShell: 'powershell',
    },
    resumeCommand: `kimi --work-dir '${cwd}' --resume '${sessionId}'`,
    newCommand: `kimi --work-dir '${cwd}' --prompt 'Fixture owner'\\''s request'`,
}, {
    id: 'claude',
    resumeSpec: commands.buildClaudeResumeLaunchSpec,
    newSpec: commands.buildClaudeNewSessionLaunchSpec,
    expectedResume: {
        executable: 'claude', args: ['--resume', sessionId], cwd, markerPath,
        windowsDirectShell: 'current',
    },
    expectedNew: {
        executable: 'claude', args: ['--name', title], cwd, markerPath,
        windowsDirectShell: 'powershell',
    },
    resumeCommand: `cd '${cwd}' && claude --resume '${sessionId}'`,
    newCommand: `cd '${cwd}' && claude --name 'Fixture owner'\\''s request'`,
}];

for (const provider of providers) {
    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] builds resume and new launch specs`, () => {
        assert.deepEqual(provider.resumeSpec(sessionId, directoryScope, markerPath), provider.expectedResume);
        assert.deepEqual(provider.newSpec(directoryScope, title, markerPath), provider.expectedNew);
    });

    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] serializes quoted POSIX commands`, () => {
        const resume = provider.resumeSpec(sessionId, directoryScope, null);
        const create = provider.newSpec(directoryScope, title, null);
        assert.equal(serializeDirectLaunchCommand(resume, 'linux'), provider.resumeCommand);
        assert.equal(serializeDirectLaunchCommand(create, 'linux'), provider.newCommand);
    });

    test(`SESSION-COMMAND-BUILDER-001 [${provider.id}] wraps terminal marker lifecycle commands`, () => {
        for (const spec of [
            provider.resumeSpec(sessionId, directoryScope, markerPath),
            provider.newSpec(directoryScope, title, markerPath),
        ]) {
            const command = serializeDirectLaunchCommand(spec, 'linux');
            assert.ok(command.startsWith('sh -lc '));
            assert.ok(command.includes('rm -f'));
            assert.ok(command.includes(': >'));
            assert.ok(command.includes('/fixtures/markers/session.done'));
        }
    });
}

test('SESSION-AI-SESSION-YOLO-LAUNCH-001 adds the exact provider flag to New and Resume argv', () => {
    const yolo = { yolo: true };
    assert.deepEqual(
        commands.buildCodexNewSessionLaunchSpec(directoryScope, title, markerPath, yolo).args,
        ['--dangerously-bypass-approvals-and-sandbox', '--cd', cwd, title]
    );
    assert.deepEqual(
        commands.buildCodexResumeLaunchSpec(sessionId, directoryScope, markerPath, yolo).args,
        ['resume', '--dangerously-bypass-approvals-and-sandbox', '--cd', cwd, sessionId]
    );
    assert.deepEqual(
        commands.buildKimiNewSessionLaunchSpec(directoryScope, title, markerPath, yolo).args,
        ['--work-dir', cwd, '--yolo', '--prompt', title]
    );
    assert.deepEqual(
        commands.buildKimiResumeLaunchSpec(sessionId, directoryScope, markerPath, yolo).args,
        ['--work-dir', cwd, '--yolo', '--resume', sessionId]
    );
    assert.deepEqual(
        commands.buildClaudeNewSessionLaunchSpec(directoryScope, title, markerPath, yolo).args,
        ['--dangerously-skip-permissions', '--name', title]
    );
    assert.deepEqual(
        commands.buildClaudeResumeLaunchSpec(sessionId, directoryScope, markerPath, yolo).args,
        ['--dangerously-skip-permissions', '--resume', sessionId]
    );
});

test('SESSION-AI-SESSION-YOLO-LAUNCH-002 rejects malformed truthy launch options at the flag boundary', () => {
    const malformed = { yolo: 'true' };
    for (const provider of providers) {
        assert.deepEqual(
            provider.resumeSpec(sessionId, directoryScope, markerPath, malformed),
            provider.expectedResume
        );
        assert.deepEqual(
            provider.newSpec(directoryScope, title, markerPath, malformed),
            provider.expectedNew
        );
    }
});

test('SESSION-CONVERSATION-COMMENTS-RESUME-001 passes one prompt through each provider resume argv', () => {
    const prompt = 'Handle comments 1 and 2.\nThen run tests.';
    assert.deepEqual(
        commands.buildCodexResumeLaunchSpec(
            sessionId, directoryScope, markerPath, { yolo: false }, prompt
        ).args,
        ['resume', '--cd', cwd, sessionId, prompt]
    );
    assert.deepEqual(
        commands.buildKimiResumeLaunchSpec(
            sessionId, directoryScope, markerPath, { yolo: false }, prompt
        ).args,
        ['--work-dir', cwd, '--resume', sessionId, '--prompt', prompt]
    );
    assert.deepEqual(
        commands.buildClaudeResumeLaunchSpec(
            sessionId, directoryScope, markerPath, { yolo: false }, prompt
        ).args,
        ['--resume', sessionId, prompt]
    );
});

test('SESSION-COMMAND-BUILDER-001 quotes PowerShell single quotes without interpolation', () => {
    assert.equal(commands.quotePowerShellArg("O'Brien & 100%"), "'O''Brien & 100%'");
});
