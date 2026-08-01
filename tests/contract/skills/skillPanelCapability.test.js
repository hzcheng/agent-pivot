'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

function loadSkillPanelCapability() {
    const fakeVscode = {
        ConfigurationTarget: { Global: 1, Workspace: 2 },
        Uri: {
            file: value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value }),
            parse: value => ({ scheme: 'file', fsPath: value, path: value, toString: () => value }),
        },
    };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') return fakeVscode;
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/skills/skillPanelCapability');
    } finally {
        Module._load = previousLoad;
    }
}

const { createSkillPanelCapability } = loadSkillPanelCapability();

function makeRecord(overrides = {}) {
    return {
        name: 'demo-skill',
        dirPath: '/skills/user/demo-skill',
        skillFilePath: '/skills/user/demo-skill/SKILL.md',
        scope: 'user',
        source: 'kimi',
        central: { links: { user: { kimi: true }, project: {} } },
        contentHash: 'hash-a',
        ...overrides,
    };
}

function createFixture(overrides = {}) {
    const calls = [];
    const posted = [];
    const warnings = [];
    const infos = [];
    const prompts = [];
    const quickPicks = [];
    const records = overrides.records || [];
    const dashboardController = {
        getRecords: () => records,
        getPanelView: () => ({ panelView: true }),
        getStoreRoots: () => ({ user: '/skills/user', project: '/repo/.skills' }),
        start: () => calls.push(['start']),
        refresh: async (reason, settlement) => {
            calls.push(['refresh', reason, settlement]);
            return overrides.refreshDelivered !== false;
        },
        dispose: () => calls.push(['dispose']),
        handleDeleteSkill: dirPath => { calls.push(['handleDeleteSkill', dirPath]); return { ok: true }; },
        handleApplyCollectionSuggestion: name => { calls.push(['handleApplyCollectionSuggestion', name]); return { ok: true }; },
        handleDismissCollectionSuggestion: async name => { calls.push(['handleDismissCollectionSuggestion', name]); },
        handleSyncSkill: (source, target) => { calls.push(['handleSyncSkill', source, target]); return { ok: true }; },
        handleCopySkill: (source, target) => { calls.push(['handleCopySkill', source, target]); return { ok: true }; },
        handleSetGlobalSkillProjectAgents: (dirPath, agents) => {
            calls.push(['handleSetGlobalSkillProjectAgents', dirPath, agents]);
            return { ok: true, dirPath: `${dirPath}-applied` };
        },
        handleMoveProjectSkillToGlobal: dirPath => {
            calls.push(['handleMoveProjectSkillToGlobal', dirPath]);
            return { ok: true, dirPath: `${dirPath}-moved` };
        },
        handleCentralToggle: (...args) => { calls.push(['handleCentralToggle', ...args]); return { ok: true }; },
        handleFolderToggle: (...args) => { calls.push(['handleFolderToggle', ...args]); return { ok: true }; },
        handleMoveToFolder: (...args) => { calls.push(['handleMoveToFolder', ...args]); return { ok: true }; },
        handleCreateFolder: (...args) => { calls.push(['handleCreateFolder', ...args]); return { ok: true }; },
        handleRemoveFolder: (...args) => { calls.push(['handleRemoveFolder', ...args]); return { ok: true }; },
        handleCentralize: dirPath => { calls.push(['handleCentralize', dirPath]); return { ok: true }; },
        handleMigrateToCentral: scope => {
            calls.push(['handleMigrateToCentral', scope]);
            return overrides.migrationReport || {
                migrated: ['a', 'b'], drifted: [], deleted: ['dup'], skipped: [], errors: [],
            };
        },
        handleFixSkillDiagnostic: (...args) => { calls.push(['handleFixSkillDiagnostic', ...args]); return { ok: true }; },
    };
    const locationController = {
        getActiveRoot: () => '/skills/user',
        changeInteractively: async () => { calls.push(['changeInteractively']); return true; },
        handleConfigurationChange: async () => { calls.push(['handleConfigurationChange']); return true; },
    };
    const factories = {
        createLocationController: () => locationController,
        createDashboardController: () => dashboardController,
    };
    const capability = createSkillPanelCapability({
        getHomeDir: () => '/home/test',
        getWorkspaceRoot: () => '/repo',
        getWorkspaceRoots: () => ['/repo'],
        hasWorkspace: () => overrides.hasWorkspace !== false,
        groupStore: {},
        readGlobalStorePath: () => '~/.skills',
        writeGlobalStorePath: async () => undefined,
        postMessage: async message => { posted.push(message); return true; },
        refreshDashboard: () => calls.push(['refreshDashboard']),
        isVisible: () => true,
        showInputBox: async options => {
            prompts.push(options);
            return overrides.inputBoxResponses ? overrides.inputBoxResponses.shift() : undefined;
        },
        showQuickPickMany: async (items, options) => {
            quickPicks.push({ items, options });
            return overrides.quickPickResponses ? overrides.quickPickResponses.shift() : undefined;
        },
        showWarningMessage: async (message, options, ...items) => {
            warnings.push({ message, options, items });
            return overrides.warningResponses ? overrides.warningResponses.shift() : undefined;
        },
        showInformationMessage: async message => { infos.push(message); return undefined; },
        showErrorMessage: async () => undefined,
        openTextFile: async fsPath => { calls.push(['openTextFile', fsPath]); },
        logError: (message, error) => { calls.push(['logError', message, String(error)]); },
    }, factories);
    return { capability, calls, posted, warnings, infos, prompts, quickPicks, records, dashboardController, locationController };
}

function scopeActionMessage(overrides = {}) {
    return {
        type: 'skill-scope-action',
        version: 1,
        requestId: 'req-1',
        dirPath: '/skills/user/demo-skill',
        operation: 'apply-to-project',
        ...overrides,
    };
}

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 exposes every production skill handler key', () => {
    const { capability } = createFixture();

    assert.deepEqual(Object.keys(capability.handlers), [
        'delete-skill',
        'apply-skill-collection',
        'dismiss-skill-collection',
        'sync-skill',
        'copy-skill',
        'skill-scope-action',
        'central-toggle-skill',
        'folder-toggle-skill-links',
        'move-skill-to-folder',
        'create-skill-folder',
        'remove-skill-folder',
        'centralize-skill',
        'migrate-skills-to-central',
        'change-global-skills-location',
        'fix-skill-diagnostic',
        'open-skill-file',
    ]);
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 rejects malformed and duplicate scope-action envelopes', async () => {
    const { capability, calls } = createFixture();

    await capability.handlers['skill-scope-action']({ type: 'skill-scope-action', version: 2 });
    await capability.handlers['skill-scope-action'](scopeActionMessage({ operation: 'clone' }));
    await capability.handlers['skill-scope-action'](scopeActionMessage({ extra: true }));
    assert.equal(calls.filter(call => call[0] === 'refresh').length, 0,
        'invalid envelopes must not reach the settlement pipeline');

    const applied = createFixture({
        records: [makeRecord()],
        quickPickResponses: [['kimi'].map(agent => ({ label: 'Kimi', agent }))],
    });
    await applied.capability.handlers['skill-scope-action'](scopeActionMessage());
    await applied.capability.handlers['skill-scope-action'](scopeActionMessage());
    assert.equal(
        applied.calls.filter(call => call[0] === 'handleSetGlobalSkillProjectAgents').length,
        1,
        'a completed requestId settles exactly once',
    );
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 settles apply-to-project through the agent quickpick', async () => {
    const f = createFixture({
        records: [makeRecord()],
        quickPickResponses: [[{ label: 'Kimi', agent: 'kimi' }, { label: 'Codex', agent: 'codex' }]],
    });

    await f.capability.handlers['skill-scope-action'](scopeActionMessage());

    assert.deepEqual(
        f.calls.find(call => call[0] === 'handleSetGlobalSkillProjectAgents'),
        ['handleSetGlobalSkillProjectAgents', '/skills/user/demo-skill', ['kimi', 'codex']],
    );
    const refresh = f.calls.find(call => call[0] === 'refresh');
    assert.deepEqual(refresh[1], 'skill-scope-action');
    assert.deepEqual(refresh[2], {
        version: 1,
        requestId: 'req-1',
        dirPath: '/skills/user/demo-skill',
        operation: 'apply-to-project',
        ok: true,
        code: 'applied',
        resultDirPath: '/skills/user/demo-skill-applied',
    });
    assert.equal(f.quickPicks.length, 1, 'the agent choice is prompted');
    assert.equal(f.posted.length, 0, 'a delivered settlement never falls back to a raw post');
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 falls back to a refresh-failed result when delivery fails', async () => {
    const f = createFixture({
        records: [makeRecord()],
        quickPickResponses: [undefined],
        refreshDelivered: false,
    });

    await f.capability.handlers['skill-scope-action'](scopeActionMessage());

    assert.deepEqual(f.posted, [{
        type: 'skill-scope-action-result',
        version: 1,
        requestId: 'req-1',
        dirPath: '/skills/user/demo-skill',
        operation: 'apply-to-project',
        ok: false,
        code: 'refresh-failed',
        resultDirPath: undefined,
    }]);
    assert.ok(f.calls.some(call => call[0] === 'refreshDashboard'),
        'a lost authoritative refresh rebuilds the dashboard before the raw result');
});

test('PERSIST-AI-SKILL-SCOPE-ACTION-001 settles move-to-global only after the modal choice', async () => {
    const projectRecord = makeRecord({ scope: 'project', dirPath: '/repo/.skills/demo-skill' });
    const declined = createFixture({
        records: [projectRecord],
        warningResponses: ['Cancel'],
    });
    await declined.capability.handlers['skill-scope-action'](scopeActionMessage({
        dirPath: projectRecord.dirPath,
        operation: 'move-to-global',
    }));
    assert.equal(
        declined.calls.filter(call => call[0] === 'handleMoveProjectSkillToGlobal').length,
        0,
        'a declined modal must not move the skill',
    );
    const declinedRefresh = declined.calls.find(call => call[0] === 'refresh');
    assert.equal(declinedRefresh[2].code, 'cancelled');

    const accepted = createFixture({
        records: [makeRecord({ scope: 'project', dirPath: '/repo/.skills/demo-skill' })],
        warningResponses: ['Move to Global'],
    });
    await accepted.capability.handlers['skill-scope-action'](scopeActionMessage({
        dirPath: '/repo/.skills/demo-skill',
        operation: 'move-to-global',
    }));
    assert.deepEqual(
        accepted.calls.find(call => call[0] === 'handleMoveProjectSkillToGlobal'),
        ['handleMoveProjectSkillToGlobal', '/repo/.skills/demo-skill'],
    );
    const acceptedRefresh = accepted.calls.find(call => call[0] === 'refresh');
    assert.equal(acceptedRefresh[2].code, 'moved');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 confirms destructive actions before mutating', async () => {
    const f = createFixture({
        records: [
            makeRecord({ central: undefined }),
            makeRecord({
                central: undefined,
                dirPath: '/skills/user/demo-copy',
                skillFilePath: '/skills/user/demo-copy/SKILL.md',
                contentHash: 'hash-b',
            }),
        ],
        warningResponses: [undefined, undefined],
    });

    await f.capability.handlers['delete-skill']({ dirPath: '/skills/user/demo-skill' });
    assert.match(f.warnings[0].message, /Delete skill "demo-skill" permanently\? This cannot be undone\./);
    await f.capability.handlers['centralize-skill']({ dirPath: '/skills/user/demo-skill' });
    assert.equal(f.calls.filter(call => call[0] === 'handleDeleteSkill').length, 0);
    assert.equal(f.calls.filter(call => call[0] === 'handleCentralize').length, 0);
    assert.match(f.warnings[1].message, /deleted permanently/);
    assert.match(f.warnings[1].message, /different content/, 'drifted duplicates must be flagged');

    const accepted = createFixture({
        records: [makeRecord()],
        warningResponses: ['Delete', 'Centralize'],
    });
    await accepted.capability.handlers['delete-skill']({ dirPath: '/skills/user/demo-skill' });
    await accepted.capability.handlers['centralize-skill']({ dirPath: '/skills/user/demo-skill' });
    assert.deepEqual(
        accepted.calls.filter(call => call[0] === 'handleDeleteSkill'),
        [['handleDeleteSkill', '/skills/user/demo-skill']],
    );
    assert.deepEqual(
        accepted.calls.filter(call => call[0] === 'handleCentralize'),
        [['handleCentralize', '/skills/user/demo-skill']],
    );
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 delegates panel mutations to the controller', async () => {
    const f = createFixture({ inputBoxResponses: ['new-folder'], warningResponses: ['Delete'] });

    await f.capability.handlers['apply-skill-collection']({ name: 'bundle' });
    await f.capability.handlers['dismiss-skill-collection']({ name: 'bundle' });
    await f.capability.handlers['sync-skill']({ sourceDir: '/a', targetDir: '/b' });
    await f.capability.handlers['copy-skill']({ sourceDir: '/a', targetRoot: '/c' });
    await f.capability.handlers['central-toggle-skill']({ dirPath: '/a', scope: 'project', source: 'kimi', enabled: true });
    await f.capability.handlers['folder-toggle-skill-links']({ storeRoot: '/r', folder: 'f', scope: 'user', agent: 'codex', enabled: false });
    await f.capability.handlers['move-skill-to-folder']({ dirPath: '/a', folder: 'f' });
    await f.capability.handlers['create-skill-folder']({ scope: 'project' });
    await f.capability.handlers['remove-skill-folder']({ storeRoot: '/r', folder: 'f' });
    await f.capability.handlers['fix-skill-diagnostic']({ dirPath: '/a', code: 'broken' });

    assert.deepEqual(f.calls, [
        ['handleApplyCollectionSuggestion', 'bundle'],
        ['handleDismissCollectionSuggestion', 'bundle'],
        ['handleSyncSkill', '/a', '/b'],
        ['handleCopySkill', '/a', '/c'],
        ['handleCentralToggle', '/a', 'project', 'kimi', true],
        ['handleFolderToggle', '/r', 'f', 'user', 'codex', false],
        ['handleMoveToFolder', '/a', 'f'],
        ['handleCreateFolder', 'project', 'new-folder'],
        ['handleRemoveFolder', '/r', 'f'],
        ['handleFixSkillDiagnostic', '/a', 'broken'],
    ]);
    assert.equal(f.warnings.length, 1, 'only the folder deletion prompts a confirmation');
    assert.match(f.warnings[0].message, /Only empty folders can be deleted/);
    assert.equal(f.prompts.length, 1, 'the folder name is prompted host-side');
});

test('PERSIST-AI-SKILL-CENTRAL-STORE-001 migrate summarizes the report and skips an empty selection', async () => {
    const empty = createFixture({ records: [makeRecord()] });
    await empty.capability.migrateToCentral();
    assert.deepEqual(empty.infos, ['Every skill is already centralized.']);
    assert.equal(empty.calls.filter(call => call[0] === 'handleMigrateToCentral').length, 0);

    const migratable = makeRecord({ central: undefined, dirPath: '/repo/.agents/skills/demo' });
    const f = createFixture({
        records: [migratable],
        warningResponses: ['Migrate'],
    });
    await f.capability.migrateToCentral('user');
    assert.match(f.warnings[0].message, /Migrate 1 user skill\(s\) into \/skills\/user\?/);
    assert.deepEqual(f.calls.find(call => call[0] === 'handleMigrateToCentral'), ['handleMigrateToCentral', 'user']);
    assert.deepEqual(f.infos, ['Migrated 2 skill(s) into the central stores; 1 duplicate(s) deleted.']);
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 exposes the location controller through the facade', async () => {
    const f = createFixture();

    await f.capability.changeGlobalStoreLocation();
    await f.capability.handleGlobalStoreConfigurationChange();
    await f.capability.handlers['change-global-skills-location']({ type: 'change-global-skills-location' });

    assert.deepEqual(f.calls, [
        ['changeInteractively'],
        ['handleConfigurationChange'],
        ['changeInteractively'],
    ]);
});

test('PERSIST-AI-SKILL-GLOBAL-STORE-LOCATION-001 facade delegates reads, start, and dispose', () => {
    const record = makeRecord();
    const f = createFixture({ records: [record] });

    assert.deepEqual(f.capability.getRecords(), [record]);
    assert.deepEqual(f.capability.getPanelView(), { panelView: true });
    f.capability.start();
    f.capability.dispose();
    assert.deepEqual(f.calls, [['start'], ['dispose']]);
});
