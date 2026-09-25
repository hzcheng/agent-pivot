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

test('MANAGED-REMOTE-MANAGEMENT-004 adoption review binds the current SSH target and Project path', async () => {
    const ui = new ScriptedWizardUi([
        { action: 'accept', value: 'API host' },
        { action: 'accept', value: 'api.example.com' },
        { action: 'accept', value: 'dev' },
        { action: 'accept', value: '22022' },
        { action: 'accept', value: true },
    ]);
    const result = await new ManagedRemotePromptController(ui).adoptCurrentSshProject({
        name: 'API', remotePath: '/work/api', sshAlias: 'legacy-api',
    });

    assert.deepEqual(result, {
        name: 'API host', host: 'api.example.com', user: 'dev', port: 22022,
    });
    assert.equal(ui.inputs[0].title, 'Save Current Project — Add Machine');
    assert.equal(ui.picks[0].items[0].label, 'Save Machine and Project');
    assert.match(ui.picks[0].items[0].detail, /Current SSH target: legacy-api · Project: \/work\/api/u);
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

test('MANAGED-REMOTE-MANAGEMENT-004 saves an open SSH project with one review and no repeated endpoint fields', async () => {
    const ui = new ScriptedWizardUi([{ action: 'accept', value: 'save' }]);
    const inspected = [];
    const controller = new ManagedRemotePromptController(ui, {
        async inspect(alias) { inspected.push(alias); return { endpoint: { host: 'home.internal', user: 'dev', port: 22 } }; },
    });
    const result = await controller.adoptCurrentSshProject({ name: 'api', remotePath: '/work/api', sshAlias: 'infra-home-inux' });
    assert.deepEqual(inspected, ['infra-home-inux']);
    assert.equal(ui.inputs.length, 0);
    assert.equal(result.sshConfigAlias, 'infra-home-inux');
    assert.match(ui.picks[0].items[0].detail, /\/work\/api/);
});

test('MANAGED-REMOTE-MANAGEMENT-004 browses remote folders and defaults the saved project name', async () => {
    const ui = new ScriptedWizardUi([
        { action: 'accept', value: 'folder-id' },
        { action: 'accept', value: 'save' },
        { action: 'accept', value: 'api' },
    ]);
    const calls = [];
    const controller = new ManagedRemotePromptController(ui, {
        async browse(machineId, directoryId) {
            calls.push([machineId, directoryId]);
            return { displayPath: directoryId ? '/work/api' : '/work', entries: directoryId ? [] : [{ id: 'folder-id', name: 'api', kind: 'directory' }] };
        },
    });
    const result = await controller.addProject({ id: 'home', name: 'Home' }, [{ id: 'host:home', kind: 'host' }]);
    assert.deepEqual(calls, [['home', undefined], ['home', 'folder-id']]);
    assert.equal(ui.inputs[0].value, 'api');
    assert.deepEqual(result, { environmentId: 'host:home', name: 'api', remotePath: '/work/api' });
});

test('MANAGED-REMOTE-MANAGEMENT-004 failed browsing allows a manual path without losing placement', async () => {
    const ui = new ScriptedWizardUi([
        { action: 'accept', value: 'manual' },
        { action: 'accept', value: '/work/api' },
        { action: 'accept', value: 'api' },
    ]);
    const controller = new ManagedRemotePromptController(ui, { async browse() { throw new Error('Authenticate the jump host first.'); } });
    const result = await controller.addProject({ id: 'home', name: 'Home' }, [{ id: 'host:home', kind: 'host' }]);
    assert.equal(result.environmentId, 'host:home');
    assert.match(ui.picks[0].items[0].detail, /Authenticate/);
});

test('MANAGED-REMOTE-MANAGEMENT-004 import discovers existing aliases and keeps manual fallback', async () => {
    const endpoint = { host: 'home.internal', user: 'dev', port: 22 };
    const inspected = [];
    const connections = {
        async listAliases() { return ['home', '*', 'home']; },
        async inspect(alias) { inspected.push(alias); return { status: 'supported', endpoint }; },
    };
    const ui = new ScriptedWizardUi([{ action: 'accept', value: 'home' }, { action: 'accept', value: 'save' }]);
    const machine = await new ManagedRemotePromptController(ui, connections).importMachine();
    assert.equal(machine.sshConfigAlias, 'home');
    assert.deepEqual(ui.picks[0].items.map(value => value.value), ['home', '']);
    assert.equal(ui.inputs.length, 0);
    const manual = new ScriptedWizardUi([{ action: 'accept', value: '' }, { action: 'accept', value: 'other' }, { action: 'accept', value: 'save' }]);
    assert.equal((await new ManagedRemotePromptController(manual, connections).importMachine()).sshConfigAlias, 'other');
    const unavailable = new ScriptedWizardUi([{ action: 'accept', value: 'manual' }, { action: 'accept', value: 'save' }]);
    await new ManagedRemotePromptController(unavailable, { ...connections, async listAliases() { throw new Error('unreadable config'); } }).importMachine();
    assert.deepEqual(inspected, ['home', 'other', 'manual']);
});

test('MANAGED-REMOTE-MANAGEMENT-004 deletion previews impact and distinguishes recovery deletion from cancellation', async () => {
    let confirmation;
    const ui = new ScriptedWizardUi([{ action: 'accept', value: null }, { action: 'cancel' }]);
    ui.confirm = async message => { confirmation = message; return true; };
    const prompts = new ManagedRemotePromptController(ui);
    await prompts.confirmRemoveMachine({ name: 'Build', connection: { user: 'dev', host: 'build', port: 22 } }, { projectCount: 3, environmentCount: 2 });
    assert.match(confirmation, /3 saved Projects across 2 Environments/);
    assert.match(confirmation, /all synced computers/);
    assert.match(confirmation, /Remote files, containers, and SSH configuration are not deleted/);
    const project = { id: 'p', name: 'API', remotePath: '/api', environmentId: 'env' };
    assert.equal(await prompts.resolveProjectConflict('p', [project, null]), null);
    assert.equal(await prompts.resolveProjectConflict('p', [project, null]), undefined);
});

test('MANAGED-REMOTE-MANAGEMENT-004 Host conflict does not offer an invalid standalone deletion', async () => {
    const host = { id: 'host', name: 'Host', kind: 'host', machineId: 'machine' };
    const ui = new ScriptedWizardUi([{ action: 'accept', value: host }]);
    assert.deepEqual(await new ManagedRemotePromptController(ui).resolveEnvironmentConflict('host', [host, null], 4), host);
    assert.equal(ui.picks[0].items.length, 1);
    assert.match(ui.picks[0].items[0].detail, /remove its Machine/);
});

test('MANAGED-REMOTE-MANAGEMENT-004 orphan conflicts offer only executable deletion or cancellation', async () => {
    const project = { id: 'p', name: 'API', remotePath: '/api', environmentId: 'removed-env' };
    const host = { id: 'removed-env', name: 'Host', kind: 'host', machineId: 'removed-machine' };
    const ui = new ScriptedWizardUi([{ action: 'accept', value: null }, { action: 'cancel' }]);
    const prompts = new ManagedRemotePromptController(ui);
    assert.equal(await prompts.resolveProjectConflict('p', [project, null], {}), null);
    assert.deepEqual(ui.picks[0].items.map(value => value.value), [null]);
    assert.match(ui.picks[0].items[0].detail, /parent Environment was removed/);
    assert.equal(await prompts.resolveEnvironmentConflict(host.id, [host, null], 1, {}), undefined);
    assert.deepEqual(ui.picks[1].items.map(value => value.value), [null]);
    assert.match(ui.picks[1].items[0].detail, /parent Machine was removed/);
});

test('MANAGED-REMOTE-MANAGEMENT-004 orphan cleanup is an explicit removal intent, not a fabricated conflict version', async () => {
    const project = { id: 'p', name: 'New project', remotePath: '/new', environmentId: 'removed-env' };
    const candidates = [project];
    const ui = new ScriptedWizardUi([{ action: 'accept', value: null }]);
    assert.equal(await new ManagedRemotePromptController(ui).resolveProjectConflict('p', candidates, {}, true), null);
    assert.match(ui.picks[0].items[0].label, /Remove orphan Project record/);
    assert.deepEqual(candidates, [project], 'raw causal candidates remain unchanged');
});

test('SSH import preserves the selected prefixed alias and shows its name and route', async () => {
    const ui = new ScriptedWizardUi([{ action: 'accept', value: 'infra-home-linux' }, { action: 'accept', value: 'save' }]);
    const controller = new ManagedRemotePromptController(ui, {
        async listAliases() { return ['home-linux', 'infra-home-linux']; },
        async inspect(alias) {
            assert.equal(alias, 'infra-home-linux');
            return { endpoint: { host: '192.0.2.10', user: 'dev', port: 22 }, route: { kind: 'jump', jumpHosts: 'gateway' } };
        },
    });
    const machine = await controller.importMachine();
    assert.equal(machine.name, 'infra-home-linux');
    assert.equal(machine.sshConfigAlias, 'infra-home-linux');
    assert.deepEqual(machine.sourceSshAliases, ['infra-home-linux']);
    const review = ui.picks[1].items[0];
    assert.equal(review.label, 'Save infra-home-linux');
    assert.match(review.detail, /Via gateway.*Machine name: infra-home-linux.*connection not tested/);
});

test('SSH import blocks inactive configuration before offering Save', async () => {
    const ui = new ScriptedWizardUi([{ action: 'accept', value: 'infra-home-linux' }]);
    const controller = new ManagedRemotePromptController(ui, {
        async listAliases() { return ['infra-home-linux']; },
        async inspect() { return { status: 'needsInput', configurationMatched: false, endpoint: { host: 'infra-home-linux', user: 'default-user', port: 22 }, reason: 'No active Host configuration; check Include scope.' }; },
    });
    await assert.rejects(controller.importMachine(), /Include scope/);
    assert.equal(ui.picks.length, 1);
});

test('Saving an already connected DNS target still works with global SSH defaults', async () => {
    const ui = new ScriptedWizardUi([{ action: 'accept', value: 'save' }]);
    const controller = new ManagedRemotePromptController(ui, {
        async inspect() { return { configurationMatched: false, endpoint: { host: 'build.example.com', user: 'dev', port: 22 } }; },
    });
    const machine = await controller.adoptCurrentSshProject({ name: 'API', remotePath: '/work/api', sshAlias: 'build.example.com' });
    assert.equal(machine.sshConfigAlias, 'build.example.com');
});
