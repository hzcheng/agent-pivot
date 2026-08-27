'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const commandBuilders = require('../../../out/aiSessions/commandBuilders');
const {
    AiSessionCommandController,
    preflightAiSessionDirectoryScope,
} = require('../../../out/aiSessions/commandController');
const {
    WorkspaceDirectoryScopeError,
    buildAiSessionDirectoryScope,
    selectPrimaryWorkspaceRoot,
} = require('../../../out/workspaces/sessionScope');

function workspace(overrides = {}) {
    return {
        navigationIdentity: '1'.repeat(64),
        scopeIdentity: '2'.repeat(64),
        kind: 'savedMultiRoot',
        displayName: 'Platform',
        navigationUri: 'file:///work/platform.code-workspace',
        environment: 'local',
        roots: [
            { id: 'root-parent', name: 'Parent', uri: 'file:///work', hostPath: '/work', ordinal: 0 },
            { id: 'root-api', name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1 },
            { id: 'root-web', name: 'Web', uri: 'file:///work/web', hostPath: '/work/web', ordinal: 2 },
        ],
        ...overrides,
    };
}

test('SESSION-WORKSPACE-SCOPE-001 preserves explicit, editor, stored, and ordinal root precedence', () => {
    const current = workspace();
    assert.equal(selectPrimaryWorkspaceRoot(current, {
        explicitRootId: 'root-web',
        activeEditorUri: '/work/api/src/index.ts',
        lastUsedRootId: 'root-api',
    }).id, 'root-web');
    assert.equal(selectPrimaryWorkspaceRoot(current, {
        activeEditorUri: '/work/api/src/index.ts',
        lastUsedRootId: 'root-web',
    }).id, 'root-api');
    assert.equal(selectPrimaryWorkspaceRoot(current, {
        activeEditorUri: '/outside/index.ts',
        lastUsedRootId: 'root-web',
    }).id, 'root-web');
    assert.equal(selectPrimaryWorkspaceRoot(workspace({
        roots: [current.roots[2], current.roots[1], current.roots[0]],
    }), {
        explicitRootId: 'removed-root',
        lastUsedRootId: 'removed-root',
    }).id, 'root-parent');
});

test('SESSION-WORKSPACE-SCOPE-001 preserves whitespace and rejects blank or unavailable roots', () => {
    const spaced = workspace({
        roots: [
            {
                id: 'root-trailing',
                name: 'Trailing',
                uri: 'file:///work/repo%20',
                hostPath: '/work/repo ',
                ordinal: 0,
            },
            {
                id: 'root-leading',
                name: 'Leading',
                uri: 'file:///work/%20api',
                hostPath: '/work/ api',
                ordinal: 1,
            },
        ],
    });
    const probes = [];
    const scope = buildAiSessionDirectoryScope(spaced, {
        explicitRootId: 'root-trailing',
        isDirectory: hostPath => {
            probes.push(hostPath);
            return true;
        },
    });
    assert.deepEqual(probes, ['/work/repo ', '/work/ api']);
    assert.equal(scope.primaryCwd, '/work/repo ');
    assert.deepEqual(scope.additionalDirectories, ['/work/ api']);

    let blankProbes = 0;
    assert.throws(
        () => buildAiSessionDirectoryScope(workspace({
            roots: [{
                id: 'root-blank',
                name: 'Blank',
                uri: 'file:///blank',
                hostPath: ' \t ',
                ordinal: 0,
            }],
        }), {
            isDirectory: () => {
                blankProbes += 1;
                return true;
            },
        }),
        error => error instanceof WorkspaceDirectoryScopeError
    );
    assert.equal(blankProbes, 0);

    assert.throws(
        () => buildAiSessionDirectoryScope(workspace(), {
            isDirectory: hostPath => hostPath !== '/work/web',
        }),
        error => {
            assert.ok(error instanceof WorkspaceDirectoryScopeError);
            assert.deepEqual(error.invalidRoots, [{ id: 'root-web', name: 'Web' }]);
            return true;
        }
    );
});

test('SESSION-WORKSPACE-SCOPE-001 builds provider-specific add-directory arguments', async () => {
    const current = workspace();
    const ready = await preflightAiSessionDirectoryScope({
        workspace: current,
        provider: { id: 'codex', label: 'Codex', commandName: 'codex' },
        action: 'create',
        isWorkspaceTrusted: true,
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isDirectory: () => true,
        pickWorkspaceRoot: async () => undefined,
        explicitRootId: 'root-api',
    });
    assert.equal(ready.status, 'ready');
    const scope = ready.directoryScope;
    assert.equal(scope.primaryCwd, '/work/api');
    assert.deepEqual(scope.additionalDirectories, ['/work', '/work/web']);

    assert.deepEqual(commandBuilders.buildCodexNewSessionLaunchSpec(scope).args, [
        '--cd', '/work/api', '--add-dir', '/work', '--add-dir', '/work/web',
    ]);
    assert.deepEqual(commandBuilders.buildKimiNewSessionLaunchSpec(scope), {
        executable: 'kimi',
        args: ['--add-dir', '/work', '--add-dir', '/work/web'],
        cwd: '/work/api',
        markerPath: null,
        windowsDirectShell: 'powershell',
    });
    assert.deepEqual(commandBuilders.buildClaudeNewSessionLaunchSpec(scope), {
        executable: 'claude',
        args: ['--add-dir', '/work', '/work/web'],
        cwd: '/work/api',
        markerPath: null,
        windowsDirectShell: 'powershell',
    });
});

test('SESSION-WORKTREE-SCOPE-001 replaces the selected repository roots with linked-worktree paths', () => {
    const current = workspace({
        roots: [
            {
                id: 'root-frontend', name: 'Frontend', uri: 'file:///repos/frontend',
                hostPath: '/repos/frontend', ordinal: 0,
            },
            {
                id: 'root-frontend-web', name: 'Frontend Web',
                uri: 'file:///repos/frontend/packages/web',
                hostPath: '/repos/frontend/packages/web', ordinal: 1,
            },
            {
                id: 'root-backend', name: 'Backend', uri: 'file:///repos/backend',
                hostPath: '/repos/backend', ordinal: 2,
            },
        ],
    });
    const worktreeKey = {
        repositoryKey: '/repos/frontend/.git',
        canonicalWorktreePath: '/managed/frontend-feature',
    };

    const scope = buildAiSessionDirectoryScope(current, {
        explicitRootId: 'root-frontend-web',
        isDirectory: () => true,
        worktree: {
            key: worktreeKey,
            rootBindings: [
                { workspaceRootId: 'root-frontend', repositoryRelativePath: '' },
                { workspaceRootId: 'root-frontend-web', repositoryRelativePath: 'packages/web' },
            ],
        },
    });

    assert.equal(scope.primaryCwd, '/managed/frontend-feature/packages/web');
    assert.deepEqual(scope.workspaceRootHostPaths, [
        '/repos/frontend', '/repos/frontend/packages/web', '/repos/backend',
    ]);
    assert.deepEqual(scope.writableRootHostPaths, [
        '/managed/frontend-feature',
        '/managed/frontend-feature/packages/web',
    ], 'strict isolation: non-member repository main checkouts are never writable');
    assert.deepEqual(scope.additionalDirectories, [
        '/managed/frontend-feature',
    ]);
    assert.deepEqual(scope.worktreeKey, worktreeKey);
    assert.equal(scope.isolatedRoots, true);
    assert.equal(scope.additionalDirectories.includes('/repos/frontend'), false);
    assert.equal(scope.additionalDirectories.includes('/repos/backend'), false);
});

test('SESSION-WORKTREE-ASSIGNMENT-001 resumes a sibling-worktree session in its exact historical directory', async () => {
    const current = workspace({
        roots: [
            {
                id: 'root-frontend', name: 'Frontend', uri: 'file:///repos/frontend',
                hostPath: '/repos/frontend', ordinal: 0,
            },
            {
                id: 'root-frontend-web', name: 'Frontend Web',
                uri: 'file:///repos/frontend/packages/web',
                hostPath: '/repos/frontend/packages/web', ordinal: 1,
            },
        ],
    });
    const siblingKey = {
        repositoryKey: '/repos/frontend/.git',
        canonicalWorktreePath: '/managed/frontend-feature',
    };
    let snapshot = {
        revision: 7,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: siblingKey.repositoryKey,
            rootBindings: [
                { workspaceRootId: 'stale-root', repositoryRelativePath: 'retired' },
                { workspaceRootId: 'root-frontend', repositoryRelativePath: '' },
                { workspaceRootId: 'root-frontend-web', repositoryRelativePath: 'packages/web' },
            ],
            worktrees: [{
                key: siblingKey,
                head: 'a'.repeat(40),
                isMain: false,
                isBare: false,
                health: 'normal',
                headKind: 'branch',
            }],
        }],
    };
    let rootPicks = 0;
    const controller = new AiSessionCommandController({
        getWorktreeSnapshot: () => snapshot,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isWorkspaceTrusted: () => true,
        isDirectory: () => true,
        pickWorkspaceRoot: async () => {
            rootPicks += 1;
            return 'root-frontend';
        },
    });

    const scope = await controller.resolveWorkspaceDirectoryScope(current, 'codex', {
        id: 'session-1',
        name: 'Feature work',
        provider: 'codex',
        cwd: '/managed/frontend-feature/packages/web/src/components',
        worktreeKey: siblingKey,
    });

    assert.equal(rootPicks, 0, 'an assigned sibling worktree must not prompt for a current-root fallback');
    assert.equal(scope.primaryRootId, 'root-frontend-web');
    assert.equal(scope.primaryCwd, '/managed/frontend-feature/packages/web/src/components');
    assert.deepEqual(scope.worktreeKey, siblingKey);
    assert.deepEqual(scope.writableRootHostPaths, [
        '/managed/frontend-feature',
        '/managed/frontend-feature/packages/web',
    ]);
    assert.deepEqual(scope.additionalDirectories, [
        '/managed/frontend-feature',
    ]);

    snapshot = { revision: 8, truncatedWorktreeCount: 0, repositories: [] };
    const fallbackScope = await controller.resolveWorkspaceDirectoryScope(current, 'codex', {
        id: 'session-1',
        name: 'Feature work',
        provider: 'codex',
        cwd: '/managed/frontend-feature/packages/web/src/components',
        worktreeKey: siblingKey,
    });
    assert.equal(fallbackScope, null,
        'a session whose worktree is gone fails closed instead of resuming in the main checkout');
    assert.equal(rootPicks, 0,
        'a stale worktree key never falls back to the root picker or the main checkout');
});

test('WORKTREE-SESSION-CREATE-TARGET-001 creation binds a selected worktree and rejects a stale key', async () => {
    const current = workspace({
        roots: [
            { id: 'root-repo', name: 'Repo', uri: 'file:///repos/main/app', hostPath: '/repos/main/app', ordinal: 0 },
            { id: 'root-other', name: 'Other', uri: 'file:///other', hostPath: '/other', ordinal: 1 },
        ],
    });
    const key = {
        repositoryKey: '/repos/main/.git',
        canonicalWorktreePath: '/managed/feature',
    };
    let snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: key.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: 'app' }],
            worktrees: [{
                key, branchRef: 'refs/heads/feature', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const warnings = [];
    const controller = new AiSessionCommandController({
        getWorktreeSnapshot: () => snapshot,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isWorkspaceTrusted: () => true,
        isDirectory: () => true,
        pickWorkspaceRoot: async () => { throw new Error('selected worktree must determine the root'); },
        showWarningMessage: message => warnings.push(message),
    });

    const scope = await controller.resolveWorkspaceDirectoryScope(
        current, 'codex', undefined, undefined, key
    );
    assert.equal(scope.primaryRootId, 'root-repo');
    assert.equal(scope.primaryCwd, '/managed/feature/app');
    assert.deepEqual(scope.worktreeKey, key);
    assert.deepEqual(scope.writableRootHostPaths, ['/managed/feature/app'],
        'strict isolation: the unbound second repository root is not writable');
    assert.deepEqual(scope.additionalDirectories, []);
    assert.equal(scope.isolatedRoots, true);

    snapshot = { revision: 2, truncatedWorktreeCount: 0, repositories: [] };
    assert.equal(await controller.resolveWorkspaceDirectoryScope(
        current, 'codex', undefined, undefined, key
    ), null);
    assert.match(warnings.at(-1), /no longer available/i);
});

test('SESSION-WORKTREE-SCOPE-001 group sessions mount every ready member worktree', async () => {
    const current = workspace({
        roots: [
            { id: 'root-repo', name: 'Repo', uri: 'file:///repos/main/app', hostPath: '/repos/main/app', ordinal: 0 },
            { id: 'root-peer', name: 'Peer', uri: 'file:///repos/peer', hostPath: '/repos/peer', ordinal: 1 },
            { id: 'root-outsider', name: 'Outsider', uri: 'file:///repos/outsider', hostPath: '/repos/outsider', ordinal: 2 },
        ],
    });
    const key = {
        repositoryKey: '/repos/main/.git',
        canonicalWorktreePath: '/managed/feature',
    };
    const peerKey = {
        repositoryKey: '/repos/peer/.git',
        canonicalWorktreePath: '/managed/peer-feature',
    };
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: key.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: 'app' }],
            worktrees: [{
                key, branchRef: 'refs/heads/feature', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            }],
        }, {
            repositoryKey: peerKey.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-peer', repositoryRelativePath: '' }],
            worktrees: [{
                key: peerKey, branchRef: 'refs/heads/peer-feature', head: 'b'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const controller = new AiSessionCommandController({
        getWorktreeSnapshot: () => snapshot,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isWorkspaceTrusted: () => true,
        isDirectory: () => true,
        pickWorkspaceRoot: async () => { throw new Error('selected worktree must determine the root'); },
        showWarningMessage: () => undefined,
        getWorktreeGroupPeerKeys: (navigationIdentity, requestedKey) => {
            assert.equal(navigationIdentity, current.navigationIdentity);
            assert.deepEqual(requestedKey, key);
            return [peerKey];
        },
    });

    const scope = await controller.resolveWorkspaceDirectoryScope(
        current, 'codex', undefined, undefined, key
    );
    assert.equal(scope.primaryCwd, '/managed/feature/app');
    assert.deepEqual(scope.writableRootHostPaths,
        ['/managed/feature/app', '/managed/peer-feature'],
        'a group session writes its own worktree and every ready member worktree');
    assert.deepEqual(scope.additionalDirectories, ['/managed/peer-feature']);
    assert.equal(scope.isolatedRoots, true);
    assert.equal(scope.writableRootHostPaths.includes('/repos/peer'), false,
        'the peer main checkout is never writable');
    assert.equal(scope.writableRootHostPaths.includes('/repos/outsider'), false,
        'non-member repository main checkouts are never writable');
});

test('SESSION-WORKTREE-SCOPE-001 group peers missing from the snapshot or disk fail closed', async () => {
    const current = workspace({
        roots: [
            { id: 'root-repo', name: 'Repo', uri: 'file:///repos/main/app', hostPath: '/repos/main/app', ordinal: 0 },
        ],
    });
    const key = {
        repositoryKey: '/repos/main/.git',
        canonicalWorktreePath: '/managed/feature',
    };
    const missingPeerKey = {
        repositoryKey: '/repos/peer/.git',
        canonicalWorktreePath: '/managed/peer-gone',
    };
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: key.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: 'app' }],
            worktrees: [{
                key, branchRef: 'refs/heads/feature', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const warnings = [];
    const controller = new AiSessionCommandController({
        getWorktreeSnapshot: () => snapshot,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isWorkspaceTrusted: () => true,
        isDirectory: () => true,
        pickWorkspaceRoot: async () => { throw new Error('must not pick'); },
        showWarningMessage: message => warnings.push(message),
        getWorktreeGroupPeerKeys: () => [missingPeerKey],
    });

    const scope = await controller.resolveWorkspaceDirectoryScope(
        current, 'codex', undefined, undefined, key
    );
    assert.equal(scope, null,
        'a stale ready member in the manifest must block the launch, not widen the scope');
    assert.match(warnings.at(-1), /member worktree.*no longer available/i);
});

test('SESSION-WORKTREE-SCOPE-001 a locked group peer stays writable like the projection promises', async () => {
    // Git only blocks prune/repair for a locked worktree; the projection
    // renders it ready, so session creation must not reject it either.
    const current = workspace({
        roots: [
            { id: 'root-repo', name: 'Repo', uri: 'file:///repos/main/app', hostPath: '/repos/main/app', ordinal: 0 },
            { id: 'root-peer', name: 'Peer', uri: 'file:///repos/peer', hostPath: '/repos/peer', ordinal: 1 },
        ],
    });
    const key = {
        repositoryKey: '/repos/main/.git',
        canonicalWorktreePath: '/managed/feature',
    };
    const lockedPeerKey = {
        repositoryKey: '/repos/peer/.git',
        canonicalWorktreePath: '/managed/peer-feature',
    };
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: key.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: 'app' }],
            worktrees: [{
                key, branchRef: 'refs/heads/feature', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            }],
        }, {
            repositoryKey: lockedPeerKey.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-peer', repositoryRelativePath: '' }],
            worktrees: [{
                key: lockedPeerKey, branchRef: 'refs/heads/peer-feature', head: 'b'.repeat(40),
                isMain: false, isBare: false, health: 'locked', headKind: 'branch',
            }],
        }],
    };
    const controller = new AiSessionCommandController({
        getWorktreeSnapshot: () => snapshot,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isWorkspaceTrusted: () => true,
        isDirectory: () => true,
        pickWorkspaceRoot: async () => { throw new Error('selected worktree must determine the root'); },
        showWarningMessage: () => undefined,
        getWorktreeGroupPeerKeys: () => [lockedPeerKey],
    });

    const scope = await controller.resolveWorkspaceDirectoryScope(
        current, 'codex', undefined, undefined, key
    );
    assert.ok(scope, 'a locked member worktree is still a valid session scope');
    assert.deepEqual(scope.writableRootHostPaths,
        ['/managed/feature/app', '/managed/peer-feature']);
});

test('SESSION-WORKTREE-SCOPE-001 session creation fails closed while a group member is provisioning', async () => {
    const current = workspace({
        roots: [
            { id: 'root-repo', name: 'Repo', uri: 'file:///repos/main/app', hostPath: '/repos/main/app', ordinal: 0 },
        ],
    });
    const key = {
        repositoryKey: '/repos/main/.git',
        canonicalWorktreePath: '/managed/feature',
    };
    const snapshot = {
        revision: 1,
        truncatedWorktreeCount: 0,
        repositories: [{
            repositoryKey: key.repositoryKey,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: 'app' }],
            worktrees: [{
                key, branchRef: 'refs/heads/feature', head: 'a'.repeat(40),
                isMain: false, isBare: false, health: 'normal', headKind: 'branch',
            }],
        }],
    };
    const warnings = [];
    const controller = new AiSessionCommandController({
        getWorktreeSnapshot: () => snapshot,
        getProvider: () => ({ id: 'codex', label: 'Codex', commandName: 'codex' }),
        getProviderDirectoryCapability: async () => ({ status: 'supported' }),
        isWorkspaceTrusted: () => true,
        isDirectory: () => true,
        pickWorkspaceRoot: async () => { throw new Error('must not pick'); },
        showWarningMessage: message => warnings.push(message),
        getWorktreeGroupPeerKeys: () => [],
        isWorktreeGroupProvisioning: () => true,
    });

    const scope = await controller.resolveWorkspaceDirectoryScope(
        current, 'codex', undefined, undefined, key
    );
    assert.equal(scope, null,
        'creation while a member provisions would silently narrow the scope');
    assert.match(warnings.at(-1), /still being created/i);
});

test('SESSION-WORKTREE-SCOPE-001 rejects malformed group peer paths instead of widening scope', () => {
    const current = workspace({
        roots: [
            { id: 'root-repo', name: 'Repo', uri: 'file:///repos/main/app', hostPath: '/repos/main/app', ordinal: 0 },
        ],
    });
    assert.throws(() => buildAiSessionDirectoryScope(current, {
        explicitRootId: 'root-repo',
        isDirectory: () => true,
        worktree: {
            key: {
                repositoryKey: '/repos/main/.git',
                canonicalWorktreePath: '/managed/feature',
            },
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: 'app' }],
            extraWritableHostPaths: ['relative/peer'],
        },
    }), WorkspaceDirectoryScopeError);
});

test('SESSION-WORKTREE-SCOPE-001 rejects escaping bindings and unavailable mapped roots', () => {
    const current = workspace({
        roots: [{
            id: 'root-repo', name: 'Repo', uri: 'file:///repos/main',
            hostPath: '/repos/main', ordinal: 0,
        }],
    });
    const key = {
        repositoryKey: '/repos/main/.git',
        canonicalWorktreePath: '/managed/feature',
    };
    assert.throws(() => buildAiSessionDirectoryScope(current, {
        isDirectory: () => true,
        worktree: {
            key,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: '../main' }],
        },
    }), error => error instanceof WorkspaceDirectoryScopeError);

    assert.throws(() => buildAiSessionDirectoryScope(current, {
        isDirectory: hostPath => hostPath !== '/managed/feature',
        worktree: {
            key,
            rootBindings: [{ workspaceRootId: 'root-repo', repositoryRelativePath: '' }],
        },
    }), error => {
        assert.ok(error instanceof WorkspaceDirectoryScopeError);
        assert.deepEqual(error.invalidRoots, [{ id: 'root-repo', name: 'Repo' }]);
        return true;
    });
});

test('SESSION-WORKSPACE-SCOPE-001 blocks unsupported multi-root providers before directory or terminal preparation', async () => {
    let directoryProbes = 0;
    let rootPicks = 0;
    const result = await preflightAiSessionDirectoryScope({
        workspace: workspace(),
        provider: { id: 'codex', label: 'Codex', commandName: 'codex' },
        action: 'create',
        isWorkspaceTrusted: true,
        getProviderDirectoryCapability: async () => ({ status: 'unsupported' }),
        isDirectory: () => {
            directoryProbes += 1;
            return true;
        },
        pickWorkspaceRoot: async () => {
            rootPicks += 1;
            return 'root-api';
        },
    });
    assert.deepEqual(result, {
        status: 'blocked',
        reason: 'capability-unsupported',
        message: 'Codex cannot launch in this multi-root workspace. Upgrade it to a version with --add-dir support.',
    });
    assert.equal(directoryProbes, 0);
    assert.equal(rootPicks, 0);
});
