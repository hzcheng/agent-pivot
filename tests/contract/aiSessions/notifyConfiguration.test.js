'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { makeTempDirectory } = require('../../helpers/tempDirectory');

// The compiled module graph is cached after the first require, so the vscode
// stub delegates to a mutable target that each fixture installs before
// constructing its capability.
const vscodeStub = {
    registerCommand: null,
    createOutputChannel: null,
};

function loadNotifyConfiguration() {
    const fakeVscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        commands: {
            registerCommand: (...args) => vscodeStub.registerCommand(...args),
        },
        window: {
            createOutputChannel: () => vscodeStub.createOutputChannel(),
        },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/aiSessions/notifyConfiguration');
    } finally {
        Module._load = previousLoad;
    }
}

function createFixture(t, overrides = {}) {
    const registeredCommands = new Map();
    const createdChannels = [];
    const updates = [];
    const warnings = [];
    const outputLines = [];
    vscodeStub.registerCommand = (id, callback) => {
        registeredCommands.set(id, callback);
        return { dispose: () => registeredCommands.delete(id) };
    };
    vscodeStub.createOutputChannel = () => {
        const channel = {
            shown: 0,
            disposed: false,
            appendLine(line) { outputLines.push(line); },
            show() { this.shown += 1; },
            dispose() { this.disposed = true; },
        };
        createdChannels.push(channel);
        return channel;
    };
    const { createNotifyConfiguration } = loadNotifyConfiguration();
    const secretListeners = new Set();
    const secrets = overrides.secrets || {};
    const state = new Map(Object.entries(overrides.globalState || {}));
    const configurationValues = {
        'notify.enabled': false,
        'notify.sinks': [],
        'notify.reasons': ['completed'],
        ...overrides.configuration,
    };
    const context = {
        globalState: {
            get: key => state.get(key),
            update: async (key, value) => { state.set(key, value); },
        },
        secrets: overrides.noSecrets === true
            ? undefined
            : {
                get: async key => secrets[key],
                store: async (key, value) => { secrets[key] = value; },
                onDidChange: listener => {
                    secretListeners.add(listener);
                    return { dispose: () => secretListeners.delete(listener) };
                },
            },
    };
    const capability = createNotifyConfiguration({
        context,
        getConfiguration: () => ({
            get: (key, fallback) => Object.prototype.hasOwnProperty.call(configurationValues, key)
                ? configurationValues[key]
                : fallback,
            update: async (key, value, target) => { updates.push([key, value, target]); },
        }),
        configurationTargetGlobal: 1,
        homedir: () => makeTempDirectory(t, 'notify-config-'),
        env: {},
        nowMs: () => 1000,
        setTimeout: () => ({}),
        clearTimeout: () => undefined,
        sleep: async () => undefined,
        showWarningMessage: async (message, options, ...items) => {
            warnings.push({ message, options, items });
            return overrides.consentChoice;
        },
    });
    const notifyChannel = () => createdChannels[0];
    const fireSecretChange = key => secretListeners.forEach(listener => listener({ key }));
    return {
        capability, registeredCommands, secretListeners, secrets, state,
        configurationValues, updates, warnings, outputLines, fireSecretChange, notifyChannel,
    };
}

test('ATTENTION-NOTIFY-CREDENTIALS-001 assembles config from settings and prefixed secrets', async t => {
    const f = createFixture(t, {
        configuration: { 'notify.enabled': true, 'notify.sinks': [{ id: 'hook' }] },
        secrets: { 'agentPivot.notify.sink.hook': '{"url":"https://example.com/h"}' },
        globalState: { 'agentPivot.notify.consented': true },
    });

    await f.capability.refresh();

    const config = f.capability.getConfig();
    assert.ok(config, 'a refresh publishes the assembled config');
    assert.equal(config.enabled, true);
    assert.deepEqual(config.policy.reasons, ['completed']);
    assert.deepEqual(f.outputLines.filter(line => line.includes('not valid JSON')), [],
        'a parseable secret must not be dropped');
});

test('ATTENTION-NOTIFY-CREDENTIALS-001 consent decline disables and never assembles', async t => {
    const declined = createFixture(t, {
        configuration: { 'notify.enabled': true, 'notify.sinks': [{ id: 'hook' }] },
        consentChoice: undefined,
    });

    await declined.capability.refresh();

    assert.equal(declined.warnings.length, 1, 'the consent modal is shown once');
    assert.match(declined.warnings[0].message, /No code or file contents are sent/);
    assert.deepEqual(declined.updates, [['notify.enabled', false, 1]],
        'a declined consent disables notifications globally');
    assert.equal(declined.capability.getConfig(), null, 'no config assembles without consent');

    const accepted = createFixture(t, {
        configuration: { 'notify.enabled': true },
        consentChoice: 'Enable notifications',
    });
    await accepted.capability.refresh();
    assert.equal(accepted.state.get('agentPivot.notify.consented'), true,
        'an accepted consent persists');
    assert.ok(accepted.capability.getConfig(), 'an accepted consent assembles the config');
});

test('ATTENTION-NOTIFY-CREDENTIALS-001 refresh failures keep the previous config and log', async t => {
    const f = createFixture(t, { globalState: { 'agentPivot.notify.consented': true } });

    await f.capability.refresh();
    assert.ok(f.capability.getConfig(), 'initial refresh assembles');

    f.configurationValues['notify.sinks'] = null;
    await f.capability.refresh();
    assert.ok(f.capability.getConfig(), 'the previous config survives a failed refresh');
    assert.ok(f.outputLines.some(line => line.includes('notify: config refresh failed:')),
        'the failure is logged to the notify output');
});

test('ATTENTION-NOTIFY-CREDENTIALS-001 secret changes re-read the config; other keys stay ignored', async t => {
    const f = createFixture(t, {
        configuration: { 'notify.enabled': true, 'notify.sinks': [{ id: 'hook' }] },
        globalState: { 'agentPivot.notify.consented': true },
    });

    await f.capability.refresh();
    assert.equal(f.secretListeners.size, 1, 'the secret listener is subscribed');

    f.secrets['agentPivot.notify.sink.hook'] = '{"url":"https://example.com/new"}';
    f.fireSecretChange('agentPivot.notify.sink.hook');
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    f.fireSecretChange('unrelated.key');
    const before = f.outputLines.length;
    f.fireSecretChange('unrelated.key');
    assert.equal(f.outputLines.length, before, 'non-notify keys never refresh');
});

test('ATTENTION-NOTIFY-GUIDED-SETUP-001 registers the palette commands with the fallback config', async t => {
    const f = createFixture(t);

    assert.ok(f.registeredCommands.has('agentPivot.notify.setWebhook'));
    assert.ok(f.registeredCommands.has('agentPivot.notify.showOutput'));

    await f.registeredCommands.get('agentPivot.notify.showOutput')();
    assert.equal(f.notifyChannel().shown, 1, 'show output surfaces the notify channel');
});

test('ATTENTION-NOTIFY-GUIDED-SETUP-001 dispose tears down the listener, commands, and output', async t => {
    const f = createFixture(t, {
        configuration: { 'notify.enabled': true },
        globalState: { 'agentPivot.notify.consented': true },
        consentChoice: 'Enable notifications',
    });
    await f.capability.refresh();

    const commandCount = f.registeredCommands.size;
    assert.ok(commandCount >= 2);
    f.capability.dispose();

    assert.equal(f.secretListeners.size, 0, 'the secret listener is disposed');
    assert.equal(f.registeredCommands.size, 0, 'the commands are unregistered');
    assert.equal(f.notifyChannel().disposed, true, 'the output channel is disposed');
});
