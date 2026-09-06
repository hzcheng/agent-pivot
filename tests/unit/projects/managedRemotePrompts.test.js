'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadPromptController() {
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return { QuickInputButtons: { Back: Symbol('Back') } };
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/projects/managedRemote/vscodePrompts');
    } finally {
        Module._load = previousLoad;
    }
}

class ScriptedWizardUi {
    constructor(results) {
        this.results = results.slice();
        this.inputs = [];
        this.picks = [];
    }
    async input(options) {
        this.inputs.push(options);
        return this.results.shift();
    }
    async pick(options) {
        this.picks.push(options);
        return this.results.shift();
    }
    async confirm() { return true; }
}

const { ManagedRemotePromptController } = loadPromptController();

test('MANAGED-REMOTE-MANAGEMENT-004 Machine wizard supports non-22 ports and Back from review', async () => {
    const ui = new ScriptedWizardUi([
        { action: 'accept', value: 'Build' },
        { action: 'accept', value: 'build.example.com' },
        { action: 'accept', value: 'dev' },
        { action: 'accept', value: '2200' },
        { action: 'back' },
        { action: 'accept', value: '2207' },
        { action: 'accept', value: true },
    ]);
    const result = await new ManagedRemotePromptController(ui).addMachine();

    assert.deepEqual(result, {
        name: 'Build', host: 'build.example.com', user: 'dev', port: 2207,
    });
    assert.equal(ui.inputs.at(-1).prompt, 'SSH port');
    assert.match(ui.picks.at(-1).items[0].description, /dev@build\.example\.com:2207/u);
    assert.match(ui.picks.at(-1).items[0].detail, /Passwords and keys are not saved/u);
});

test('MANAGED-REMOTE-MANAGEMENT-004 Machine edit review explains synchronized blast radius', async () => {
    const ui = new ScriptedWizardUi([
        { action: 'accept', value: 'Build 2' },
        { action: 'accept', value: 'new.example.com' },
        { action: 'accept', value: 'ops' },
        { action: 'accept', value: '2222' },
        { action: 'accept', value: true },
    ]);
    const result = await new ManagedRemotePromptController(ui).editMachine({
        id: 'machine-1',
        name: 'Build',
        connection: { kind: 'ssh', host: 'old.example.com', user: 'dev', port: 22 },
    }, 3);

    assert.equal(result.port, 2222);
    assert.equal(ui.picks[0].items[0].label, 'Save Changes to All Computers');
    assert.match(ui.picks[0].items[0].detail, /dev@old\.example\.com:22 → ops@new\.example\.com:2222 · 3 affected Projects/u);
});

test('MANAGED-REMOTE-MANAGEMENT-004 Project wizard keeps placement fixed and reviews Favorite', async () => {
    const ui = new ScriptedWizardUi([
        { action: 'accept', value: 'host-1' },
        { action: 'accept', value: 'API' },
        { action: 'accept', value: '/srv/api' },
        { action: 'accept', value: 'Backend' },
        { action: 'accept', value: 'red, prod' },
        { action: 'accept', value: '#ef4444' },
        { action: 'accept', value: 'toggleFavorite' },
        { action: 'accept', value: 'save' },
    ]);
    const result = await new ManagedRemotePromptController(ui).addProject({
        id: 'machine-1',
        name: 'Build',
        connection: { kind: 'ssh', host: 'build.example.com', user: 'dev', port: 22 },
    }, [{ id: 'host-1', machineId: 'machine-1', kind: 'host', name: 'Host' }]);

    assert.deepEqual(result, {
        environmentId: 'host-1',
        name: 'API',
        remotePath: '/srv/api',
        description: 'Backend',
        tags: ['red', 'prod'],
        color: '#ef4444',
        favorite: true,
    });
    assert.equal(ui.picks.filter(pick => pick.step === 7).length, 2);
});
