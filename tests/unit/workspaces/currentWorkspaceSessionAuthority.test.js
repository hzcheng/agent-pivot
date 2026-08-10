'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    CURRENT_WORKSPACE_SESSION_AUTHORITY_STATE_KEY,
    CurrentWorkspaceSessionAuthority,
    createLegacyCurrentWorkspaceProjectId,
} = require('../../../out/workspaces/currentWorkspaceSessionAuthority');

function identity(scopeIdentity, navigationIdentity = 'navigation:reddb-dev') {
    return {
        workspaceNavigationIdentity: navigationIdentity,
        workspaceScopeIdentity: scopeIdentity,
    };
}

function createState(initialValue) {
    let value = initialValue;
    return {
        get(key) {
            assert.equal(key, CURRENT_WORKSPACE_SESSION_AUTHORITY_STATE_KEY);
            return value;
        },
        update(key, next) {
            assert.equal(key, CURRENT_WORKSPACE_SESSION_AUTHORITY_STATE_KEY);
            value = next;
            return Promise.resolve();
        },
        read: () => value,
    };
}

test('RUNTIME-WORKSPACE-TOPOLOGY-CONTINUITY-001 assigns one Session authority across root topology changes and restarts', async () => {
    const state = createState();
    const authority = new CurrentWorkspaceSessionAuthority(state);
    const initial = authority.getProjectId(identity('scope:three-roots'));

    assert.equal(
        initial,
        createLegacyCurrentWorkspaceProjectId('scope:three-roots'),
        'first adoption preserves the existing Conversation metadata key'
    );
    assert.equal(
        authority.getProjectId(identity('scope:five-roots')),
        initial,
        'scope changes cannot rotate the logical workspace authority'
    );
    await new Promise(resolve => setImmediate(resolve));

    const restarted = new CurrentWorkspaceSessionAuthority(state);
    assert.equal(restarted.getProjectId(identity('scope:five-roots')), initial);
    const other = restarted.getProjectId(
        identity('scope:other', 'navigation:other')
    );
    assert.notEqual(
        other,
        initial,
        'a real workspace navigation change must rotate authority'
    );
    await new Promise(resolve => setImmediate(resolve));

    const returned = new CurrentWorkspaceSessionAuthority(state);
    assert.equal(
        returned.getProjectId(identity('scope:seven-roots')),
        initial,
        'restoring another workspace cannot overwrite the first authority'
    );
    assert.equal(
        returned.getProjectId(identity('scope:other-changed', 'navigation:other')),
        other
    );
});

test('RUNTIME-WORKSPACE-TOPOLOGY-CONTINUITY-001 ignores malformed persisted Session authority', async () => {
    const state = createState({
        version: 1,
        workspaces: [{
            workspaceNavigationIdentity: 'navigation:reddb-dev',
            projectId: '__currentWorkspace-not-a-digest',
        }],
    });
    const authority = new CurrentWorkspaceSessionAuthority(state);

    assert.equal(
        authority.getProjectId(identity('scope:current')),
        createLegacyCurrentWorkspaceProjectId('scope:current')
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.match(
        state.read().workspaces[0].projectId,
        /^__currentWorkspace-[a-f0-9]{24}$/
    );
});
