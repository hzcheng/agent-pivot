'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    acceptedIsolatedSessionSettlement,
    cancelledMutationSettlement,
    parseIsolatedSessionRequest,
    settledIsolatedSessionSettlement,
} = require('../../../out/worktrees/provisioningProtocol');

test('WORKTREE-PROVISIONING-PROTOCOL-001 accepts only exact versioned request shapes', () => {
    const start = {
        type: 'start-isolated-session', version: 1,
        requestId: 'isolated-1', projectId: 'project',
    };
    const retry = {
        type: 'retry-isolated-session', version: 1,
        requestId: 'isolated-2', projectId: 'project', operationId: 'isolated-1',
    };
    assert.deepEqual(parseIsolatedSessionRequest(start), start);
    assert.deepEqual(parseIsolatedSessionRequest(retry), retry);
    const sourceWorktree = {
        repositoryKey: '/repo/.git',
        canonicalWorktreePath: '/repo/.agent-pivot/worktrees/est',
    };
    assert.deepEqual(
        parseIsolatedSessionRequest({ ...start, sourceWorktree }),
        { ...start, sourceWorktree },
        'a start request may name the worktree branch to base on'
    );
    assert.equal(parseIsolatedSessionRequest({ ...start, version: 2 }), null);
    assert.equal(parseIsolatedSessionRequest({ ...start, forged: true }), null);
    assert.equal(parseIsolatedSessionRequest({
        ...start, sourceWorktree: { ...sourceWorktree, extra: true },
    }), null, 'a forged source worktree key must reject the whole request');
    assert.equal(parseIsolatedSessionRequest({
        ...start, sourceWorktree: { repositoryKey: 7, canonicalWorktreePath: '/x' },
    }), null);
    assert.equal(parseIsolatedSessionRequest({ ...retry, operationId: '../bad' }), null);
    assert.equal(parseIsolatedSessionRequest({ ...retry, requestId: '' }), null);
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 distinguishes accepted progress from one terminal settlement', () => {
    const request = parseIsolatedSessionRequest({
        type: 'start-isolated-session', version: 1,
        requestId: 'isolated-1', projectId: 'project',
    });
    assert.deepEqual(acceptedIsolatedSessionSettlement(request), {
        type: 'isolated-session-settlement', version: 1,
        requestId: 'isolated-1', operationId: 'isolated-1', status: 'accepted',
    });
    assert.deepEqual(settledIsolatedSessionSettlement(request, {
        kind: 'partial', operationId: 'isolated-1',
        worktreeKey: { repositoryKey: '/repo/.git', canonicalWorktreePath: '/worktree' },
        errorCode: 'agent-start-failed', completedSteps: ['worktree', 'setup'],
    }), {
        type: 'isolated-session-settlement', version: 1,
        requestId: 'isolated-1', operationId: 'isolated-1',
        status: 'partial', errorCode: 'agent-start-failed',
    });
});

test('WORKTREE-PROVISIONING-PROTOCOL-001 settles cancel commands independently', () => {
    const request = parseIsolatedSessionRequest({
        type: 'cancel-isolated-session', version: 1,
        requestId: 'cancel-1', projectId: 'project', operationId: 'isolated-1',
    });
    assert.equal(cancelledMutationSettlement(request, true).status, 'succeeded');
    assert.deepEqual(cancelledMutationSettlement(request, false), {
        type: 'isolated-session-settlement', version: 1,
        requestId: 'cancel-1', operationId: 'isolated-1',
        status: 'rejected', errorCode: 'cancel-unavailable',
    });
});
