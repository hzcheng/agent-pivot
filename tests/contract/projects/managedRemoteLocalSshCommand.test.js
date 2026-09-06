'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { ManagedRemoteBridgeClient } = require('../../../out/projects/managedRemote/bridgeClient');
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

test('MANAGED-REMOTE-ACTIONS-001 bridge client bounds a stalled local action', async () => {
    const commands = {
        executeCommand(command, request) {
            if (command === MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND) {
                return Promise.resolve({
                    protocolVersion: 1,
                    requestId: request.requestId,
                    challenge: request.challenge,
                    sessionToken: 'session-12345678',
                    capabilities: MANAGED_REMOTE_BRIDGE_CAPABILITIES,
                });
            }
            return new Promise(() => {});
        },
    };
    await assert.rejects(
        new ManagedRemoteBridgeClient(commands, 5).execute(
            'openManagedMachine',
            `revision:${'a'.repeat(64)}`,
            'machine:one',
        ),
        /timed out/i,
    );
});

test('MANAGED-REMOTE-ACTIONS-001 rejects a Bridge without the projection-v2 capability', async () => {
    const commands = {
        async executeCommand(_command, request) {
            return {
                protocolVersion: 1,
                requestId: request.requestId,
                challenge: request.challenge,
                sessionToken: 'session-12345678',
                capabilities: MANAGED_REMOTE_BRIDGE_CAPABILITIES.filter(
                    value => value !== 'managedActionProjectionV2',
                ),
            };
        },
    };
    await assert.rejects(
        new ManagedRemoteBridgeClient(commands).execute(
            'openManagedMachine',
            `revision:${'a'.repeat(64)}`,
            'machine:one',
        ),
        /Update the Agent Pivot UI Bridge/,
    );
});

test('FILE-TRANSFER-PREFLIGHT-002 bridge client sends opaque handles and validates the bounded summary', async () => {
    const calls = [];
    const commands = {
        async executeCommand(command, request) {
            calls.push([command, request]);
            if (command === MANAGED_REMOTE_BRIDGE_HANDSHAKE_COMMAND) {
                return {
                    protocolVersion: 1, requestId: request.requestId, challenge: request.challenge,
                    sessionToken: 'session-12345678', capabilities: MANAGED_REMOTE_BRIDGE_CAPABILITIES,
                };
            }
            return {
                protocolVersion: 1, requestId: request.requestId, status: 'ok',
                value: {
                    totalItems: 1, knownBytes: 42, unknownSizeItems: 0,
                    existingFileNames: ['report.txt'], existingDirectoryNames: [],
                },
            };
        },
    };
    const result = await new ManagedRemoteBridgeClient(commands).preflightFileTransfer(
        `revision:${'a'.repeat(64)}`,
        {
            kind: 'preflight', entryIds: ['a'.repeat(32)],
            source: { kind: 'local', rootId: 'b'.repeat(32), directoryId: 'c'.repeat(32) },
            destination: { kind: 'managedMachine', machineId: 'machine:one', directoryId: 'd'.repeat(32) },
        },
    );
    assert.deepEqual(result.existingFileNames, ['report.txt']);
    assert.equal(calls[1][1].operation, 'preflightFileTransfer');
    assert.deepEqual(calls[1][1].fileTransfer, {
        kind: 'preflight', entryIds: ['a'.repeat(32)],
        source: { kind: 'local', rootId: 'b'.repeat(32), directoryId: 'c'.repeat(32) },
        destination: { kind: 'managedMachine', machineId: 'machine:one', directoryId: 'd'.repeat(32) },
    });
    assert.doesNotMatch(JSON.stringify(calls[1][1]), /\/(?:home|tmp|work)\//u,
        'the bridge request must not carry a local filesystem path');
});
