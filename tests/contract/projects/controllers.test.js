'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');
const { GroupCollapseController } = require('../../../out/dashboard/groupCollapseController');
const { AddProjectsFromFolderController } = require('../../../out/projects/addProjectsFromFolderController');
const { FavoriteProjectController } = require('../../../out/projects/favoriteProjectController');
const { GroupCommandController } = require('../../../out/projects/groupCommandController');
const { queryGroupName } = require('../../../out/projects/groupPrompts');
const { ProjectOrderController } = require('../../../out/projects/projectOrderController');
const { ProjectRemovalController } = require('../../../out/projects/projectRemovalController');
const { ProjectManualEditController } = require('../../../out/projects/projectManualEditController');
const {
    ProjectOpenType,
    ProjectPathType,
    ProjectRemoteType,
    ReopenStewardReason,
} = require('../../../out/models');

function parseUri(value) {
    const text = String(value);
    const match = text.match(/^([^:]+):\/\/([^/]*)(\/.*)?$/);
    return {
        scheme: match ? match[1] : 'file',
        authority: match ? match[2] : '',
        path: match ? match[3] || '/' : text,
        fsPath: match && match[1] !== 'file' ? match[3] || '/' : text.replace(/^file:\/\//, ''),
        toString: () => text,
    };
}

function loadProjectOpenController() {
    const vscode = createFakeVscode({});
    vscode.Uri = { parse: parseUri, file: parseUri };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return vscode;
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/projects/projectOpenController').ProjectOpenController;
    } finally {
        Module._load = previousLoad;
    }
}

const ProjectOpenController = loadProjectOpenController();

function loadProjectPromptController() {
    const vscode = createFakeVscode({});
    vscode.Uri = { parse: parseUri, file: parseUri };
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return vscode;
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return require('../../../out/projects/projectPromptController').ProjectPromptController;
    } finally {
        Module._load = previousLoad;
    }
}

const ProjectPromptController = loadProjectPromptController();
const { FixedColorOptions } = require('../../../out/constants');

function createPromptControllerFixture(responses) {
    const inputBoxes = [];
    const quickPicks = [];
    const controller = new ProjectPromptController({
        getGroups: () => [{ id: 'group-a', groupName: 'A', projects: [] }],
        addGroup: async () => ({ id: 'group-new' }),
        removeGroup: async () => undefined,
        isFile: () => false,
        isFolderGitRepo: () => false,
        getRandomColor: () => '#ffffff',
        getColorName: () => 'White',
        getRecentColors: () => [],
        getRemoteSshExtensionInstalled: () => false,
        showInputBox: async options => {
            inputBoxes.push(options);
            const respond = responses.inputBox && responses.inputBox[options.placeHolder];
            if (respond === undefined) {
                throw new Error(`unexpected input box: ${options.placeHolder}`);
            }
            return typeof respond === 'function' ? respond(options) : respond;
        },
        showQuickPick: async (items, options) => {
            quickPicks.push(options && options.placeHolder);
            const respond = responses.quickPick && responses.quickPick[options && options.placeHolder];
            if (respond === undefined) {
                throw new Error(`unexpected quick pick: ${options && options.placeHolder}`);
            }
            return typeof respond === 'function' ? respond(items) : respond;
        },
        showOpenDialog: async () => undefined,
    });
    return { controller, inputBoxes, quickPicks };
}

test('PROJECT-TAGS-001 editing prompts for tags prefilled and normalized', async () => {
    const { controller, inputBoxes } = createPromptControllerFixture({
        inputBox: {
            'Project Name': options => options.value,
            'Project Description': options => options.value || '',
            'Tags, comma-separated (optional)': options => `${options.value}, #Urgent, frontend`,
        },
        quickPick: {
            'Edit Path?': items => items[0], // Keep Path
        },
    });

    const template = {
        name: 'API',
        path: '/work/api',
        description: 'Service',
        color: '#aabbcc',
        tags: ['frontend'],
    };
    const [project, groupId, groupWasNewlyCreated] = await controller.queryProjectFields('group-a', true, template);

    assert.equal(groupId, 'group-a');
    assert.equal(groupWasNewlyCreated, false);
    assert.deepEqual(project.tags, ['frontend', 'Urgent']);
    assert.deepEqual(inputBoxes.map(options => options.placeHolder), [
        'Project Name',
        'Project Description',
        'Tags, comma-separated (optional)',
    ], 'the edit flow must ask for tags exactly once, after the description');
    const tagsBox = inputBoxes.find(options => options.placeHolder === 'Tags, comma-separated (optional)');
    assert.equal(tagsBox.value, 'frontend', 'existing tags prefill the edit box');
});

test('PROJECT-TAGS-001 clearing the tags box removes every tag from the project', async () => {
    const { controller } = createPromptControllerFixture({
        inputBox: {
            'Project Name': options => options.value,
            'Project Description': () => '',
            'Tags, comma-separated (optional)': () => '   ',
        },
        quickPick: {
            'Edit Path?': items => items[0],
        },
    });

    const [project] = await controller.queryProjectFields('group-a', true, {
        name: 'API',
        path: '/work/api',
        color: '#aabbcc',
        tags: ['frontend', 'urgent'],
    });

    assert.equal(project.tags, undefined, 'an empty tag list must not persist an empty array');
});

test('PROJECT-TAGS-001 creating a project never prompts for tags', async () => {
    const { controller, inputBoxes } = createPromptControllerFixture({
        inputBox: {
            './': options => options.value,
            'Project Name': options => options.value,
            'Project Description': () => '',
        },
        quickPick: {
            'Project Type': items => items.find(item => item.id === 'manual'),
            'Project Color': items => items.find(item => item.id === FixedColorOptions.none),
        },
    });

    const [project, groupId] = await controller.queryProjectFields('group-a', false, { path: '/work/api' });

    assert.equal(groupId, 'group-a');
    assert.equal(project.name, 'api');
    assert.equal(project.tags, undefined);
    assert.deepEqual(inputBoxes.map(options => options.placeHolder), [
        './',
        'Project Name',
        'Project Description',
    ], 'creation stays fast: path, name, description only');
});

test('PROJECT-ADD-PROJECTS-FROM-FOLDER-CONTROLLER-001 imports child folders and refreshes once', async () => {
    const actions = [];
    const vscode = createFakeVscode({
        window: {
            showOpenDialog: async options => {
                actions.push(['dialog', options.defaultUri, options.openLabel]);
                return [{ fsPath: '/work/tools' }];
            },
            showErrorMessage: message => actions.push(['error', message]),
        },
    });
    const controller = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => '/work/current',
        parsePathAsUri: value => ({ uri: value }),
        showOpenDialog: vscode.window.showOpenDialog,
        getFolders: async folderPath => {
            actions.push(['get-folders', folderPath]);
            return ['/work/tools/api', '/work/tools/web'];
        },
        addGroup: async groupName => {
            actions.push(['add-group', groupName]);
            return { id: 'group-tools' };
        },
        addProject: async (project, groupId) => actions.push([
            'add-project', project.name, project.path, project.color, project.isGitRepo, groupId,
        ]),
        getRandomColor: () => '#abcdef',
        isFolderGitRepo: folder => folder.endsWith('/api'),
        showErrorMessage: vscode.window.showErrorMessage,
        refreshAfterMutation: () => actions.push(['refresh']),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addProjectsFromFolder();
    assert.deepEqual(actions, [
        ['dialog', { uri: '/work/current' }, 'Select Folder containing Projects'],
        ['get-folders', '/work/tools'],
        ['add-group', 'tools'],
        ['add-project', 'api', '/work/tools/api', '#abcdef', true, 'group-tools'],
        ['add-project', 'web', '/work/tools/web', '#abcdef', false, 'group-tools'],
        ['refresh'],
    ]);
});

test('PROJECT-ADD-PROJECTS-FROM-FOLDER-CONTROLLER-001 treats dialog and token cancellation as no-ops', async () => {
    let selection = [];
    const refreshModes = [];
    let errors = 0;
    const controller = new AddProjectsFromFolderController({
        getCurrentWorkspacePath: () => null,
        parsePathAsUri: parseUri,
        showOpenDialog: async () => selection,
        getFolders: async () => { throw new Error('CanceledByUser'); },
        addGroup: async () => ({ id: 'unused' }),
        addProject: async () => undefined,
        getRandomColor: () => '#fff',
        isFolderGitRepo: () => false,
        showErrorMessage: () => { errors += 1; },
        refreshAfterMutation: mode => refreshModes.push(mode),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addProjectsFromFolder();
    selection = [{ fsPath: '/work/canceled' }];
    await controller.addProjectsFromFolder();
    assert.deepEqual(refreshModes, []);
    assert.equal(errors, 0);
});

test('PROJECT-FAVORITE-PROJECT-CONTROLLER-001 serializes toggle and drag ordering through save then refresh', async () => {
    let groups = [{
        id: 'group-a',
        projects: [
            { id: 'a', favorite: true, favoriteOrder: 0 },
            { id: 'b', favorite: false },
        ],
    }];
    const events = [];
    const controller = new FavoriteProjectController({
        getGroups: () => groups,
        saveGroups: async nextGroups => {
            events.push('save');
            groups = nextGroups;
        },
        refreshAfterMutation: mode => events.push(['refresh', mode]),
    });

    await controller.toggleProjectFavorite('b');
    await controller.reorderFavoriteProjects(['b', 'a', 'b', 'missing']);
    await controller.toggleProjectFavorite('missing');

    assert.deepEqual(events, [
        'save',
        ['refresh', undefined],
        'save',
        ['refresh', 'preserve-order'],
    ]);
    assert.deepEqual(
        groups[0].projects.filter(project => project.favorite)
            .sort((left, right) => left.favoriteOrder - right.favoriteOrder)
            .map(project => project.id),
        ['b', 'a']
    );
});

test('PROJECT-PROJECT-ORDER-CONTROLLER-001 rebuilds groups from exact drag payload and ignores unknown IDs', async () => {
    const groups = [{
        id: 'group-a', groupName: 'A', projects: [{ id: 'a1' }, { id: 'a2' }],
    }, {
        id: 'group-b', groupName: 'B', projects: [{ id: 'b1' }],
    }];
    const saves = [];
    const messages = [];
    const refreshModes = [];
    const controller = new ProjectOrderController({
        getGroups: () => groups,
        saveGroups: async nextGroups => saves.push(nextGroups),
        showInformationMessage: message => messages.push(message),
        refreshAfterMutation: mode => refreshModes.push(mode),
    });

    await controller.reorderGroups(null);
    assert.deepEqual(messages, ['Invalid Argument passed to Reordering Projects.']);
    assert.deepEqual(refreshModes, []);

    await controller.reorderGroups([
        { groupId: 'group-b', projectIds: ['b1', 'a1'] },
        { groupId: 'new-group', projectIds: ['a2', 'missing'] },
    ]);
    assert.deepEqual(saves[0].map(group => ({
        name: group.groupName,
        projects: group.projects.map(project => project.id),
    })), [
        { name: 'B', projects: ['b1', 'a1'] },
        { name: 'Group #2', projects: ['a2'] },
    ]);
    assert.deepEqual(refreshModes, ['preserve-order']);
});

test('PROJECT-GROUP-COLLAPSE-CONTROLLER-001 persists virtual and saved group collapse state', async () => {
    const stateUpdates = [];
    const groupUpdates = [];
    const groups = new Map([
        ['group-a', { id: 'group-a', collapsed: false }],
        ['group-b', { id: 'group-b', collapsed: true }],
    ]);
    const controller = new GroupCollapseController({
        state: {
            get: key => key === 'favoritesGroupCollapsed' ? true : undefined,
            update: async (key, value) => stateUpdates.push([key, value]),
        },
        projectService: {
            getGroup: id => groups.get(id) || null,
            updateGroup: async (id, group) => groupUpdates.push([id, { ...group }]),
        },
    });

    assert.equal(controller.getFavoritesCollapsed(), true);
    await controller.collapseGroup('__favorites', false);
    await controller.collapseGroup('group-a');
    await controller.collapseGroup('group-b', false);
    await controller.collapseGroup('missing', true);

    assert.deepEqual(stateUpdates, [
        ['favoritesGroupCollapsed', false],
    ]);
    assert.deepEqual(groupUpdates, [
        ['group-a', { id: 'group-a', collapsed: true }],
        ['group-b', { id: 'group-b', collapsed: false }],
    ]);
});

test('PROJECT-GROUP-PROMPT-001 validates names and reports cancellation with the public token', async () => {
    let promptOptions;
    const name = await queryGroupName({
        showInputBox: async options => {
            promptOptions = options;
            return 'Renamed';
        },
    }, 'Existing');

    assert.equal(name, 'Renamed');
    assert.equal(promptOptions.value, 'Existing');
    assert.deepEqual(promptOptions.valueSelection, [0, 8]);
    assert.equal(promptOptions.validateInput(''), 'A Group Name must be provided.');
    assert.equal(promptOptions.validateInput('Group'), '');
    await assert.rejects(() => queryGroupName({ showInputBox: async () => undefined }), /CanceledByUser/);
});

test('PROJECT-GROUP-COMMAND-CONTROLLER-001 mutates groups and suppresses only user cancellation', async () => {
    const groups = new Map([['group-a', { id: 'group-a', groupName: 'Old' }]]);
    const events = [];
    const errors = [];
    let nextPrompt = 'New';
    let confirmed = true;
    const controller = new GroupCommandController({
        projectService: {
            addGroup: async name => events.push(['add', name]),
            getGroup: id => groups.get(id) || null,
            updateGroup: async (id, group) => events.push(['update', id, { ...group }]),
            removeGroup: async id => events.push(['remove', id]),
        },
        promptGroupName: async defaultText => {
            events.push(['prompt', defaultText || null]);
            if (nextPrompt instanceof Error) throw nextPrompt;
            return nextPrompt;
        },
        promptGroupToRemove: async () => ['group-a', false],
        confirmRemoveGroup: async name => {
            events.push(['confirm', name]);
            return confirmed ? 'Remove' : undefined;
        },
        showErrorMessage: message => errors.push(message),
        refreshAfterMutation: () => events.push(['refresh']),
        userCanceledToken: 'CanceledByUser',
    });

    await controller.addGroup();
    await controller.editGroup('group-a');
    await controller.removeGroupPerCommand();
    nextPrompt = new Error('CanceledByUser');
    await controller.addGroup();
    assert.equal(errors.length, 0);
    confirmed = false;
    await controller.removeGroup('group-a');
    assert.equal(events.filter(event => event[0] === 'remove').length, 1);

    nextPrompt = new Error('boom');
    await assert.rejects(() => controller.editGroup('group-a'), /boom/);
    assert.deepEqual(errors, ['An error occured while editing the group.']);
});

test('PROJECT-PROJECT-REMOVAL-CONTROLLER-001 honors picker and confirmation cancellation', async () => {
    const events = [];
    let selected = { id: 'project-a', label: 'Alpha' };
    let confirmed = 'Remove';
    const project = { id: 'project-a', name: 'Alpha' };
    const controller = new ProjectRemovalController({
        getProject: id => id === project.id ? project : null,
        getProjectsFlat: () => [project],
        showProjectPicker: async picks => {
            events.push(['picker', picks]);
            return selected;
        },
        confirmRemoveProject: async name => {
            events.push(['confirm', name]);
            return confirmed;
        },
        removeProject: async id => events.push(['remove', id]),
        refreshAfterMutation: () => events.push(['refresh']),
        postCommandRemoval: () => events.push(['post-command']),
    });

    await controller.removeProjectPerCommand();
    selected = undefined;
    await controller.removeProjectPerCommand();
    await controller.removeProject('project-a');
    confirmed = undefined;
    await controller.removeProject('project-a');
    await controller.removeProject('missing');

    assert.equal(events.filter(event => event[0] === 'remove').length, 2);
    assert.equal(events.filter(event => event[0] === 'refresh').length, 2);
    assert.equal(events.filter(event => event[0] === 'post-command').length, 1);
    assert.deepEqual(events.slice(0, 4).map(event => event[0]), [
        'picker',
        'remove',
        'refresh',
        'post-command',
    ]);
});

test('PROJECT-CATALOG-SYNC-CONFLICT-001 manual editor passes its exported baseline with the edited groups', async () => {
    const exportedGroups = [{
        id: 'group-main',
        groupName: 'Main',
        projects: [{
            id: 'project-a',
            name: 'A',
            path: '/work/a',
        }, {
            id: 'project-b',
            name: 'B',
            path: '/work/b',
        }],
    }];
    const editedGroups = [{
        ...exportedGroups[0],
        projects: [exportedGroups[0].projects[0]],
    }];
    const document = {
        getText: () => JSON.stringify(editedGroups),
    };
    let saveListener;
    const saves = [];
    const controller = new ProjectManualEditController({
        getGroups: () => structuredClone(exportedGroups),
        getTempFilePath: () => '/tmp/agent-pivot-projects.json',
        writeTextFile: async () => undefined,
        fileUri: value => value,
        openTextDocument: async () => document,
        showTextDocument: async () => undefined,
        onWillSaveTextDocument: listener => {
            saveListener = listener;
            return { dispose() {} };
        },
        saveGroups: async (groups, baselineGroups) => {
            saves.push({ groups, baselineGroups });
        },
        executeCommand: async () => undefined,
        showErrorMessage: message => assert.fail(message),
        postSave: () => undefined,
    });

    await controller.editProjectsManually();
    await saveListener({ document });

    assert.deepEqual(saves, [{
        groups: editedGroups,
        baselineGroups: exportedGroups,
    }]);
});

test('OPEN-PROJECT-OPEN-CONTROLLER-001 OPEN-PROJECT-UI-HOST-NAVIGATION-001 maps default and explicit window modes to the UI Bridge', async () => {
    const commands = [];
    const currentUri = parseUri('/work/current');
    const controller = new ProjectOpenController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: currentUri, name: 'current' }],
        getPrependVscodeUrlToWslRemotes: () => true,
        getProjectPathType: async () => ProjectPathType.Folder,
        getFoldersFromWorkspaceFile: async () => [],
        showWarningMessage: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        executeCommand: async (command, ...args) => {
            commands.push([command, ...args]);
            return { protocolVersion: 1, opened: true };
        },
        updateWorkspaceFolders: () => true,
        updateReopenReason: () => undefined,
        fileUri: parseUri,
        parseUri,
    });

    await controller.openProject({ name: 'Current', path: '/work/current' }, ProjectOpenType.Default);
    await controller.openProject({ name: 'Target', path: '/work/target' }, ProjectOpenType.Default);
    await controller.openProject({ name: 'Reuse', path: '/work/reuse' }, ProjectOpenType.CurrentWindow);
    await controller.openProject({
        name: 'Windows local',
        path: 'C:\\Users\\local-user\\reddb',
    }, ProjectOpenType.Default);
    await controller.openProject({
        name: 'SSH',
        path: 'vscode-remote://ssh-remote+host',
        remoteType: ProjectRemoteType.SSH,
    }, ProjectOpenType.NewWindow);

    assert.deepEqual(commands, [
        ['_agentPivotProjects.bridge.navigate', {
            protocolVersion: 1,
            projectPath: '/work/target',
            remoteType: ProjectRemoteType.None,
            openInNewWindow: true,
        }],
        ['_agentPivotProjects.bridge.navigate', {
            protocolVersion: 1,
            projectPath: '/work/reuse',
            remoteType: ProjectRemoteType.None,
            openInNewWindow: false,
        }],
        ['_agentPivotProjects.bridge.navigate', {
            protocolVersion: 1,
            projectPath: 'C:\\Users\\local-user\\reddb',
            remoteType: ProjectRemoteType.None,
            openInNewWindow: true,
        }],
        ['_agentPivotProjects.bridge.navigate', {
            protocolVersion: 1,
            projectPath: 'vscode-remote://ssh-remote+host',
            remoteType: ProjectRemoteType.SSH,
            openInNewWindow: true,
        }],
    ]);
});

test('OPEN-PROJECT-OPEN-CONTROLLER-001 filters duplicate add-to-workspace folders and records a new workspace', async () => {
    const updates = [];
    const reopenReasons = [];
    const currentUri = parseUri('/work/current');
    const controller = new ProjectOpenController({
        getWorkspaceFile: () => null,
        getWorkspaceFolders: () => [{ uri: currentUri }],
        getPrependVscodeUrlToWslRemotes: () => false,
        getProjectPathType: async () => ProjectPathType.WorkspaceFile,
        getFoldersFromWorkspaceFile: async () => ['/work/current', '/work/new'],
        showWarningMessage: () => undefined,
        showInformationMessage: () => undefined,
        showErrorMessage: () => undefined,
        executeCommand: async () => undefined,
        updateWorkspaceFolders: (start, deleteCount, ...folders) => {
            updates.push([start, deleteCount, folders]);
            return true;
        },
        updateReopenReason: reason => reopenReasons.push(reason),
        fileUri: parseUri,
        parseUri,
    });

    await controller.openProject({ name: 'Workspace', path: '/work/app.code-workspace' }, ProjectOpenType.AddToWorkspace);
    assert.deepEqual(updates.map(([start, deleteCount, folders]) => [
        start,
        deleteCount,
        folders.map(folder => ({ ...folder, uri: folder.uri.fsPath })),
    ]), [[1, null, [{ uri: '/work/new' }]]]);
    assert.deepEqual(reopenReasons, [ReopenStewardReason.EditorReopenedAsWorkspace]);
});
