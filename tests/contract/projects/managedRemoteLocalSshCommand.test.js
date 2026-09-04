'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ManagedRemoteBridgeClient } = require('../../../out/projects/managedRemote/bridgeClient');
const {
    ManagedRemoteLocalSshCommandController,
} = require('../../../out/projects/managedRemote/localSshCommandController');
const {
    MANAGED_REMOTE_BRIDGE_CAPABILITIES,
    MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND,
    MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND,
} = require('../../../out/projects/managedRemote/bridgeProtocol');

test('MANAGED-REMOTE-SSH-COMMAND-001 bridge client sends only revision and Machine identity', async () => {
    const calls = [];
    const commands = {
        async executeCommand(command, request) {
            calls.push([command, request]);
            if (command === MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND) {
                return {
                    protocolVersion: 1,
                    requestId: request.requestId,
                    challenge: request.challenge,
                    sessionToken: 'session-12345678',
                    capabilities: MANAGED_REMOTE_BRIDGE_CAPABILITIES,
                };
            }
            return {
                protocolVersion: 1,
                requestId: request.requestId,
                status: 'ok',
                value: { alias: 'agent-pivot-safe' },
            };
        },
    };
    await new ManagedRemoteBridgeClient(commands).execute(
        'openLocalSshTerminal',
        `revision:${'a'.repeat(64)}`,
        'machine:one',
    );

    assert.equal(calls[1][0], MANAGED_REMOTE_BRIDGE_EXECUTE_COMMAND);
    assert.deepEqual(Object.keys(calls[1][1]).sort(), [
        'expectedRevisionId', 'operation', 'protocolVersion', 'requestId',
        'sessionToken', 'targetId',
    ]);
    assert.equal(calls[1][1].targetId, 'machine:one');
    assert.equal('host' in calls[1][1], false);
});

test('MANAGED-REMOTE-SSH-COMMAND-001 picker disambiguates endpoints and invokes the local bridge', async () => {
    const calls = [];
    const messages = [];
    const machine = {
        id: 'machine:one', name: 'Build',
        connection: { kind: 'ssh', host: '2001:db8::1', user: 'dev', port: 2207 },
    };
    const controller = new ManagedRemoteLocalSshCommandController({
        async getSnapshot() {
            return {
                revisionId: `revision:${'b'.repeat(64)}`,
                lifecycle: 'active',
                catalog: {
                    machines: [machine], environments: [], projects: [], conflicts: [],
                    layout: { machineIds: [], environmentIdsByMachine: {}, projectIdsByEnvironment: {}, favoriteProjectIds: [] },
                },
                machineConflictCandidates: {},
            };
        },
        async showQuickPick(items) {
            assert.equal(items[0].description, 'dev@[2001:db8::1]:2207');
            return items[0];
        },
        bridge: {
            async execute(...args) { calls.push(args); },
        },
        async showInformationMessage(message) { messages.push(message); },
        async showErrorMessage(message) { messages.push(message); },
    });
    await controller.copySshCommand();

    assert.deepEqual(calls, [[
        'copyLocalSshCommand', `revision:${'b'.repeat(64)}`, 'machine:one',
    ]]);
    assert.deepEqual(messages, ['Copied SSH command for Build.']);
});
