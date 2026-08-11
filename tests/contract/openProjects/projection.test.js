'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    getAttentionProjectKeys,
} = require('../../../out/aiSessions/attentionProject');
const {
    createOpenWorkspacePublication,
    projectOpenWorkspaceCards,
    projectOpenWorkspaceNavigationCards,
    sumOpenWorkspaceRunningAiSessionCounts,
} = require('../../../out/openWorkspaces/projection');
const {
    createWorkspaceUriIdentity,
    normalizeWorkspaceUri,
} = require('../../../out/workspaces/identity');
const {
    replaceOpenWorkspacePublicationUris,
} = require('../../../extensions/attention-ui-bridge/out/extensions/attention-ui-bridge/src/openWorkspacePublication');
const {
    NEWER,
    OLDER,
    OTHER,
    SELF,
    makeAggregate,
    makePublication,
    makeRecord,
    makeRegistration,
} = require('./helpers');

function authoritativeUri(value, scheme, authority, uriPath) {
    return { value, scheme, authority, path: uriPath };
}

test('CONVERSATION-SESSION-STATUS-001 sums running Session counts across the open workspace aggregate', () => {
    assert.equal(sumOpenWorkspaceRunningAiSessionCounts(null), 0);
    assert.equal(sumOpenWorkspaceRunningAiSessionCounts({
        registrations: [],
    }), 0);
    assert.equal(sumOpenWorkspaceRunningAiSessionCounts({
        registrations: [
            { workspace: { runningAiSessionCount: 2 } },
            { workspace: null },
            { workspace: { runningAiSessionCount: 3 } },
            { workspace: {} },
        ],
    }), 5);
});

test('OPEN-OPEN-PROJECT-PUBLICATION-001 replaces workspace URIs by ordinal without mutating publications', () => {
    const publication = makePublication({
        workspace: makeRecord({
            uri: 'vscode-remote://dev-container%2Bcurrent/workspaces/app',
            remoteType: 'devContainer',
        }),
    });
    const exactWindowUri = 'vscode-remote://dev-container%2Btarget%40ssh-remote%2Bhost/workspaces/app';
    const exactWindowIdentity = authoritativeUri(
        exactWindowUri,
        'vscode-remote',
        'dev-container+target@ssh-remote+host',
        '/workspaces/app'
    );

    const replaced = replaceOpenWorkspacePublicationUris(publication, null, [exactWindowIdentity]);

    assert.equal(replaced.workspace.roots[0].uri, exactWindowUri);
    assert.equal(replaced.workspace.roots[0].id, createWorkspaceUriIdentity(exactWindowIdentity));
    assert.equal(replaced.workspace.navigationIdentity, createWorkspaceUriIdentity(exactWindowIdentity));
    assert.equal(publication.workspace.roots[0].uri, 'vscode-remote://dev-container%2Bcurrent/workspaces/app');
    const sameUri = authoritativeUri(
        publication.workspace.roots[0].uri,
        'vscode-remote',
        'dev-container+current',
        '/workspaces/app'
    );
    assert.equal(
        replaceOpenWorkspacePublicationUris(publication, null, [sameUri]).workspace.navigationUri,
        publication.workspace.navigationUri
    );
});

test('OPEN-OPEN-PROJECT-AUTHORITATIVE-IDENTITY-001 keeps same-path authorities as distinct workspace cards', () => {
    const source = makeRecord({ uri: 'file:///work/reddb', name: 'reddb' });
    const rewrite = (instanceId, environment, target) =>
        replaceOpenWorkspacePublicationUris(
            makePublication({ instanceId, workspace: { ...source, environment } }),
            null,
            [target]
        ).workspace;
    const local = rewrite(OTHER, 'local', authoritativeUri(
        'file:///work/reddb',
        'file',
        '',
        '/work/reddb'
    ));
    const ssh = rewrite(OLDER, 'ssh', authoritativeUri(
        'vscode-remote://ssh-remote%2Bhost/work/reddb',
        'vscode-remote',
        'ssh-remote+host',
        '/work/reddb'
    ));
    const container = rewrite(
        NEWER,
        'devContainer',
        authoritativeUri(
            'vscode-remote://dev-container%2Bdevbox/work/reddb',
            'vscode-remote',
            'dev-container+devbox',
            '/work/reddb'
        )
    );
    const projections = projectOpenWorkspaceNavigationCards(null, makeAggregate([
        makeRegistration(OTHER, 500, local.navigationUri, { workspace: local }),
        makeRegistration(OLDER, 1000, ssh.navigationUri, { workspace: ssh }),
        makeRegistration(NEWER, 2000, container.navigationUri, { workspace: container }),
    ]), SELF);
    const projectionsFromContainer = projectOpenWorkspaceNavigationCards(
        { navigationIdentity: container.navigationIdentity },
        makeAggregate([
            makeRegistration(OTHER, 500, local.navigationUri, { workspace: local }),
            makeRegistration(OLDER, 1000, ssh.navigationUri, { workspace: ssh }),
            makeRegistration(NEWER, 2000, container.navigationUri, { workspace: container }),
        ]),
        SELF
    );

    assert.notEqual(local.navigationIdentity, container.navigationIdentity);
    assert.notEqual(local.scopeIdentity, container.scopeIdentity);
    assert.notEqual(local.roots[0].id, container.roots[0].id);
    assert.notEqual(ssh.navigationIdentity, container.navigationIdentity);
    assert.notEqual(ssh.scopeIdentity, container.scopeIdentity);
    assert.notEqual(ssh.roots[0].id, container.roots[0].id);
    assert.equal(projections.length, 3);
    assert.deepEqual(
        projectionsFromContainer.map(projection => projection.workspace.environment),
        ['local', 'ssh']
    );
    assert.equal(
        ssh.navigationIdentity,
        createWorkspaceUriIdentity({
            scheme: 'vscode-remote',
            authority: 'ssh-remote+host',
            path: '/work/reddb',
        })
    );
});

test('SESSION-IDENTITY-001 normalizes URI scheme and Unicode representation without erasing authority identity', () => {
    assert.equal(
        normalizeWorkspaceUri({ scheme: 'FILE', authority: '', path: '/work/cafe\u0301' }),
        normalizeWorkspaceUri({ scheme: 'file', authority: '', path: '/work/café' })
    );
    assert.notEqual(
        normalizeWorkspaceUri({ scheme: 'vscode-remote', authority: 'ssh-remote+one', path: '/work/shared' }),
        normalizeWorkspaceUri({ scheme: 'vscode-remote', authority: 'ssh-remote+two', path: '/work/shared' })
    );
    assert.notEqual(
        normalizeWorkspaceUri({ scheme: 'file', authority: '', path: '/work/project ' }),
        normalizeWorkspaceUri({ scheme: 'file', authority: '', path: '/work/project' })
    );
});

test('SESSION-RECORD-001 converts workspace metadata and carries the exact running-session count', () => {
    const workspace = {
        navigationIdentity: 'a'.repeat(64), scopeIdentity: 'b'.repeat(64),
        kind: 'savedMultiRoot', displayName: 'Workspace', navigationUri: 'file:///work/all.code-workspace',
        environment: 'local', roots: [
            { id: 'c'.repeat(64), name: 'App', uri: 'file:///work/app', hostPath: '/work/app', ordinal: 0 },
            { id: 'd'.repeat(64), name: 'API', uri: 'file:///work/api', hostPath: '/work/api', ordinal: 1 },
        ],
    };
    const record = createOpenWorkspacePublication(workspace, 2);
    assert.equal(record.runningAiSessionCount, 2);
    assert.deepEqual(record.roots.map(root => [root.name, root.ordinal]), [['App', 0], ['API', 1]]);
    assert.equal(createOpenWorkspacePublication(null, 2), null);
});

test('PROJECT-PROJECTION-001 keeps current cards, excludes own and current identities, and picks the focused duplicate', () => {
    const current = makeRecord({ uri: '/work/current' });
    const sharedIdentity = makeRecord({ uri: '/work/shared' }).navigationIdentity;
    const aggregate = makeAggregate([
        makeRegistration(SELF, 5000, '/work/self'),
        makeRegistration(OLDER, 2000, '/work/current'),
        makeRegistration(OLDER, 2000, '/work/shared/', {
            workspace: makeRecord({ uri: '/work/shared/', navigationIdentity: sharedIdentity, name: 'Older Shared' }),
        }),
        makeRegistration(NEWER, 3000, '/work/shared', {
            workspace: makeRecord({ uri: '/work/shared', navigationIdentity: sharedIdentity }),
        }),
        makeRegistration(OTHER, 2500, '/work/running', {
            projects: [makeRecord({ name: 'Running', uri: '/work/running', activeSessionCount: 3 })],
        }),
    ]);

    const cards = projectOpenWorkspaceCards(current, aggregate, SELF);

    assert.deepEqual(cards.map(card => card.name), ['Shared', 'Running']);
    assert.equal(cards[0].kind, 'navigation');
    assert.equal(cards[0].runningSessionCount, 0);
    assert.equal(cards[1].runningSessionCount, 3);
    assert.match(cards[0].id, /^__openWorkspaceNavigation-[a-f0-9]{24}$/);
});

test('OPEN-OTHER-WINDOWS-PRIVACY-001 exposes only the latest privacy-bounded workspace summary', () => {
    const current = makeRecord({ uri: '/work/current' });
    const sharedIdentity = makeRecord({ uri: '/work/shared' }).navigationIdentity;
    const latest = makeRecord({
        uri: '/work/shared',
        navigationIdentity: sharedIdentity,
        name: 'Latest Shared',
        activeSessionCount: 2,
        providerId: 'codex',
        sessionId: 'secret-session',
        sessionName: 'Secret title',
        cwd: '/private/cwd',
        markerPath: '/private/marker',
    });
    const attention = {
        protocolVersion: 1,
        aggregateRevision: 'b'.repeat(64),
        generatedAtMs: 20,
        sessions: [{
            projectId: getAttentionProjectKeys(latest.roots.map(root => root.uri))[0],
            sessionKey: 'codex:secret-session',
            eventIds: ['attention-event'],
            reasons: ['completed'],
            observedAtMs: 19,
        }],
    };
    const cards = projectOpenWorkspaceCards(current, makeAggregate([
        makeRegistration(SELF, 9000, '/work/own', {
            workspace: makeRecord({ uri: '/work/own', name: 'Own instance' }),
        }),
        makeRegistration(OLDER, 8000, '/work/current', {
            workspace: makeRecord({
                uri: '/work/current',
                navigationIdentity: current.navigationIdentity,
                name: 'Current duplicate',
            }),
        }),
        makeRegistration(OLDER, 1000, '/work/shared', {
            workspace: makeRecord({
                uri: '/work/shared',
                navigationIdentity: sharedIdentity,
                name: 'Older Shared',
            }),
        }),
        makeRegistration(NEWER, 2000, '/work/shared', {
            workspace: latest,
            providerId: 'claude',
            sessionId: 'registration-secret',
        }),
    ]), SELF, attention);

    assert.equal(cards.length, 1);
    assert.equal(cards[0].name, 'Latest Shared');
    assert.equal(cards[0].runningSessionCount, 2);
    assert.equal(cards[0].attentionCount, 1);
    assert.deepEqual(Object.keys(cards[0]).sort(), [
        'attentionCount',
        'environment',
        'environmentLabel',
        'id',
        'kind',
        'name',
        'navigationIdentity',
        'pinned',
        'roots',
        'runningSessionCount',
        'scopeIdentity',
        'showSaveAction',
        'workspaceKind',
    ]);
    const forbiddenKeys = new Set([
        'providerId', 'sessionId', 'sessionName', 'sessionTitle', 'cwd', 'markerPath',
    ]);
    function assertPrivacyBounded(value) {
        if (!value || typeof value !== 'object') return;
        for (const [key, nested] of Object.entries(value)) {
            assert.equal(forbiddenKeys.has(key), false, `forbidden OTHER WINDOWS key: ${key}`);
            assertPrivacyBounded(nested);
        }
    }
    assertPrivacyBounded(cards[0]);
    assert.equal(JSON.stringify(cards[0]).includes('Secret title'), false);
    assert.equal(JSON.stringify(cards[0]).includes('/private/'), false);
});

test('OPEN-WORKSPACE-PIN-SORT-001 keeps pinned windows first in pin order and unpinned windows in stable open order', () => {
    const oldestPin = makeRecord({ uri: '/work/oldest-pin', name: 'Oldest pin' });
    const newerPin = makeRecord({ uri: '/work/newer-pin', name: 'Newer pin' });
    const recent = makeRecord({ uri: '/work/recent', name: 'Recent' });
    const older = makeRecord({ uri: '/work/older', name: 'Older' });
    const aggregate = makeAggregate([
        makeRegistration(OTHER, 100, oldestPin.navigationUri, {
            openedAtMs: 4000, workspace: oldestPin,
        }),
        makeRegistration(OLDER, 9000, newerPin.navigationUri, {
            openedAtMs: 3000, workspace: newerPin,
        }),
        makeRegistration(NEWER, 8000, recent.navigationUri, {
            openedAtMs: 2000, workspace: recent,
        }),
        makeRegistration('5'.repeat(32), 2000, older.navigationUri, {
            openedAtMs: 1000, workspace: older,
        }),
    ]);
    const pinTimes = new Map([
        [newerPin.navigationIdentity, 2000],
        [oldestPin.navigationIdentity, 1000],
    ]);

    const first = projectOpenWorkspaceCards(null, aggregate, SELF, null, pinTimes);
    const focusChanged = projectOpenWorkspaceCards(null, {
        ...aggregate,
        registrations: aggregate.registrations.map(registration => ({
            ...registration,
            lastFocusedAtMs: registration.workspace.navigationIdentity === oldestPin.navigationIdentity
                ? 20_000
                : registration.lastFocusedAtMs,
        })),
    }, SELF, null, pinTimes);

    assert.deepEqual(first.map(card => card.name), [
        'Oldest pin', 'Newer pin', 'Older', 'Recent',
    ]);
    assert.deepEqual(focusChanged.map(card => card.name), [
        'Oldest pin', 'Newer pin', 'Older', 'Recent',
    ]);
    assert.deepEqual(first.map(card => card.pinned), [true, true, false, false]);
});

test('ATTENTION-REMOTE-ATTENTION-IDENTITY-001 derives attention identity from the exact remote URI', () => {
    const localPath = '/workspaces/shared';
    const remoteUri = 'vscode-remote://dev-container%2Btarget/workspaces/shared';
    const replaced = replaceOpenWorkspacePublicationUris(makePublication({
        workspace: makeRecord({ uri: localPath, remoteType: 'devContainer' }),
    }), null, [authoritativeUri(
        remoteUri,
        'vscode-remote',
        'dev-container+target',
        '/workspaces/shared'
    )]);
    const attention = {
        protocolVersion: 1,
        aggregateRevision: 'a'.repeat(64),
        generatedAtMs: 10,
        sessions: [{
            projectId: getAttentionProjectKeys([remoteUri])[0],
            sessionKey: 'codex:019f7d85-3b51-7b82-8590-02409fcdffcd',
            eventIds: ['event-remote'],
            reasons: ['completed'],
            observedAtMs: 9,
        }],
    };
    const cards = projectOpenWorkspaceCards(null, makeAggregate([
        makeRegistration(OTHER, 4000, remoteUri, { workspace: replaced.workspace }),
    ]), SELF, attention);

    assert.equal(cards[0].attentionCount, 1);
});
