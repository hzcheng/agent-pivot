'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const suitePath = path.resolve(__dirname, '../../extension-host/suite/index.js');
const bridgeId = 'hzcheng.agent-pivot-attention-ui-bridge';
const commandRegistrationPath = path.resolve(__dirname, '../../../out/dashboard/commandRegistration.js');
const publicCommands = [
    'agentPivot.open',
    'agentPivot.addProject',
    'agentPivot.saveProject',
    'agentPivot.removeProject',
    'agentPivot.editProjects',
    'agentPivot.addGroup',
    'agentPivot.removeGroup',
    'agentPivot.addProjectsFromFolder',
    'agentPivot.addFileToActiveTerminal',
    'agentPivot.insertPromptToActiveTerminal',
    'agentPivot.migrateSkillsToCentral',
    'agentPivot.changeGlobalSkillsLocation',
    'agentPivot.openCurrentAiSessionConversation',
    'agentPivot.previousActiveSession',
    'agentPivot.nextActiveSession',
    'agentPivot.nextAttentionSession',
    'agentPivot.nextRunningSession',
    'agentPivot.switchToAiSession',
    'agentPivot.toggleLastAiSession',
    'agentPivot.switchToOpenWindow'
];

function loadSuite(vscode) {
    const previousLoad = Module._load;
    delete require.cache[suitePath];
    Module._load = function (request, parent, isMain) {
        if (request === 'vscode') return vscode;
        return previousLoad.call(this, request, parent, isMain);
    };
    try {
        return require(suitePath);
    } finally {
        Module._load = previousLoad;
    }
}

function assertPublicCommandRegistration(transform = source => source) {
    const source = transform(fs.readFileSync(commandRegistrationPath, 'utf8'));
    const loaded = new Module(commandRegistrationPath, module);
    loaded.filename = commandRegistrationPath;
    loaded.paths = Module._nodeModulePaths(path.dirname(commandRegistrationPath));
    loaded._compile(source, commandRegistrationPath);
    const commands = [];
    const noop = () => undefined;
    new loaded.exports.DashboardCommandRegistration({
        registerCommand: command => { commands.push(command); return { dispose: noop }; },
        pushSubscription: noop,
        openWhileUnavailable: noop,
    }).register();
    assert.deepEqual(commands, publicCommands,
        'RELEASE-SCHEDULED-EXTENSION-HOST-001 production activation must register every public command');
}

function createHostFixture(availableCommands = publicCommands) {
    const activationCalls = [];
    const executedCommands = [];
    const bridge = {
        extensionPath: '/isolated/extensions/bridge',
        isActive: true,
        packageJSON: { extensionKind: ['ui'] },
        activate: async () => { activationCalls.push('bridge'); bridge.isActive = true; },
    };
    const main = {
        extensionPath: '/isolated/extensions/main',
        isActive: false,
        packageJSON: { extensionDependencies: [bridgeId] },
        activate: async () => {
            activationCalls.push('main');
            main.isActive = true;
        },
    };
    const vscode = {
        version: 'fixture',
        extensions: {
            getExtension: id => id === 'hzcheng.agent-pivot' ? main : id === bridgeId ? bridge : undefined,
        },
        commands: {
            getCommands: async () => availableCommands,
            executeCommand: async command => { executedCommands.push(command); },
        },
    };
    return { activationCalls, bridge, executedCommands, main, vscode };
}

async function withInstalledFixtureEnvironment(fixture, callback) {
    const values = {
        AGENT_PIVOT_EXPECTED_MAIN_EXTENSION_PATH: fixture.main.extensionPath,
        AGENT_PIVOT_EXPECTED_BRIDGE_EXTENSION_PATH: fixture.bridge.extensionPath,
    };
    const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
    Object.assign(process.env, values);
    try {
        return await callback();
    } finally {
        for (const [key, value] of previous) {
            value === undefined ? delete process.env[key] : process.env[key] = value;
        }
    }
}

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 invokes only main activation and exercises live command and view paths', async () => {
    const fixture = createHostFixture();
    const previousTimeout = process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS;
    process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS = '1000';
    try {
        await withInstalledFixtureEnvironment(
            fixture,
            () => loadSuite(fixture.vscode).run()
        );
    } finally {
        previousTimeout === undefined
            ? delete process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS
            : process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS = previousTimeout;
    }

    assert.deepEqual(fixture.activationCalls, ['main']);
    assert.equal(fixture.bridge.isActive, true, 'both extensions must be active after main activation');
    assert.deepEqual(fixture.executedCommands, [
        'agentPivot.open',
        'agentPivot.dashboard.focus',
    ]);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 rejects a missing bridge dependency before activation', async () => {
    const fixture = createHostFixture();
    fixture.main.packageJSON.extensionDependencies = [];
    const previousTimeout = process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS;
    process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS = '1000';
    try {
        await assert.rejects(
            withInstalledFixtureEnvironment(
                fixture,
                () => loadSuite(fixture.vscode).run()
            ),
            /extensionDependencies/
        );
    } finally {
        previousTimeout === undefined
            ? delete process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS
            : process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS = previousTimeout;
    }
    assert.deepEqual(fixture.activationCalls, []);
});

// RELEASE-SCHEDULED-EXTENSION-HOST-001
test('RELEASE-SCHEDULED-EXTENSION-HOST-001 rejects missing production command registration mutation', () => {
    assertPublicCommandRegistration();
    assert.throws(() => assertPublicCommandRegistration(source => source.replace(
        "['agentPivot.open', 'open'],",
        ''
    )), /RELEASE-SCHEDULED-EXTENSION-HOST-001/);
});

// WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001
test('WEBVIEW-DASHBOARD-COMMAND-AVAILABILITY-001 rejects an incomplete immediate Extension Host command surface', async () => {
    const fixture = createHostFixture(publicCommands.slice(1));
    const previousTimeout = process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS;
    process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS = '1000';
    try {
        await assert.rejects(
            withInstalledFixtureEnvironment(
                fixture,
                () => loadSuite(fixture.vscode).run()
            ),
            /every public Agent Pivot command/
        );
    } finally {
        previousTimeout === undefined
            ? delete process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS
            : process.env.AGENT_PIVOT_EXTENSION_HOST_TIMEOUT_MS = previousTimeout;
    }
});
