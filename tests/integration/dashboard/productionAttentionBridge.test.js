'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');

test('ATTENTION-PRODUCTION-ATTENTION-BRIDGE-INTEGRATION-001 ATTENTION-SESSION-CARD-ACKNOWLEDGEMENT-001 OPEN-WORKSPACE-UI-HOST-NAVIGATION-001 OPEN-WORKSPACE-BRIDGE-COMPATIBILITY-001 OPEN-PROJECT-UI-HOST-NAVIGATION-001 activates the production bridge and opens workspaces and saved projects from the UI host', async t => {
    const root = makeTempDirectory(t, 'production-attention-bridge-');
    const registered = new Map();
    const executed = [];
    const vscode = {
        Uri: {
            parse: value => ({ value }),
            file: value => ({ value: `file://${value}` }),
        },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        },
        workspace: { workspaceFolders: [{
            name: 'sensitive',
            uri: {
                scheme: 'vscode-remote',
                authority: 'ssh-remote+sensitive-host',
                path: '/home/sensitive-user/private-project',
                toString: () => 'vscode-remote://ssh-remote%2Bsensitive-host/home/sensitive-user/private-project',
            },
        }] },
        commands: {
            registerCommand: (command, callback) => {
                registered.set(command, callback);
                return { dispose: () => registered.delete(command) };
            },
            executeCommand: async (command, ...args) => {
                executed.push({ command, args });
                const callback = registered.get(command);
                return callback ? callback(args[0]) : undefined;
            },
        },
    };
    const previousLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    const bridgeRoot = path.resolve(__dirname, '../../../extensions/attention-ui-bridge');
    const extensionPath = require.resolve(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/extension'
    );
    const clientPath = require.resolve('../../../out/aiSessions/attentionBridgeClient');
    delete require.cache[extensionPath];
    delete require.cache[clientPath];
    const bridgePackage = JSON.parse(fs.readFileSync(path.join(bridgeRoot, 'package.json'), 'utf8'));
    const context = {
        extensionPath: bridgeRoot,
        globalStoragePath: root,
        globalStorageUri: { scheme: 'file' },
        subscriptions: [],
    };
    let client;
    try {
        const extension = require(extensionPath);
        await extension.activate(context);
        const requiredCommands = [
            '_agentPivotAttention.bridge.handshake',
            '_agentPivotAttention.bridge.publish',
            '_agentPivotAttention.bridge.unregister',
            '_agentPivotAttention.bridge.acknowledge',
            '_agentPivotOpenWorkspaces.bridge.navigate',
            '_agentPivotProjects.bridge.navigate',
        ];
        for (const command of requiredCommands) assert.equal(typeof registered.get(command), 'function');

        const openWorkspacePublish = registered.get('_agentPivotOpenWorkspaces.bridge.publish');
        await openWorkspacePublish({
            protocolVersion: 4,
            instanceId: 'c'.repeat(32),
            sequence: 1,
            followsFocusEvent: true,
            workspace: {
                navigationIdentity: '1'.repeat(64),
                scopeIdentity: '2'.repeat(64),
                kind: 'singleFolder',
                displayName: 'reddb',
                navigationUri: 'file:///home/sensitive-user/private-project',
                environment: 'ssh',
                runningAiSessionCount: 0,
                roots: [{
                    id: '3'.repeat(64),
                    name: 'reddb',
                    uri: 'file:///home/sensitive-user/private-project',
                    ordinal: 0,
                }],
            },
        });
        const openWorkspaceAggregate = executed
            .filter(entry => entry.command === '_agentPivotOpenWorkspaces.workspace.aggregate')
            .at(-1).args[0];
        const authoritativeWorkspace = openWorkspaceAggregate.registrations
            .find(registration => registration.instanceId === 'c'.repeat(32)).workspace;
        const navigate = registered.get('_agentPivotOpenWorkspaces.bridge.navigate');
        const navigationOutcome = await navigate({
            protocolVersion: 4,
            navigationIdentity: authoritativeWorkspace.navigationIdentity,
        });
        assert.deepEqual(navigationOutcome, {
            protocolVersion: 4,
            opened: true,
        });
        assert.deepEqual(
            executed.filter(entry => entry.command === 'vscode.openFolder').at(-1),
            {
                command: 'vscode.openFolder',
                args: [{
                    value: 'vscode-remote://ssh-remote%2Bsensitive-host/home/sensitive-user/private-project',
                }, {
                    forceNewWindow: true,
                }],
            },
        );
        const savedProjectOutcome = await registered.get('_agentPivotProjects.bridge.navigate')({
            protocolVersion: 1,
            projectPath: '/Users/local-user/reddb',
            remoteType: 0,
            openInNewWindow: true,
        });
        assert.deepEqual(savedProjectOutcome, {
            protocolVersion: 1,
            opened: true,
        });
        assert.deepEqual(
            executed.filter(entry => entry.command === 'vscode.openFolder').at(-1),
            {
                command: 'vscode.openFolder',
                args: [{
                    value: 'file:///Users/local-user/reddb',
                }, {
                    forceNewWindow: true,
                }],
            },
        );
        await assert.rejects(
            registered.get('_agentPivotProjects.bridge.navigate')({
                protocolVersion: 1,
                projectPath: '/Users/local-user/reddb',
                remoteType: 0,
                openInNewWindow: true,
                unexpected: true,
            }),
            /unexpected fields/,
        );

        const aggregates = [];
        const errors = [];
        const AttentionBridgeClient = require(clientPath).default;
        client = new AttentionBridgeClient(
            aggregate => aggregates.push(aggregate),
            error => errors.push(error),
            { mainExtensionVersion: '2.1.3' }
        );
        assert.equal(await client.publish([{
            projectId: 'a'.repeat(64), sessionKey: 'codex:integration',
            state: 'needsAttention', eventId: 'integration-event',
            reason: 'completed', observedAtMs: 1,
        }]), true);
        assert.deepEqual(errors, []);
        assert.ok(aggregates.length > 0);
        assert.deepEqual(aggregates.at(-1).sessions[0].eventIds, ['integration-event']);
        assert.equal(await client.acknowledge(['integration-event']), 'committed');
        assert.deepEqual(aggregates.at(-1).sessions, [],
            'a committed acknowledgement is persisted and broadcast by the production bridge');
        const acknowledgeCommand = '_agentPivotAttention.bridge.acknowledge';
        const productionAcknowledge = registered.get(acknowledgeCommand);
        await client.publish([{
            projectId: 'a'.repeat(64), sessionKey: 'codex:malformed-result',
            state: 'needsAttention', eventId: 'malformed-result-event',
            reason: 'completed', observedAtMs: 2,
        }]);
        registered.set(acknowledgeCommand, async raw => {
            await productionAcknowledge(raw);
            return { acknowledged: raw.eventIds.length, unexpected: true };
        });
        assert.equal(await client.acknowledge(['malformed-result-event']), 'degraded-local',
            'a malformed bridge result must fail closed even after persistence');
        registered.set(acknowledgeCommand, async raw => {
            const malformed = [];
            malformed.acknowledged = raw.eventIds.length;
            return malformed;
        });
        assert.equal(await client.acknowledge(['array-result-event']), 'degraded-local',
            'an array with an acknowledged property is not a valid bridge result record');
        registered.set(acknowledgeCommand, async () => {
            throw new Error('fixture acknowledgement failure');
        });
        assert.equal(await client.acknowledge(['missing-event']), 'degraded-local');
        assert.match(String(errors.at(-1)), /fixture acknowledgement failure/,
            'a rejected acknowledgement is reported before local degradation');
        registered.set(acknowledgeCommand, productionAcknowledge);

        const handshake = registered.get('_agentPivotAttention.bridge.handshake');
        const publish = registered.get('_agentPivotAttention.bridge.publish');
        const unregister = registered.get('_agentPivotAttention.bridge.unregister');
        const validSnapshot = executed.find(entry =>
            entry.command === '_agentPivotAttention.bridge.publish').args[0];
        const handshakeResponse = await handshake({
            protocolVersion: 1, mainExtensionVersion: '2.1.3', instanceId: 'b'.repeat(32),
        });
        assert.equal(handshakeResponse.bridgeExtensionVersion, bridgePackage.version);
        assert.deepEqual(handshakeResponse.capabilities, {
            snapshots: true, acknowledgements: true, atomicReplace: true,
        });
        assert.equal((await registered.get('_agentPivotOpenWorkspaces.bridge.handshake')({
            protocolVersion: 4,
            mainExtensionVersion: '2.1.3',
            instanceId: 'd'.repeat(32),
            capabilities: {
                workspaces: true,
                atomicReplace: true,
                focusLeases: true,
                authoritativeUris: true,
                uiHostNavigation: false,
            },
        })).accepted, false);
        await assert.rejects(
            unregister({ protocolVersion: 1, instanceId: validSnapshot.instanceId, unexpected: true }),
            /unexpected fields/
        );
        await assert.rejects(handshake({
            protocolVersion: 2, mainExtensionVersion: '2.1.3', instanceId: 'b'.repeat(32),
        }), /protocol/);
        await assert.rejects(publish({ ...validSnapshot, unexpected: true }), /unexpected fields/);
        await assert.rejects(publish({ ...validSnapshot, version: 2 }), /header|version|protocol/);
        await assert.rejects(publish({
            ...validSnapshot,
            items: [{ ...validSnapshot.items[0], eventId: 'x'.repeat(1025) }],
        }), /eventId/);

        const productionRoot = path.join(
            root, 'agent-pivot', 'bridge', 'v1', 'production-attention', 'v1', 'instances'
        );
        const storedText = fs.readdirSync(productionRoot)
            .filter(name => name.endsWith('.json'))
            .map(name => fs.readFileSync(path.join(productionRoot, name), 'utf8'))
            .join('\n');
        assert.doesNotMatch(storedText, /\/home\/|ssh-remote|workspaceIdentity/);
        assert.doesNotMatch(storedText, /sensitive-user|sensitive-host|private-project/);
        assert.match(storedText, new RegExp(`"bridgeVersion":"${bridgePackage.version.replace('.', '\\.')}"`));

        const unregisterCount = () => executed.filter(entry =>
            entry.command === '_agentPivotAttention.bridge.unregister'
            && entry.args[0]?.instanceId === validSnapshot.instanceId).length;
        assert.equal(fs.existsSync(path.join(productionRoot, `${validSnapshot.instanceId}.json`)), true);
        client.dispose();
        // Awaiting shutdown is deterministic: shutdownFlight chains the unregister
        // executeCommand onto publicationQueue, so its resolution guarantees the bridge
        // handler (and the production store remove) completed. Event-loop-turn polling
        // here flaked under c8-instrumented full-suite load.
        await client.shutdown();
        assert.equal(unregisterCount(), 1, 'disposing the real client unregisters its production snapshot');
        assert.equal(fs.existsSync(path.join(productionRoot, `${validSnapshot.instanceId}.json`)), false);
    } finally {
        client?.dispose();
        await new Promise(resolve => setImmediate(resolve));
        for (const disposable of context.subscriptions.slice().reverse()) disposable.dispose?.();
        Module._load = previousLoad;
        delete require.cache[extensionPath];
        delete require.cache[clientPath];
    }
    assert.equal(registered.size, 0, 'disposing production activation unregisters every command');
});

test('OPEN-UNREGISTER-ON-DEACTIVATE-001 production bridge deactivation removes the window registration', async t => {
    const root = makeTempDirectory(t, 'open-workspace-bridge-shutdown-');
    const registered = new Map();
    const vscode = {
        Uri: {
            parse: value => ({ value }),
            file: value => ({ value: `file://${value}` }),
        },
        window: {
            createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
        },
        workspace: { workspaceFolders: [{
            name: 'sensitive',
            uri: {
                scheme: 'vscode-remote',
                authority: 'ssh-remote+sensitive-host',
                path: '/home/sensitive-user/private-project',
                toString: () => 'vscode-remote://ssh-remote%2Bsensitive-host/home/sensitive-user/private-project',
            },
        }] },
        commands: {
            registerCommand: (command, callback) => {
                registered.set(command, callback);
                return { dispose: () => registered.delete(command) };
            },
            executeCommand: async (command, ...args) => {
                const callback = registered.get(command);
                return callback ? callback(args[0]) : undefined;
            },
        },
    };
    const previousLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    const bridgeRoot = path.resolve(__dirname, '../../../extensions/attention-ui-bridge');
    const extensionPath = require.resolve(
        '../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/extension'
    );
    delete require.cache[extensionPath];
    const context = {
        extensionPath: bridgeRoot,
        globalStoragePath: root,
        globalStorageUri: { scheme: 'file' },
        subscriptions: [],
    };
    const instanceId = 'c'.repeat(32);
    const instanceFile = path.join(
        root, 'agent-pivot', 'bridge', 'v1', 'open-workspaces', 'v4', 'instances',
        `${instanceId}.json`
    );
    try {
        const extension = require(extensionPath);
        await extension.activate(context);
        await registered.get('_agentPivotOpenWorkspaces.bridge.publish')({
            protocolVersion: 4,
            instanceId,
            sequence: 1,
            followsFocusEvent: true,
            workspace: {
                navigationIdentity: '1'.repeat(64),
                scopeIdentity: '2'.repeat(64),
                kind: 'singleFolder',
                displayName: 'reddb',
                navigationUri: 'file:///home/sensitive-user/private-project',
                environment: 'ssh',
                runningAiSessionCount: 0,
                roots: [{
                    id: '3'.repeat(64),
                    name: 'reddb',
                    uri: 'file:///home/sensitive-user/private-project',
                    ordinal: 0,
                }],
            },
        });
        assert.equal(fs.existsSync(instanceFile), true,
            'publishing must persist the window registration');
        await extension.deactivate();
        assert.equal(fs.existsSync(instanceFile), false,
            'deactivation must remove the window registration');
    } finally {
        for (const disposable of context.subscriptions.slice().reverse()) disposable.dispose?.();
        Module._load = previousLoad;
        delete require.cache[extensionPath];
    }
});
