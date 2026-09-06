'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    ManagedSshProjectionValidator,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/managedSshValidator');

function output(overrides = {}) {
    const lines = [
        `hostname ${overrides.hostname || 'build.example.com'}`,
        `user ${overrides.user || 'dev'}`,
        `port ${overrides.port || '22022'}`,
        `permitlocalcommand ${overrides.permitlocalcommand || 'no'}`,
    ];
    if (overrides.proxyjump) { lines.push(`proxyjump ${overrides.proxyjump}`); }
    if (overrides.proxycommand) { lines.push(`proxycommand ${overrides.proxycommand}`); }
    if (overrides.localforward) { lines.push(`localforward ${overrides.localforward}`); }
    if (overrides.remotecommand) { lines.push(`remotecommand ${overrides.remotecommand}`); }
    if (overrides.forwardagent) { lines.push(`forwardagent ${overrides.forwardagent}`); }
    if (overrides.controlmaster) { lines.push(`controlmaster ${overrides.controlmaster}`); }
    return lines.join('\n');
}

class FakeRunner {
    constructor(responses) { this.responses = responses.slice(); this.calls = []; }
    async run(executable, args, timeoutMs) {
        this.calls.push({ executable, args, timeoutMs });
        return this.responses.shift();
    }
}

function input() {
    return {
        executable: '/usr/bin/ssh',
        aggregateConfigContent: 'Include "/tmp/current.conf"\n',
        entries: [{
            machineId: 'machine:one', alias: 'agent-pivot-one', name: 'Build',
            host: 'build.example.com', user: 'dev', port: 22022,
        }],
    };
}

test('MANAGED-REMOTE-SSH-VALIDATION-001 probes OpenSSH and validates the effective aggregate target', async () => {
    const runner = new FakeRunner([
        { exitCode: 0, stdout: '', stderr: 'OpenSSH_9.6' },
        { exitCode: 0, stdout: output(), stderr: '' },
    ]);
    await new ManagedSshProjectionValidator(runner).validate(input());
    assert.deepEqual(runner.calls.map(call => call.args), [
        ['-V'],
        ['-F', runner.calls[1].args[1], '-G', 'agent-pivot-one'],
    ]);
    assert.notEqual(runner.calls[1].args[1], '/tmp/current.conf');
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 rejects inherited routes and endpoint drift', async () => {
    const routeRunner = new FakeRunner([
        { exitCode: 0, stdout: 'OpenSSH_9.6', stderr: '' },
        { exitCode: 0, stdout: output({ proxyjump: 'bastion' }), stderr: '' },
    ]);
    await assert.rejects(
        new ManagedSshProjectionValidator(routeRunner).validate(input()),
        /unsafe target/,
    );
    const endpointRunner = new FakeRunner([
        { exitCode: 0, stdout: 'OpenSSH_9.6', stderr: '' },
        { exitCode: 0, stdout: output({ port: '22' }), stderr: '' },
    ]);
    await assert.rejects(
        new ManagedSshProjectionValidator(endpointRunner).validate(input()),
        /unsafe target/,
    );

    for (const inherited of [
        { localforward: '127.0.0.1:8080 example.com:80' },
        { remotecommand: 'dangerous-command' },
        { forwardagent: 'yes' },
        { controlmaster: 'auto' },
    ]) {
        const inheritedRunner = new FakeRunner([
            { exitCode: 0, stdout: 'OpenSSH_9.6', stderr: '' },
            { exitCode: 0, stdout: output(inherited), stderr: '' },
        ]);
        await assert.rejects(
            new ManagedSshProjectionValidator(inheritedRunner).validate(input()),
            /unsafe target/,
        );
    }
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 never executes through a shell', async () => {
    const runner = new FakeRunner([{ exitCode: 1, stdout: '', stderr: 'not openssh' }]);
    await assert.rejects(
        new ManagedSshProjectionValidator(runner).probe('/path with spaces/ssh'),
        /not a supported OpenSSH/,
    );
    assert.deepEqual(runner.calls[0], {
        executable: '/path with spaces/ssh', args: ['-V'], timeoutMs: 3000,
    });
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 surfaces the OpenSSH diagnostic on a failed exit', async () => {
    const runner = new FakeRunner([
        { exitCode: 0, stdout: 'OpenSSH_9.6', stderr: '' },
        {
            exitCode: 255,
            stdout: '',
            stderr: 'Pseudo-terminal will not be allocated because stdin is not a terminal.\n'
                + '/home/dev/.ssh/config line 12: Bad configuration option: knownhostscommand\n',
        },
    ]);

    // Without the file, line, and directive from stderr the failure is
    // unactionable: the user cannot tell which config line is at fault.
    await assert.rejects(
        new ManagedSshProjectionValidator(runner).validate(input()),
        error => {
            assert.match(error.message, /validation failed for machine:one/u);
            assert.match(error.message, /OpenSSH exited 255/u);
            assert.match(error.message, /line 12: Bad configuration option: knownhostscommand/u);
            assert.doesNotMatch(error.message, /Pseudo-terminal/u);
            return true;
        },
    );
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 reports which effective value was unsafe', async () => {
    const runner = new FakeRunner([
        { exitCode: 0, stdout: 'OpenSSH_9.6', stderr: '' },
        { exitCode: 0, stdout: output({ port: '22' }), stderr: '' },
    ]);
    await assert.rejects(
        new ManagedSshProjectionValidator(runner).validate(input()),
        /unsafe target for machine:one \(port\)/u,
    );
});

test('MANAGED-REMOTE-SSH-VALIDATION-001 names a failing exit with no diagnostic text', async () => {
    const runner = new FakeRunner([
        { exitCode: 0, stdout: 'OpenSSH_9.6', stderr: '' },
        { exitCode: 1, stdout: '', stderr: '' },
    ]);
    await assert.rejects(
        new ManagedSshProjectionValidator(runner).validate(input()),
        /OpenSSH exited 1 without a diagnostic/u,
    );
});
