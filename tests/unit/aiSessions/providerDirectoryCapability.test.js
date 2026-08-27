'use strict';

// Pins the Kimi CLI dialect detection derived from the bounded `--help`
// probe: the Python Kimi CLI exposes `--work-dir` (and seeds interactive
// sessions with `--prompt`); the TypeScript Kimi Code CLI does not (its
// `--prompt` runs one headless turn and exits). Launch shapes key off this.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    ProviderDirectoryCapabilityProbe,
} = require('../../../out/aiSessions/providerDirectoryCapability');

const KIMI_CLI_HELP = `
 Usage: kimi [OPTIONS] [COMMAND] [ARGS]...
 --work-dir  -w  DIRECTORY  Working directory for the agent.
 --add-dir       DIRECTORY  Add an additional directory to the workspace scope.
 --prompt    -p  TEXT       User prompt to the agent.
`;

const KIMI_CODE_HELP = `
The Starting Point for Next-Gen Agents
Usage: kimi [options] [command]
  -S, --session [id]     Resume a session.
  -y, --yolo             Auto-approve regular tool calls.
  -p, --prompt <prompt>  Run one prompt non-interactively and print the response.
  --add-dir <dir>        Add an additional workspace directory for this session.
`;

function fakeChildProcess(helpStdout) {
    return {
        resolveExecutable: commandName => `/fake/bin/${commandName}`,
        run: async () => ({ exitCode: 0, stdout: helpStdout, stderr: '' }),
    };
}

test('kimi dialect detection: --work-dir help maps to the kimi-cli dialect', async () => {
    const probe = new ProviderDirectoryCapabilityProbe(fakeChildProcess(KIMI_CLI_HELP));
    const result = await probe.probe({ id: 'kimi', commandName: 'kimi' });
    assert.equal(result.status, 'supported');
    assert.equal(result.kimiDialect, 'kimi-cli');
});

test('kimi dialect detection: help without --work-dir maps to the kimi-code dialect', async () => {
    const probe = new ProviderDirectoryCapabilityProbe(fakeChildProcess(KIMI_CODE_HELP));
    const result = await probe.probe({ id: 'kimi', commandName: 'kimi' });
    assert.equal(result.status, 'supported',
        'kimi-code still supports --add-dir for multi-root workspaces');
    assert.equal(result.kimiDialect, 'kimi-code');
});

test('kimi dialect detection: non-kimi providers carry no dialect', async () => {
    const probe = new ProviderDirectoryCapabilityProbe(fakeChildProcess(KIMI_CLI_HELP));
    const result = await probe.probe({ id: 'codex', commandName: 'codex' });
    assert.equal(result.status, 'supported');
    assert.equal(result.kimiDialect, undefined);
});

test('kimi dialect detection: missing executables and failed help runs carry no dialect', async () => {
    const missing = new ProviderDirectoryCapabilityProbe({
        resolveExecutable: () => null,
        run: async () => ({ exitCode: null }),
    });
    const unavailable = await missing.probe({ id: 'kimi', commandName: 'kimi' });
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.kimiDialect, undefined);

    const failing = new ProviderDirectoryCapabilityProbe({
        resolveExecutable: commandName => `/fake/bin/${commandName}`,
        run: async () => { throw new Error('spawn failed'); },
    });
    const failed = await failing.probe({ id: 'kimi', commandName: 'kimi' });
    assert.equal(failed.status, 'unavailable');
    assert.equal(failed.kimiDialect, undefined);
});

test('kimi dialect detection: probe results cache per resolved executable', async () => {
    let runs = 0;
    const probe = new ProviderDirectoryCapabilityProbe({
        resolveExecutable: commandName => `/fake/bin/${commandName}`,
        run: async () => {
            runs += 1;
            return { exitCode: 0, stdout: KIMI_CODE_HELP, stderr: '' };
        },
    });
    const first = await probe.probe({ id: 'kimi', commandName: 'kimi' });
    const second = await probe.probe({ id: 'kimi', commandName: 'kimi' });
    assert.equal(runs, 1);
    assert.equal(first, second);
    assert.equal(second.kimiDialect, 'kimi-code');
});
