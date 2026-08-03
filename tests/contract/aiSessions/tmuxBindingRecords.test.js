'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    makeTmuxInactiveBinding,
    makeTmuxKnownBinding,
    makeTmuxPendingBinding,
} = require('../../helpers/runtimeContract');
const {
    ambiguousIdentityParts,
    ambiguousRecordIdentityParts,
    ambiguousRecordMatchesIdentity,
    cloneAmbiguous,
    cloneConsumed,
    clonePromoting,
    consumedMatchesPromoting,
    consumedRecordMatchesIdentity,
    isCanonicalRecordPath,
    isLegacyProjectKeyConsumedRecord,
    pendingBindingsEqual,
    pendingLifecycleRecordKey,
    promotingRecordMatchesIdentity,
    validateAmbiguousRecord,
    validateConsumedRecord,
    validateKnownRebindIntent,
    validatePromotingRecord,
} = require('../../../out/aiSessions/tmuxBindingRecords');

const NOW = Date.parse('2026-07-18T10:00:00.000Z');
const FINGERPRINT = 'a'.repeat(64);

function identityOf(record) {
    return {
        provider: record.provider,
        workspaceScopeIdentity: record.workspaceScopeIdentity,
        workspaceNavigationIdentity: record.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...record.workspaceRootHostPaths],
        cwd: record.cwd,
        pendingId: record.pendingId,
    };
}

function makeConsumedBinding(pendingId, overrides = {}) {
    const pending = makeTmuxPendingBinding(pendingId);
    const finalLocator = overrides.finalLocator
        || { layout: pending.layout, sessionName: 'final-' + pendingId, windowName: 'final-window' };
    return {
        version: 2,
        state: 'consumed',
        ...identityOf(pending),
        finalSessionId: 'final-session-' + pendingId,
        ...(overrides.omitFinalSessionName ? {} : { finalSessionName: 'Final ' + pendingId }),
        layout: pending.layout,
        finalLocator,
        consumedAtMs: overrides.consumedAtMs ?? NOW,
        ...(overrides.extra || {}),
    };
}

function makePromotingBinding(pendingId, overrides = {}) {
    const pendingBinding = overrides.pendingBinding || makeTmuxPendingBinding(pendingId);
    const sourceLocator = overrides.sourceLocator || { ...pendingBinding.locator };
    const finalLocator = overrides.finalLocator
        || { layout: pendingBinding.layout, sessionName: sourceLocator.sessionName, windowName: 'promoted-window' };
    return {
        version: 2,
        state: 'promoting',
        ...identityOf(pendingBinding),
        createdAt: pendingBinding.createdAt,
        markerPath: '',
        pendingBinding,
        finalSessionId: 'final-session-' + pendingId,
        finalSessionName: 'Final ' + pendingId,
        layout: pendingBinding.layout,
        sourceLocator,
        finalLocator,
        requestFingerprint: FINGERPRINT,
        recordedAtMs: overrides.recordedAtMs ?? NOW,
        ...(overrides.extra || {}),
    };
}

function makeAmbiguousSessionBinding(sessionId) {
    const known = makeTmuxKnownBinding(sessionId);
    return {
        version: 2,
        state: 'ambiguous',
        provider: known.provider,
        workspaceScopeIdentity: known.workspaceScopeIdentity,
        workspaceNavigationIdentity: known.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...known.workspaceRootHostPaths],
        cwd: known.cwd,
        layout: known.layout,
        locator: { ...known.locator },
        acceptedAtMs: NOW,
        sessionId,
    };
}

function makeAmbiguousPendingBinding(pendingId, overrides = {}) {
    const pending = makeTmuxPendingBinding(pendingId);
    return {
        version: 2,
        state: 'ambiguous',
        provider: pending.provider,
        workspaceScopeIdentity: pending.workspaceScopeIdentity,
        workspaceNavigationIdentity: pending.workspaceNavigationIdentity,
        workspaceRootHostPaths: [...pending.workspaceRootHostPaths],
        cwd: pending.cwd,
        layout: pending.layout,
        locator: { ...pending.locator },
        acceptedAtMs: NOW,
        pendingId,
        createdAt: pending.createdAt,
        excludedSessionIds: ['excluded-one'],
        requestFingerprint: FINGERPRINT,
        ...(overrides.extra || {}),
    };
}

function mutations(record, cases) {
    return cases.map(([label, mutate]) => {
        const copy = JSON.parse(JSON.stringify(record));
        const replacement = mutate(copy);
        return [label, replacement === undefined ? copy : replacement];
    });
}

test('RUNTIME-TMUX-RECORDS-001 validates consumed records with and without a final session name', () => {
    const withName = makeConsumedBinding('consumed-one');
    assert.equal(validateConsumedRecord(withName)?.finalSessionName, 'Final consumed-one');
    assert.equal(validateConsumedRecord(withName, true)?.pendingId, 'consumed-one');

    const withoutName = makeConsumedBinding('consumed-two', { omitFinalSessionName: true });
    assert.equal(validateConsumedRecord(withoutName)?.pendingId, 'consumed-two');
    assert.equal(validateConsumedRecord(withoutName, true), null);

    for (const [label, copy] of mutations(withName, [
        ['non-object', record => record = null],
        ['bad version', record => { record.version = 1; }],
        ['bad state', record => { record.state = 'pending'; }],
        ['extra key', record => { record.extra = true; }],
        ['missing key', record => { delete record.finalSessionId; }],
        ['empty finalSessionId', record => { record.finalSessionId = ''; }],
        ['empty finalSessionName', record => { record.finalSessionName = '  '; }],
        ['bad layout', record => { record.layout = 'unknown'; }],
        ['locator layout mismatch', record => { record.finalLocator = { layout: 'session', sessionName: 'x' }; }],
        ['negative consumedAtMs', record => { record.consumedAtMs = -1; }],
    ])) {
        assert.equal(validateConsumedRecord(copy), null, label);
    }
});

test('RUNTIME-TMUX-RECORDS-001 detects legacy project-key consumed records', () => {
    const pending = makeTmuxPendingBinding('legacy-one');
    const legacy = {
        version: 1,
        state: 'consumed',
        pendingId: pending.pendingId,
        provider: pending.provider,
        projectKey: 'project-key-one',
        cwd: pending.cwd,
        finalSessionId: 'final-session-legacy',
        layout: pending.layout,
        finalLocator: { layout: pending.layout, sessionName: 'final-legacy', windowName: 'w' },
        consumedAtMs: NOW,
    };
    assert.equal(isLegacyProjectKeyConsumedRecord(legacy), true);
    assert.equal(isLegacyProjectKeyConsumedRecord(null), false);
    assert.equal(isLegacyProjectKeyConsumedRecord({ ...legacy, version: 2 }), false);
    assert.equal(isLegacyProjectKeyConsumedRecord({ ...legacy, projectKey: '' }), false);
    assert.equal(isLegacyProjectKeyConsumedRecord({ ...legacy, extra: true }), false);
    assert.equal(isLegacyProjectKeyConsumedRecord({
        ...legacy,
        finalLocator: { layout: 'session', sessionName: 'mismatch' },
    }), false);
});

test('RUNTIME-TMUX-RECORDS-001 validates promoting records and their pending consistency', () => {
    const promoting = makePromotingBinding('promoting-one');
    assert.equal(validatePromotingRecord(promoting)?.pendingId, 'promoting-one');

    for (const [label, copy] of mutations(promoting, [
        ['non-object', () => null],
        ['bad state', record => { record.state = 'consumed'; }],
        ['missing finalSessionName', record => { delete record.finalSessionName; }],
        ['bad markerPath', record => { record.markerPath = 42; }],
        ['locators identical', record => { record.finalLocator = { ...record.sourceLocator }; }],
        ['final locator layout mismatch', record => { record.finalLocator = { layout: 'session', sessionName: 'x' }; }],
        ['source session differs from final', record => {
            record.sourceLocator = { layout: 'project', sessionName: 'other', windowName: 'w' };
        }],
        ['pending id mismatch', record => { record.pendingBinding = makeTmuxPendingBinding('other-pending'); }],
        ['createdAt mismatch', record => {
            record.pendingBinding = { ...record.pendingBinding, createdAt: '2026-01-01T00:00:00.000Z' };
        }],
        ['pending locator mismatch', record => {
            record.pendingBinding = { ...record.pendingBinding, locator: { layout: 'session', sessionName: 'elsewhere' } };
        }],
        ['bad fingerprint', record => { record.requestFingerprint = 'not-a-fingerprint'; }],
        ['negative recordedAtMs', record => { record.recordedAtMs = -5; }],
    ])) {
        assert.equal(validatePromotingRecord(copy), null, label);
    }

    const promoted = makePromotingBinding('promoting-two');
    assert.equal(consumedMatchesPromoting(
        { ...makeConsumedBinding('promoting-two'), finalSessionId: promoted.finalSessionId,
            finalSessionName: promoted.finalSessionName, finalLocator: promoted.finalLocator },
        promoted
    ), true);
    assert.equal(consumedMatchesPromoting(makeConsumedBinding('other'), promoted), false);
    assert.equal(consumedMatchesPromoting(
        { ...makeConsumedBinding('promoting-two', { omitFinalSessionName: true }),
            finalSessionId: promoted.finalSessionId, finalLocator: promoted.finalLocator },
        promoted
    ), false);
});

test('RUNTIME-TMUX-RECORDS-001 validates ambiguous session and pending variants', () => {
    const sessionVariant = makeAmbiguousSessionBinding('ambiguous-session');
    assert.equal(validateAmbiguousRecord(sessionVariant)?.sessionId, 'ambiguous-session');

    const pendingVariant = makeAmbiguousPendingBinding('ambiguous-pending', {
        extra: { projectName: 'RedDB', title: 'Repair', markerPath: '/tmp/m.done' },
    });
    const validatedPending = validateAmbiguousRecord(pendingVariant);
    assert.equal(validatedPending?.pendingId, 'ambiguous-pending');
    assert.equal(validatedPending?.projectName, 'RedDB');
    assert.deepEqual(validateAmbiguousRecord({
        ...pendingVariant,
        requestFingerprint: 'v3:' + FINGERPRINT,
    })?.pendingId, 'ambiguous-pending');

    for (const [label, copy] of [
        ['both ids', { ...sessionVariant, pendingId: 'p2', createdAt: 'x', excludedSessionIds: [], requestFingerprint: FINGERPRINT }],
        ['neither id', (() => { const r = makeAmbiguousPendingBinding('x'); delete r.pendingId; delete r.sessionId; return r; })()],
        ['bad excluded ids', { ...makeAmbiguousPendingBinding('x'), excludedSessionIds: [''] }],
        ['too many excluded ids', { ...makeAmbiguousPendingBinding('x'), excludedSessionIds: Array(1001).fill('a') }],
        ['bad projectName', { ...makeAmbiguousPendingBinding('x'), projectName: 1 }],
        ['bad fingerprint', { ...makeAmbiguousPendingBinding('x'), requestFingerprint: 'zz' }],
        ['locator layout mismatch', { ...sessionVariant, locator: { layout: 'session', sessionName: 'y' } }],
        ['negative acceptedAtMs', { ...sessionVariant, acceptedAtMs: -1 }],
    ]) {
        assert.equal(validateAmbiguousRecord(copy), null, label);
    }
});

test('RUNTIME-TMUX-RECORDS-001 derives ambiguous identity parts for both variants', () => {
    const sessionIdentity = {
        ...identityOf(makeTmuxPendingBinding('unused')),
        pendingId: undefined,
        sessionId: 'session-x',
    };
    delete sessionIdentity.pendingId;
    assert.deepEqual(ambiguousIdentityParts(sessionIdentity), [
        sessionIdentity.provider, sessionIdentity.workspaceScopeIdentity, 'session', 'session-x',
    ]);

    const pendingIdentity = identityOf(makeTmuxPendingBinding('pending-y'));
    const parts = ambiguousIdentityParts(pendingIdentity);
    assert.deepEqual(parts.slice(0, 3), [pendingIdentity.provider, pendingIdentity.workspaceScopeIdentity, 'pending']);
    assert.equal(parts.at(-1), 'pending-y');

    assert.equal(ambiguousIdentityParts({ ...sessionIdentity, pendingId: 'also-pending' }), null);
    assert.equal(ambiguousIdentityParts({ provider: 'unknown' }), null);
    assert.equal(ambiguousIdentityParts({ ...sessionIdentity, sessionId: '' }), null);

    assert.deepEqual(
        ambiguousRecordIdentityParts(makeAmbiguousSessionBinding('record-session')),
        ['codex', makeTmuxKnownBinding('record-session').workspaceScopeIdentity, 'session', 'record-session']
    );
    const pendingParts = ambiguousRecordIdentityParts(makeAmbiguousPendingBinding('record-pending'));
    assert.equal(pendingParts[2], 'pending');
    assert.equal(pendingParts.at(-1), 'record-pending');
});

test('RUNTIME-TMUX-RECORDS-001 clones ambiguous, promoting, and consumed records defensively', () => {
    const ambiguous = makeAmbiguousPendingBinding('clone-ambiguous', { extra: { title: 'T' } });
    const ambiguousCopy = cloneAmbiguous(ambiguous);
    assert.deepEqual(ambiguousCopy, ambiguous);
    ambiguousCopy.excludedSessionIds.push('mutated');
    ambiguousCopy.locator.sessionName = 'mutated';
    assert.equal(ambiguous.excludedSessionIds.length, 1);
    assert.notEqual(ambiguous.locator.sessionName, 'mutated');

    const promoting = makePromotingBinding('clone-promoting');
    const promotingCopy = clonePromoting(promoting);
    assert.deepEqual(promotingCopy, promoting);
    promotingCopy.pendingBinding.excludedSessionIds.push('mutated');
    promotingCopy.sourceLocator.sessionName = 'mutated';
    assert.equal(promoting.pendingBinding.excludedSessionIds.length, 0);
    assert.notEqual(promoting.sourceLocator.sessionName, 'mutated');

    const consumed = makeConsumedBinding('clone-consumed');
    const consumedCopy = cloneConsumed(consumed);
    assert.deepEqual(consumedCopy, consumed);
    consumedCopy.finalLocator.sessionName = 'mutated';
    assert.notEqual(consumed.finalLocator.sessionName, 'mutated');
});

test('RUNTIME-TMUX-RECORDS-001 matches records against runtime identities', () => {
    const promoting = makePromotingBinding('match-promoting');
    const identity = identityOf(makeTmuxPendingBinding('match-promoting'));
    assert.equal(promotingRecordMatchesIdentity(promoting, identity), true);
    assert.equal(promotingRecordMatchesIdentity(promoting, { ...identity, pendingId: 'other' }), false);

    const ambiguous = makeAmbiguousPendingBinding('match-ambiguous');
    assert.equal(ambiguousRecordMatchesIdentity(ambiguous, identityOf(makeTmuxPendingBinding('match-ambiguous'))), true);
    assert.equal(ambiguousRecordMatchesIdentity(ambiguous, { ...identity, pendingId: 'other' }), false);

    const consumed = makeConsumedBinding('match-promoting');
    assert.equal(consumedRecordMatchesIdentity(consumed, identity), true);
    assert.equal(consumedRecordMatchesIdentity(consumed, { ...identity, cwd: '/elsewhere' }), false);
});

test('RUNTIME-TMUX-RECORDS-001 compares pending bindings and lifecycle keys', () => {
    const left = makeTmuxPendingBinding('equal-one', { title: 'A' });
    const right = makeTmuxPendingBinding('equal-one', { title: 'A' });
    assert.equal(pendingBindingsEqual(left, right), true);
    assert.equal(pendingLifecycleRecordKey(left), pendingLifecycleRecordKey(right));
    assert.equal(pendingBindingsEqual(left, { ...right, title: 'B' }), false);
    assert.equal(pendingBindingsEqual(left, { ...right, excludedSessionIds: ['x'] }), false);
    assert.equal(pendingBindingsEqual(left, {
        ...right,
        locator: { ...right.locator, sessionName: 'different' },
    }), false);
});

test('RUNTIME-TMUX-RECORDS-001 classifies canonical record paths', () => {
    const { createHash } = require('node:crypto');
    const pending = makeTmuxPendingBinding('canonical-one');
    const identityParts = [pending.provider, pending.workspaceScopeIdentity,
        pending.workspaceNavigationIdentity,
        require('../../../out/aiSessions/runtimeTypes').getAiSessionRuntimeRootSnapshotKey(pending),
        pending.cwd, pending.pendingId];
    const canonicalName = `pending-${createHash('sha256')
        .update(JSON.stringify([2, 'pending', ...identityParts]), 'utf8').digest('hex')}.json`;
    assert.equal(isCanonicalRecordPath(`/records/${canonicalName}`, pending), true);
    assert.equal(isCanonicalRecordPath('/records/pending-deadbeef.json', pending), false);
    assert.equal(isCanonicalRecordPath('/records/rebind-known-deadbeef.json',
        { ...makeTmuxKnownBinding('rebind-one'), state: 'rebind-known' }), false);

    const known = makeTmuxKnownBinding('canonical-known');
    const completed = makeTmuxInactiveBinding('canonical-known', 'completed');
    const knownParts = [known.provider, known.workspaceScopeIdentity, known.sessionId];
    const knownName = `known-${createHash('sha256')
        .update(JSON.stringify([2, 'known', ...knownParts]), 'utf8').digest('hex')}.json`;
    assert.equal(isCanonicalRecordPath(`/records/${knownName}`, known), true);
    assert.equal(isCanonicalRecordPath(`/records/${knownName}`, completed), true);
});

test('RUNTIME-TMUX-RECORDS-001 validates known rebind intents', () => {
    const expected = makeTmuxKnownBinding('rebind-expected');
    const replacement = { ...expected, sessionId: 'rebind-replacement' };
    const intent = {
        version: 1,
        state: 'rebind-known',
        expected,
        replacement,
        recordedAtMs: NOW,
    };
    const validated = validateKnownRebindIntent(intent);
    assert.equal(validated?.expected.sessionId, 'rebind-expected');
    assert.equal(validated?.replacement.sessionId, 'rebind-replacement');

    assert.equal(validateKnownRebindIntent({ ...intent, version: 2 }), null);
    assert.equal(validateKnownRebindIntent({ ...intent, state: 'known' }), null);
    assert.equal(validateKnownRebindIntent({ ...intent, expected: { ...expected, markerPath: '/different' } }), null);
    assert.equal(validateKnownRebindIntent({ ...intent, replacement: { ...replacement, sessionId: expected.sessionId } }), null);
    assert.equal(validateKnownRebindIntent({ ...intent, recordedAtMs: -1 }), null);
});
