'use strict';

// Covers PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
    GlobalStoreLocationController,
} = require('../../../out/skills/globalStoreLocationController');
const {
    relocateGlobalSkillsStore,
} = require('../../../out/skills/globalStoreService');

function fixture(t) {
    const homeDir = fs.realpathSync(fs.mkdtempSync(
        path.join(os.tmpdir(), 'global-store-controller-'),
    ));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    let setting = '~/.skills';
    const writes = [];
    const warnings = [];
    const errors = [];
    let refreshes = 0;
    let input = undefined;
    let warningChoice = undefined;
    const options = {
        homeDir,
        getWorkspaceRoots: () => [],
        readSetting: () => setting,
        writeSetting: async value => {
            writes.push(value);
            setting = value;
        },
        showInputBox: async () => input,
        showWarningMessage: async (message, _options, ...items) => {
            warnings.push({ message, items });
            return warningChoice;
        },
        showErrorMessage: message => errors.push(message),
        refresh: async () => { refreshes += 1; },
        logError: (message, error) => errors.push(`${message} ${error}`),
    };
    return {
        homeDir,
        options,
        writes,
        warnings,
        errors,
        setSetting(value) { setting = value; },
        setInput(value) { input = value; },
        setWarningChoice(value) { warningChoice = value; },
        getRefreshes() { return refreshes; },
    };
}

function writeSkill(root, name = 'demo') {
    const dirPath = path.join(root, name);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 command cancellation has no effects', async t => {
    const state = fixture(t);
    const controller = new GlobalStoreLocationController(state.options);

    assert.equal(await controller.changeInteractively(), false);
    assert.deepEqual(state.writes, []);
    assert.equal(state.getRefreshes(), 0);
    assert.equal(controller.getActiveRoot(), path.join(state.homeDir, '.skills'));
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 command moves, persists, and refreshes once', async t => {
    const state = fixture(t);
    const oldRoot = path.join(state.homeDir, '.skills');
    const newRoot = path.join(state.homeDir, 'shared', 'skills');
    writeSkill(oldRoot);
    state.setInput(newRoot);
    state.setWarningChoice('Move Existing Skills');
    const controller = new GlobalStoreLocationController(state.options);

    assert.equal(await controller.changeInteractively(), true);
    assert.equal(controller.getActiveRoot(), newRoot);
    assert.deepEqual(state.writes, [newRoot]);
    assert.equal(state.getRefreshes(), 1);
    assert.ok(fs.lstatSync(oldRoot).isSymbolicLink());
    assert.ok(fs.existsSync(path.join(newRoot, 'demo', 'SKILL.md')));
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 direct cancellation restores the previous setting', async t => {
    const state = fixture(t);
    writeSkill(path.join(state.homeDir, '.skills'));
    const controller = new GlobalStoreLocationController(state.options);
    state.setSetting(path.join(state.homeDir, 'other-skills'));
    state.setWarningChoice(undefined);

    assert.equal(await controller.handleConfigurationChange(), false);
    assert.deepEqual(state.writes, ['~/.skills']);
    assert.equal(controller.getActiveRoot(), path.join(state.homeDir, '.skills'));
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 accepts a cross-window compatibility alias without prompting or rollback', async t => {
    const state = fixture(t);
    const oldRoot = path.join(state.homeDir, '.skills');
    const newRoot = path.join(state.homeDir, 'new-global-skills');
    writeSkill(oldRoot);
    const controller = new GlobalStoreLocationController(state.options);

    assert.equal(relocateGlobalSkillsStore(oldRoot, newRoot).ok, true);
    state.setSetting(newRoot);
    assert.equal(await controller.handleConfigurationChange(), true);
    assert.equal(controller.getActiveRoot(), newRoot);
    assert.deepEqual(state.writes, []);
    assert.equal(state.warnings.length, 0);
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 serializes coalesced direct configuration changes', async t => {
    const state = fixture(t);
    writeSkill(path.join(state.homeDir, '.skills'));
    let releaseFirst;
    let warningCalls = 0;
    state.options.showWarningMessage = async (_message, options) => {
        if (!options) {
            return undefined;
        }
        warningCalls += 1;
        if (warningCalls === 1) {
            await new Promise(resolve => { releaseFirst = resolve; });
        }
        return 'Use New Location';
    };
    const controller = new GlobalStoreLocationController(state.options);
    const firstRoot = path.join(state.homeDir, 'first');
    const secondRoot = path.join(state.homeDir, 'second');
    state.setSetting(firstRoot);
    const first = controller.handleConfigurationChange();
    while (!releaseFirst) {
        await new Promise(resolve => setImmediate(resolve));
    }
    state.setSetting(secondRoot);
    const second = controller.handleConfigurationChange();
    releaseFirst();

    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(controller.getActiveRoot(), secondRoot);
    assert.equal(warningCalls, 1);
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 cancelling an older prompt never overwrites a newer setting', async t => {
    const state = fixture(t);
    writeSkill(path.join(state.homeDir, '.skills'));
    let releaseFirst;
    let warningCalls = 0;
    state.options.showWarningMessage = async (_message, options) => {
        if (!options) {
            return undefined;
        }
        warningCalls += 1;
        if (warningCalls === 1) {
            await new Promise(resolve => { releaseFirst = resolve; });
            return undefined;
        }
        return 'Use New Location';
    };
    const controller = new GlobalStoreLocationController(state.options);
    const firstRoot = path.join(state.homeDir, 'cancelled');
    const secondRoot = path.join(state.homeDir, 'newer');
    state.setSetting(firstRoot);
    const first = controller.handleConfigurationChange();
    while (!releaseFirst) {
        await new Promise(resolve => setImmediate(resolve));
    }
    state.setSetting(secondRoot);
    const second = controller.handleConfigurationChange();
    releaseFirst();

    assert.equal(await first, false);
    assert.equal(await second, true);
    assert.equal(controller.getActiveRoot(), secondRoot);
    assert.deepEqual(state.writes, []);
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 save failure keeps the safe session root and reports it', async t => {
    const state = fixture(t);
    const newRoot = path.join(state.homeDir, 'session-only');
    state.setInput(newRoot);
    state.options.writeSetting = async () => { throw new Error('settings unavailable'); };
    const controller = new GlobalStoreLocationController(state.options);

    assert.equal(await controller.changeInteractively(), false);
    assert.equal(controller.getActiveRoot(), newRoot);
    assert.equal(state.getRefreshes(), 1);
    assert.ok(state.errors.some(message => message.includes('could not be saved')));
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 refresh failure cannot block persistence', async t => {
    const state = fixture(t);
    const newRoot = path.join(state.homeDir, 'refresh-failed');
    state.setInput(newRoot);
    state.options.refresh = async () => { throw new Error('webview closed'); };
    const controller = new GlobalStoreLocationController(state.options);

    assert.equal(await controller.changeInteractively(), true);
    assert.equal(controller.getActiveRoot(), newRoot);
    assert.deepEqual(state.writes, [newRoot]);
    assert.ok(state.errors.some(message => message.includes('Failed to refresh Skills')));
});
