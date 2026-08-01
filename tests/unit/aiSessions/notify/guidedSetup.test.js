'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../../helpers/fakeVscode');

// ATTENTION-NOTIFY-GUIDED-SETUP-001

const COMMANDS_PATH = '../../../../out/aiSessions/notifyIntegration/commands';
const OUTPUT_PATH = '../../../../out/aiSessions/notifyIntegration/output';

function loadHarness(script) {
    const infoMessages = [];
    const warnings = [];
    const updates = [];
    const registered = {};
    const settings = new Map(Object.entries(script.settings || {}));
    const storedSecrets = new Map(Object.entries(script.storedSecrets || {}));
    const inputBoxes = [...(script.inputBoxes || [])];

    const configuration = {
        get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
        update: async (key, value) => { updates.push([key, value]); settings.set(key, value); },
    };
    const channel = {
        lines: [],
        shown: 0,
        disposed: 0,
        appendLine(line) { this.lines.push(line); },
        show() { this.shown += 1; },
        dispose() { this.disposed += 1; },
    };
    const fakeVscode = createFakeVscode({
        window: {
            showQuickPick: async () => script.quickPick,
            showInputBox: async () => (inputBoxes.length ? inputBoxes.shift() : undefined),
            showInformationMessage: async (message, ...items) => {
                infoMessages.push({ message, items });
                return script.infoResponse;
            },
            showWarningMessage: async message => { warnings.push(message); return undefined; },
            createOutputChannel: () => channel,
        },
        workspace: { getConfiguration: () => configuration },
        commands: {
            registerCommand: (id, callback) => {
                registered[id] = callback;
                return { dispose: () => { delete registered[id]; } };
            },
        },
        ConfigurationTarget: { Global: 1 },
    });

    const previousLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'vscode') {
            return fakeVscode;
        }
        return previousLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve(COMMANDS_PATH)];
        delete require.cache[require.resolve(OUTPUT_PATH)];
        const commands = require(COMMANDS_PATH);
        const output = require(OUTPUT_PATH);
        const context = script.withoutSecrets ? {} : {
            secrets: {
                get: async key => storedSecrets.get(key),
                store: async (key, value) => { storedSecrets.set(key, value); },
            },
        };
        commands.registerNotifyCommands(context, {
            output: { log: () => {}, show: () => { channel.shown += 1; } },
            getConfig: () => script.config || { sinks: [] },
            globalProxy: () => '',
        });
        return {
            registered, settings, storedSecrets, updates, infoMessages, warnings, channel,
        };
    } finally {
        Module._load = previousLoad;
    }
}

test('ntfy 全流程:写骨架、存凭据、提议启用', async () => {
    const harness = loadHarness({
        quickPick: 'ntfy',
        inputBoxes: ['s1', '', 'random-topic-32', ''],
        infoResponse: 'Enable notifications',
    });
    await harness.registered['agentPivot.notify.setWebhook']();
    assert.deepEqual(harness.settings.get('notify.sinks'), [
        { id: 's1', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', priority: 4 },
    ]);
    assert.deepEqual(
        JSON.parse(harness.storedSecrets.get('agentPivot.notify.sink.s1')),
        { topic: 'random-topic-32', token: null });
    assert.equal(harness.settings.get('notify.enabled'), true);
});

test('同名骨架已存在时只轮换凭据,不重写设置', async () => {
    const skeleton = { id: 's1', channel: 'ntfy', proxy: null, baseUrl: 'https://ntfy.sh', priority: 5 };
    const harness = loadHarness({
        quickPick: 'ntfy',
        inputBoxes: ['s1', 'new-topic', 'tok'],
        settings: { 'notify.sinks': [skeleton], 'notify.enabled': true },
    });
    await harness.registered['agentPivot.notify.setWebhook']();
    assert.equal(harness.updates.some(([key]) => key === 'notify.sinks'), false);
    assert.deepEqual(harness.settings.get('notify.sinks'), [skeleton]);
    assert.deepEqual(
        JSON.parse(harness.storedSecrets.get('agentPivot.notify.sink.s1')),
        { topic: 'new-topic', token: 'tok' });
});

test('同名骨架通道不同则拒绝,不写凭据', async () => {
    const harness = loadHarness({
        quickPick: 'ntfy',
        inputBoxes: ['s1'],
        settings: { 'notify.sinks': [{ id: 's1', channel: 'slack', proxy: null }] },
    });
    await harness.registered['agentPivot.notify.setWebhook']();
    assert.ok(harness.warnings.some(line => line.includes('already uses channel "slack"')));
    assert.equal(harness.storedSecrets.size, 0);
});

test('custom 通道只存凭据并提示手写骨架', async () => {
    const harness = loadHarness({
        quickPick: 'custom',
        inputBoxes: ['c1', 'https://hook.example/x'],
        settings: { 'notify.enabled': true },
    });
    await harness.registered['agentPivot.notify.setWebhook']();
    assert.equal(harness.updates.some(([key]) => key === 'notify.sinks'), false);
    assert.deepEqual(
        JSON.parse(harness.storedSecrets.get('agentPivot.notify.sink.c1')),
        { url: 'https://hook.example/x' });
    assert.ok(harness.infoMessages.some(entry => entry.message.includes('bodyTemplate')));
});

test('凭据字段按 Esc 时明确告知未存储', async () => {
    const harness = loadHarness({
        quickPick: 'ntfy',
        inputBoxes: ['s1', 'https://ntfy.sh', undefined],
    });
    await harness.registered['agentPivot.notify.setWebhook']();
    assert.equal(harness.storedSecrets.size, 0);
    assert.ok(harness.infoMessages.some(entry => entry.message.includes('no credential was stored')));
});

test('宿主没有 SecretStorage 时给出版本警告', async () => {
    const harness = loadHarness({ withoutSecrets: true, quickPick: 'ntfy' });
    await harness.registered['agentPivot.notify.setWebhook']();
    assert.ok(harness.warnings.some(line => line.includes('1.53')));
});

test('sendTest 无可用 sink 时给出提示并打开日志', async () => {
    const harness = loadHarness({ config: { sinks: [] } });
    await harness.registered['agentPivot.notify.sendTest']();
    assert.ok(harness.warnings.some(line => line.includes('no notification sink')));
    assert.equal(harness.channel.shown, 1);
});

test('output channel 打时间戳、show 与 dispose 委托', () => {
    const appended = [];
    let shown = 0;
    let disposed = 0;
    const channel = {
        appendLine: line => appended.push(line),
        show: () => { shown += 1; },
        dispose: () => { disposed += 1; },
    };
    const previousLoad = Module._load;
    const fakeVscode = createFakeVscode({
        window: { createOutputChannel: () => channel },
    });
    Module._load = function load(request, parent, isMain) {
        if (request === 'vscode') {
            return fakeVscode;
        }
        return previousLoad.call(this, request, parent, isMain);
    };
    try {
        delete require.cache[require.resolve(OUTPUT_PATH)];
        const { createNotifyOutputChannel } = require(OUTPUT_PATH);
        const out = createNotifyOutputChannel();
        out.log('hello');
        out.show();
        out.dispose();
    } finally {
        Module._load = previousLoad;
    }
    assert.equal(appended.length, 1);
    assert.match(appended[0], /^\[\d{4}-\d{2}-\d{2}T.*\] hello$/u);
    assert.equal(shown, 1);
    assert.equal(disposed, 1);
});
