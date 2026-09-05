'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { createFakeVscode } = require('../../helpers/fakeVscode');

class FakeUri {
    constructor(scheme, authority, uriPath, fsPath, raw) {
        this.scheme = scheme;
        this.authority = authority || '';
        this.path = uriPath;
        this.fsPath = fsPath;
        this.raw = raw;
    }

    toString() {
        return this.raw;
    }

    with(change) {
        const path = change.path === undefined ? this.path : change.path;
        return new FakeUri(
            this.scheme,
            this.authority,
            path,
            path,
            `${this.scheme}://${this.authority}${path}`,
        );
    }

    static file(filePath) {
        const normalized = String(filePath).replace(/\\/g, '/');
        return new FakeUri('file', '', normalized, filePath, `file://${normalized}`);
    }

    static parse(value) {
        const text = String(value);
        const match = text.match(/^([^:]+):\/\/([^/]*)(\/[^?#]*)?/);
        if (match) {
            const scheme = match[1];
            const authority = match[2];
            const uriPath = match[3] || '/';
            return new FakeUri(scheme, authority, uriPath, scheme === 'file' ? uriPath : uriPath, text);
        }
        const scheme = text.includes(':') ? text.slice(0, text.indexOf(':')) : '';
        const uriPath = text.slice(text.indexOf(':') + 1) || '';
        return new FakeUri(scheme, '', uriPath, uriPath, text);
    }
}

function loadProjectModules() {
    const fakeVscode = createFakeVscode({});
    fakeVscode.Uri = FakeUri;
    const previousLoad = Module._load;
    try {
        Module._load = function (request, parent, isMain) {
            if (request === 'vscode') {
                return fakeVscode;
            }
            return previousLoad.call(this, request, parent, isMain);
        };
        return {
            matcher: require('../../../out/projects/openProjectMatcher'),
            service: require('../../../out/projects/openProjectService'),
            workspace: require('../../../out/projects/workspaceHelpers'),
        };
    } finally {
        Module._load = previousLoad;
    }
}

const { matcher, service, workspace } = loadProjectModules();
const { managedSshAlias } = require('../../../out/projects/managedRemote/sshConfigProjection');

test('PROJECT-WORKSPACE-HELPER-001 selects a workspace file before folders and returns every folder otherwise', () => {
    const workspaceFile = FakeUri.file('/work/app.code-workspace');
    const workspaceFolders = [
        { uri: FakeUri.file('/work/app') },
        { uri: FakeUri.file('/work/packages/api') },
    ];

    assert.equal(workspace.getWorkspacePath(workspaceFile, workspaceFolders), '/work/app.code-workspace');
    assert.equal(workspace.getWorkspaceUri(workspaceFile, workspaceFolders).fsPath, '/work/app.code-workspace');
    assert.deepEqual(
        workspace.getWorkspaceUris(null, workspaceFolders).map(uri => uri.fsPath),
        ['/work/app', '/work/packages/api']
    );
    assert.equal(workspace.getWorkspacePath(null, []), null);
});

test('PROJECT-WORKSPACE-HELPER-001 matches local folder and workspace-file paths after separator normalization', () => {
    for (const [projectPath, workspaceUri] of [
        ['/work/app/', FakeUri.file('/work/app')],
        ['C:\\work\\app\\', FakeUri.file('C:\\work\\app')],
        ['file:///work/app.code-workspace', FakeUri.file('/work/app.code-workspace')],
    ]) {
        assert.equal(matcher.projectPathMatchesWorkspaceUri(projectPath, workspaceUri), true, projectPath);
    }
    assert.equal(matcher.projectPathMatchesWorkspaceUri('/work/application', FakeUri.file('/work/app')), false);
});

test('PROJECT-WORKSPACE-HELPER-001 matches encoded SSH WSL and Dev Container workspace URIs', () => {
    for (const [projectPath, workspaceUri] of [
        [
            'vscode-remote://ssh-remote%2Buser@host/work/app/',
            FakeUri.parse('vscode-remote://ssh-remote+user@host/work/app'),
        ],
        [
            'vscode-remote://wsl%2BUbuntu/home/dev/app',
            FakeUri.parse('vscode-remote://wsl+Ubuntu/home/dev/app/'),
        ],
        [
            'vscode-remote://dev-container%2Bfixture/workspaces/app',
            FakeUri.parse('vscode-remote://dev-container+fixture/workspaces/app'),
        ],
    ]) {
        assert.equal(matcher.projectPathMatchesWorkspaceUri(projectPath, workspaceUri), true, projectPath);
    }
    assert.equal(
        matcher.projectPathMatchesWorkspaceUri(
            'vscode-remote://ssh-remote+other/work/app',
            FakeUri.parse('vscode-remote://ssh-remote+host/work/app')
        ),
        false
    );
});

test('PROJECT-WORKSPACE-HELPER-001 resolves one unambiguous legacy remote-path match', () => {
    const savedProjects = [
        { id: 'ssh', path: 'vscode-remote://ssh-remote+host/work/app', remoteType: 1 },
        { id: 'wsl', path: 'vscode-remote://wsl+Ubuntu/work/app', remoteType: 2 },
    ];
    assert.equal(
        matcher.findSavedProjectForOpenProject(savedProjects, FakeUri.file('/work/app'), 'ssh-remote').id,
        'ssh'
    );
    assert.equal(
        matcher.findSavedProjectForOpenProject(savedProjects.concat({
            id: 'ssh-duplicate',
            path: 'vscode-remote://ssh-remote+other/work/app',
            remoteType: 1,
        }), FakeUri.file('/work/app'), 'ssh-remote'),
        null
    );
});

test('MANAGED-REMOTE-NAVIGATION-001 recognizes opened Host and Dev Container Projects as saved', () => {
    const machine = {
        id: 'machine:reddev', name: 'RedDev Main',
        connection: { kind: 'ssh', host: '10.0.0.8', user: 'dev', port: 22022 },
    };
    const payload = Buffer.from(JSON.stringify({ hostPath: '/work/container' }), 'utf8')
        .toString('hex');
    const snapshot = {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        catalog: {
            machines: [machine],
            environments: [{
                id: 'environment:host', machineId: machine.id, kind: 'host', name: 'Host',
            }, {
                id: 'environment:container', machineId: machine.id,
                kind: 'devContainer', name: 'Container',
                devContainerAnchor: {
                    version: 1,
                    originalAuthority: `dev-container+${payload}@ssh-remote+legacy`,
                    sourceKind: 'workspace',
                    sourceLocator: '/work/container',
                },
            }],
            projects: [{
                id: 'project:host', environmentId: 'environment:host',
                name: 'API', remotePath: '/work/api',
            }, {
                id: 'project:container', environmentId: 'environment:container',
                name: 'Container API', remotePath: '/work/container',
            }],
            layout: {
                machineIds: [machine.id],
                environmentIdsByMachine: {}, projectIdsByEnvironment: {},
                favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };
    const alias = managedSshAlias(machine.id, machine.name);
    const host = matcher.findManagedProjectForOpenProject(
        snapshot,
        FakeUri.parse(`vscode-remote://ssh-remote%2B${alias}/work/api`),
    );
    const containerAuthority = encodeURIComponent(
        `dev-container+${payload}@ssh-remote+${alias}`,
    );
    const container = matcher.findManagedProjectForOpenProject(
        snapshot,
        FakeUri.parse(`vscode-remote://${containerAuthority}/work/container`),
    );

    assert.equal(host.project.id, 'project:host');
    assert.equal(container.project.id, 'project:container');
    assert.equal(matcher.findManagedProjectForOpenProject(
        snapshot,
        FakeUri.parse(`vscode-remote://ssh-remote%2B${alias}/work/other`),
    ), null);
});

test('MANAGED-REMOTE-NAVIGATION-001 identifies the current Dev Container Environment from its migrated authority', () => {
    const payload = Buffer.from(JSON.stringify({ hostPath: '/work/container' }), 'utf8')
        .toString('hex');
    const targetPayload = Buffer.from(JSON.stringify({ hostPath: '/work/other-container' }), 'utf8')
        .toString('hex');
    const originalAuthority = `dev-container+${payload}@ssh-remote+legacy-reddev`;
    const snapshot = {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        catalog: {
            machines: [{
                id: 'machine:reddev', name: 'RedDev',
                connection: { kind: 'ssh', host: '10.0.0.8', user: 'dev', port: 22022 },
            }],
            environments: [{
                id: 'environment:host', machineId: 'machine:reddev',
                kind: 'host', name: 'Host',
            }, {
                id: 'environment:container', machineId: 'machine:reddev',
                kind: 'devContainer', name: 'Container',
                devContainerAnchor: {
                    version: 1,
                    originalAuthority,
                    sourceKind: 'workspace',
                    sourceLocator: '/work/container',
                },
            }, {
                id: 'environment:other-container', machineId: 'machine:reddev',
                kind: 'devContainer', name: 'Other Container',
                devContainerAnchor: {
                    version: 1,
                    originalAuthority: `dev-container+${targetPayload}@ssh-remote+other-alias`,
                    sourceKind: 'workspace',
                    sourceLocator: '/work/other-container',
                },
            }],
            projects: [{
                id: 'project:host', environmentId: 'environment:host',
                name: 'Host Project', remotePath: '/work/host-project',
            }, {
                id: 'project:current', environmentId: 'environment:container',
                name: 'Current', remotePath: '/work/current',
            }, {
                id: 'project:target', environmentId: 'environment:container',
                name: 'Target', remotePath: '/work/target',
            }, {
                id: 'project:other-container', environmentId: 'environment:other-container',
                name: 'Other Container Project', remotePath: '/work/other-target',
            }],
            layout: {
                machineIds: ['machine:reddev'], environmentIdsByMachine: {},
                projectIdsByEnvironment: {}, favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };
    const currentUri = FakeUri.parse(
        `vscode-remote://${encodeURIComponent(originalAuthority)}/work/current`,
    );

    assert.equal(
        matcher.findManagedEnvironmentForWorkspace(snapshot, currentUri).id,
        'environment:container',
    );
    assert.equal(
        matcher.findManagedProjectForOpenProject(snapshot, currentUri).project.id,
        'project:current',
    );
    assert.equal(
        matcher.managedProjectUriFromCurrentMachine(
            snapshot,
            'project:target',
            [currentUri],
        ).toString(),
        `vscode-remote://${encodeURIComponent(originalAuthority)}/work/target`,
    );
    assert.equal(
        matcher.managedProjectUriFromCurrentMachine(
            snapshot,
            'project:host',
            [currentUri],
        ).toString(),
        'vscode-remote://ssh-remote%2Blegacy-reddev/work/host-project',
    );
    assert.equal(
        matcher.managedProjectUriFromCurrentMachine(
            snapshot,
            'project:other-container',
            [currentUri],
        ).toString(),
        `vscode-remote://${encodeURIComponent(`dev-container+${targetPayload}@ssh-remote+legacy-reddev`)}/work/other-target`,
    );
});

test('MANAGED-REMOTE-NAVIGATION-001 identifies a remote Extension Host file URI from its Dev Container workspace anchor', () => {
    const snapshot = {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        catalog: {
            machines: [{
                id: 'machine:reddev', name: 'RedDev',
                connection: { kind: 'ssh', host: '10.0.0.8', user: 'dev', port: 22022 },
            }],
            environments: [{
                id: 'environment:container', machineId: 'machine:reddev',
                kind: 'devContainer', name: 'Container',
                devContainerAnchor: {
                    version: 1,
                    originalAuthority: 'dev-container+fixture@ssh-remote+legacy-reddev',
                    sourceKind: 'workspace',
                    sourceLocator: '/home/dev/DevBox/workspace',
                },
            }],
            projects: [{
                id: 'project:target', environmentId: 'environment:container',
                name: 'Target', remotePath: '/workspaces/target',
            }],
            layout: {
                machineIds: ['machine:reddev'], environmentIdsByMachine: {},
                projectIdsByEnvironment: {}, favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };
    const currentUri = FakeUri.file('/workspaces/current');

    assert.equal(
        matcher.managedProjectUriFromCurrentMachine(
            snapshot,
            'project:target',
            [currentUri],
            {
                remoteName: 'dev-container',
                devContainerHostWorkspaceFolder: '/home/dev/DevBox/workspace',
            },
        ).toString(),
        'file:///workspaces/target',
    );
    assert.equal(
        matcher.findManagedProjectForOpenProject(
            snapshot,
            FakeUri.file('/workspaces/target'),
            {
                remoteName: 'dev-container',
                devContainerHostWorkspaceFolder: '/home/dev/DevBox/workspace',
            },
        ).project.id,
        'project:target',
    );
});

test('MANAGED-REMOTE-NAVIGATION-001 does not guess an Environment from an ambiguous remote path', () => {
    const snapshot = {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        catalog: {
            machines: [], environments: [{
                id: 'environment:one', machineId: 'machine:one', kind: 'host', name: 'Host',
            }, {
                id: 'environment:two', machineId: 'machine:two', kind: 'host', name: 'Host',
            }],
            projects: [{
                id: 'project:one', environmentId: 'environment:one',
                name: 'One', remotePath: '/work/shared',
            }, {
                id: 'project:two', environmentId: 'environment:two',
                name: 'Two', remotePath: '/work/shared',
            }],
            layout: {
                machineIds: [], environmentIdsByMachine: {},
                projectIdsByEnvironment: {}, favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };

    assert.equal(matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse('vscode-remote://dev-container+unknown/work/shared'),
    ), null);
});

test('PROJECT-WORKSPACE-HELPER-001 delegates workspace navigation to the current workspace URI', () => {
    const folders = [{ uri: FakeUri.file('/work/app'), name: 'app' }];
    const workspaceFile = FakeUri.file('/work/app.code-workspace');
    assert.equal(service.getWorkspaceUri(workspaceFile, folders), workspaceFile);
    assert.deepEqual(service.getWorkspaceUris(null, folders), [folders[0].uri]);
});

function twoMachinesOnOneHost() {
    // A dev box registered twice: the host itself and its Dev Container. Both
    // share a connection host, so a name-derived alias cannot tell them apart.
    const host = 'reddev.example.com';
    const first = {
        id: 'machine:one', name: '小红书开发机',
        connection: { kind: 'ssh', host, user: 'dev', port: 22022 },
    };
    const second = {
        id: 'machine:two', name: '小红书开发机备用',
        connection: { kind: 'ssh', host, user: 'dev', port: 22022 },
    };
    return {
        first,
        second,
        snapshot: {
            revisionId: `revision:${'a'.repeat(64)}`,
            lifecycle: 'active',
            catalog: {
                machines: [first, second],
                environments: [
                    { id: 'environment:one', machineId: first.id, kind: 'host', name: 'Host' },
                    { id: 'environment:two', machineId: second.id, kind: 'host', name: 'Host' },
                ],
                projects: [{
                    id: 'project:one', environmentId: 'environment:one',
                    name: 'API', remotePath: '/work/api',
                }],
                layout: {
                    machineIds: [], environmentIdsByMachine: {},
                    projectIdsByEnvironment: {}, favoriteProjectIds: [],
                },
                conflicts: [],
            },
            machineConflictCandidates: {},
        },
    };
}

test('MANAGED-REMOTE-NAVIGATION-001 recognizes a Machine sharing a connection host with a sibling', () => {
    const { first, snapshot } = twoMachinesOnOneHost();
    // The identity suffix distinguishes the two Machines, so the opened window
    // must resolve to exactly the Machine whose alias it carries.
    const alias = managedSshAlias(first.id, first.name, first.connection.host);
    const environment = matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse(`vscode-remote://${encodeURIComponent(`ssh-remote+${alias}`)}/work/api`),
    );

    assert.ok(environment, 'the opened Project must be recognised as saved');
    assert.equal(environment.id, 'environment:one');
});

test('MANAGED-REMOTE-NAVIGATION-001 stays ambiguous for a legacy alias two Machines both claim', () => {
    const { snapshot } = twoMachinesOnOneHost();
    // A pre-suffix alias derived from the shared connection host carries no
    // Machine identity, so attributing it to either Machine would be a guess.
    const environment = matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse('vscode-remote://ssh-remote%2Breddev.example.com/work/api'),
    );

    assert.equal(environment, null);
});

test('MANAGED-REMOTE-NAVIGATION-001 resolves a legacy alias exactly one Machine claims', () => {
    const { first, snapshot } = twoMachinesOnOneHost();
    // Give the sibling a distinct connection host so only one Machine can claim
    // the legacy name-only alias; it must then still resolve.
    snapshot.catalog.machines[1] = {
        ...snapshot.catalog.machines[1],
        connection: { ...snapshot.catalog.machines[1].connection, host: 'other.example.com' },
    };
    const legacy = require('../../../out/projects/managedRemote/sshConfigProjection')
        .managedSshAliasName(first.name, first.connection.host);
    const environment = matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse(`vscode-remote://${encodeURIComponent(`ssh-remote+${legacy}`)}/work/api`),
    );

    assert.ok(environment, 'a uniquely claimed legacy alias must still resolve');
    assert.equal(environment.id, 'environment:one');
});

test('MANAGED-REMOTE-NAVIGATION-001 recognizes a Machine after it is renamed', () => {
    const { first, snapshot } = twoMachinesOnOneHost();
    // The alias already written to the SSH config keeps the old readable
    // segment; recognition is anchored on the identity suffix, so renaming the
    // Machine must not orphan its open window.
    const projected = managedSshAlias(first.id, first.name, first.connection.host);
    snapshot.catalog.machines[0] = { ...first, name: 'Renamed Box' };
    const environment = matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse(`vscode-remote://${encodeURIComponent(`ssh-remote+${projected}`)}/work/api`),
    );

    assert.ok(environment, 'a renamed Machine must still claim its projected alias');
    assert.equal(environment.id, 'environment:one');
});

test('MANAGED-REMOTE-NAVIGATION-001 recognizes a Machine adopted from a hand-written SSH host alias', () => {
    // A Machine migrated from ~/.ssh/config keeps the Host alias the user chose,
    // which is neither the projected form nor derivable from the Machine name.
    const machine = {
        id: 'machine:one', name: '小红书开发机',
        connection: {
            kind: 'ssh', host: 'reddev.xiaohongshu.com', user: 'hzcheng', port: 22022,
        },
    };
    const snapshot = {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        catalog: {
            machines: [machine],
            environments: [{
                id: 'environment:host', machineId: machine.id, kind: 'host', name: 'Host',
            }],
            projects: [{
                id: 'project:one', environmentId: 'environment:host',
                name: 'ai-tour',
                remotePath: '/home/hzcheng/projects/repos/workspaces/ai-tour.code-workspace',
            }],
            layout: {
                machineIds: [], environmentIdsByMachine: {},
                projectIdsByEnvironment: {}, favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };

    const environment = matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse('vscode-remote://ssh-remote%2Breddev/home/hzcheng/projects/repos/workspaces/ai-tour.code-workspace'),
    );
    assert.ok(environment, 'the original Host alias must still resolve');
    assert.equal(environment.id, 'environment:host');

    // A multi-root .code-workspace file is addressed by its file path, so the
    // saved Project must be recognised from that path and not only from folders.
    const match = matcher.findManagedProjectForOpenProject(
        snapshot,
        FakeUri.parse('vscode-remote://ssh-remote%2Breddev/home/hzcheng/projects/repos/workspaces/ai-tour.code-workspace'),
    );
    assert.ok(match, 'the saved multi-root workspace must be recognised as saved');
    assert.equal(match.project.id, 'project:one');
});

test('MANAGED-REMOTE-NAVIGATION-001 does not attribute a hand-written alias to an unrelated Machine', () => {
    const snapshot = {
        revisionId: `revision:${'a'.repeat(64)}`,
        lifecycle: 'active',
        catalog: {
            machines: [{
                id: 'machine:other', name: 'Other Box',
                connection: { kind: 'ssh', host: 'other.example.com', user: 'dev', port: 22 },
            }],
            environments: [{
                id: 'environment:other', machineId: 'machine:other', kind: 'host', name: 'Host',
            }],
            projects: [],
            layout: {
                machineIds: [], environmentIdsByMachine: {},
                projectIdsByEnvironment: {}, favoriteProjectIds: [],
            },
            conflicts: [],
        },
        machineConflictCandidates: {},
    };

    assert.equal(matcher.findManagedEnvironmentForWorkspace(
        snapshot,
        FakeUri.parse('vscode-remote://ssh-remote%2Breddev/work/api'),
    ), null);
});
