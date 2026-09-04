'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { cloneManagedValue, stableManagedValue } = require('../../../out/projects/managedRemote/causal');
const {
    createManagedRevisionSlot,
    createEmptyManagedCatalogEnvelope,
    createChecksummedLegacySnapshot,
    joinManagedCatalogEnvelopes,
    parseManagedCatalogEnvelope,
} = require('../../../out/projects/managedRemote/envelope');
const {
    createCausalVersion,
    createVersionedCandidates,
    joinVersionVectors,
    vectorIncludingVersion,
} = require('../../../out/projects/managedRemote/causal');
const {
    detectManagedLegacyDivergence,
} = require('../../../out/projects/managedRemote/legacyCompatibilityGuard');
const { ManagedRemoteCatalogService } = require('../../../out/projects/managedRemote/catalogService');
const { ManagedCatalogCoordinator } = require('../../../out/projects/managedRemote/store');

class MemoryBackend {
    constructor() {
        this.value = null;
        this.failWrites = 0;
    }
    read() { return cloneManagedValue(this.value); }
    async write(value) {
        if (this.failWrites > 0) {
            this.failWrites -= 1;
            throw new Error('backend unavailable');
        }
        this.value = cloneManagedValue(value);
    }
}

class MemoryReplicas {
    constructor() {
        this.next = 1;
        this.values = new Map();
    }
    async allocateWriter() {
        const ordinal = this.next++;
        return { writerId: `writer-${ordinal}`, actorId: `actor-${ordinal}` };
    }
    readWriter(writerId) { return cloneManagedValue(this.values.get(writerId) || null); }
    async writeWriter(writerId, value) { this.values.set(writerId, cloneManagedValue(value)); }
}

function draft() {
    const catalog = ManagedRemoteCatalogService.create('draft', prefix => `${prefix}:one`);
    catalog.addMachine({ name: 'Build', host: 'build.example.com', user: 'dev', port: 22022 });
    return catalog.getDocument();
}

test('MANAGED-REMOTE-ENVELOPE-001 joins deterministically and rejects revision identity reuse', () => {
    const left = createEmptyManagedCatalogEnvelope('left');
    const right = createEmptyManagedCatalogEnvelope('right');
    assert.equal(
        stableManagedValue(joinManagedCatalogEnvelopes(left, right)),
        stableManagedValue(joinManagedCatalogEnvelopes(right, left)),
    );
    assert.equal(
        stableManagedValue(joinManagedCatalogEnvelopes(left, left)),
        stableManagedValue(left),
    );

    const leftSlot = createManagedRevisionSlot(draft());
    const changed = new ManagedRemoteCatalogService(
        draft(), 'changed', prefix => `${prefix}:changed`,
    );
    changed.editMachine('machine:one', { name: 'Changed' });
    const rightSlot = {
        ...createManagedRevisionSlot(changed.getDocument()),
        revisionId: leftSlot.revisionId,
    };
    const leftVersion = createCausalVersion(left.causalContext, 'left');
    const rightVersion = createCausalVersion(right.causalContext, 'right');
    left.stagedRevisions.collision = createVersionedCandidates(leftSlot, leftVersion);
    left.causalContext = joinVersionVectors(left.causalContext, vectorIncludingVersion(leftVersion));
    right.stagedRevisions.collision = createVersionedCandidates(rightSlot, rightVersion);
    right.causalContext = joinVersionVectors(right.causalContext, vectorIncludingVersion(rightVersion));
    assert.throws(
        () => joinManagedCatalogEnvelopes(left, right),
        /has conflicting bytes/,
    );
});

test('MANAGED-REMOTE-ENVELOPE-001 preserves a valid authority candidate when a peer is corrupt', () => {
    const envelope = createEmptyManagedCatalogEnvelope('actor');
    envelope.authority.candidates.push({
        value: {
            lifecycle: 'active',
            active: { revisionId: 'bad', checksum: '0'.repeat(64), document: draft() },
        },
        version: { dot: { actorId: 'corrupt', counter: 1 }, context: {} },
    });
    envelope.causalContext.corrupt = 1;

    const parsed = parseManagedCatalogEnvelope(envelope);
    assert.ok(parsed);
    assert.ok(parsed.issues.some(issue => issue.startsWith('authority:invalid-value')));
    assert.deepEqual(parsed.envelope.authority.candidates.map(candidate => candidate.value.lifecycle), [
        'disabled',
    ]);
});

test('MANAGED-REMOTE-ENVELOPE-001 exposes previous revision when the only active slot is corrupt', async () => {
    const envelope = createEmptyManagedCatalogEnvelope('actor');
    const previous = createManagedRevisionSlot(draft());
    const version = createCausalVersion(envelope.causalContext, 'actor');
    envelope.authority = createVersionedCandidates({
        lifecycle: 'active',
        active: { ...previous, checksum: '0'.repeat(64) },
        previous,
    }, version);
    envelope.causalContext = joinVersionVectors(
        envelope.causalContext, vectorIncludingVersion(version),
    );
    const parsed = parseManagedCatalogEnvelope(envelope);
    assert.ok(parsed.issues.includes('authority:recovery-placeholder'));
    assert.ok(parsed.recoveryCandidates.some(candidate =>
        candidate.revisionId === previous.revisionId));

    const backend = new MemoryBackend();
    backend.value = envelope;
    const coordinator = await ManagedCatalogCoordinator.create(backend, new MemoryReplicas());
    const recovery = await coordinator.reconcile();
    assert.equal(recovery.recoveryRequired, true);
    await coordinator.activateRecoveryCandidate(previous.revisionId);
    const activated = parseManagedCatalogEnvelope(backend.value);
    assert.deepEqual(activated.issues, []);
    assert.equal(activated.envelope.authority.candidates[0].value.active.revisionId,
        previous.revisionId);
});

test('MANAGED-REMOTE-ENVELOPE-002 stages, activates, and repairs a missing backend', async () => {
    const backend = new MemoryBackend();
    const replicas = new MemoryReplicas();
    const coordinator = await ManagedCatalogCoordinator.create(backend, replicas);
    const stageId = await coordinator.stageCatalog(draft());
    const slot = await coordinator.activateStagedCatalog(stageId);

    assert.equal(slot.document.machines['machine:one'].candidates[0].value.connection.port, 22022);
    const active = parseManagedCatalogEnvelope(backend.value).envelope.authority.candidates[0].value;
    assert.equal(active.lifecycle, 'active');
    assert.equal(active.active.revisionId, slot.revisionId);

    backend.value = null;
    const repaired = await coordinator.reconcile();
    assert.equal(repaired.repairedBackend, true);
    assert.equal(parseManagedCatalogEnvelope(backend.value).envelope
        .authority.candidates[0].value.lifecycle, 'active');
});

test('MANAGED-REMOTE-ENVELOPE-002 rolls back and discards a selected recovery reference', async () => {
    const backend = new MemoryBackend();
    const replicas = new MemoryReplicas();
    const coordinator = await ManagedCatalogCoordinator.create(backend, replicas);
    const firstStage = await coordinator.stageCatalog(draft());
    const first = await coordinator.activateStagedCatalog(firstStage);
    const changed = new ManagedRemoteCatalogService(
        first.document, 'changed', prefix => `${prefix}:changed`,
    );
    changed.editMachine('machine:one', { name: 'Changed' });
    const secondStage = await coordinator.stageCatalog(changed.getDocument());
    const second = await coordinator.activateStagedCatalog(secondStage);

    const restored = await coordinator.rollBackToPrevious();
    assert.equal(restored.revisionId, first.revisionId);
    let authority = parseManagedCatalogEnvelope(backend.value)
        .envelope.authority.candidates[0].value;
    assert.equal(authority.active.revisionId, first.revisionId);
    assert.equal(authority.previous.revisionId, second.revisionId);

    await coordinator.discardRecoveryCandidate(second.revisionId);
    authority = parseManagedCatalogEnvelope(backend.value)
        .envelope.authority.candidates[0].value;
    assert.equal(authority.active.revisionId, first.revisionId);
    assert.equal(authority.previous, undefined);
});

test('MANAGED-REMOTE-ENVELOPE-002 retains a staged mutation across backend failure', async () => {
    const backend = new MemoryBackend();
    const replicas = new MemoryReplicas();
    const coordinator = await ManagedCatalogCoordinator.create(backend, replicas);
    await coordinator.reconcile();
    backend.failWrites = 1;
    await assert.rejects(coordinator.stageCatalog(draft()), /backend unavailable/);

    const recovered = await coordinator.reconcile();
    const stages = Object.values(recovered.envelope.stagedRevisions)
        .flatMap(register => register.candidates)
        .filter(candidate => candidate.value !== null);
    assert.equal(stages.length, 1);
    assert.equal(recovered.repairedBackend, true);
});

test('MANAGED-REMOTE-COMPATIBILITY-001 preserves old-client edits as an explicit divergence', () => {
    const frozen = createChecksummedLegacySnapshot([{ id: 'old' }], { revision: 1 });
    assert.equal(detectManagedLegacyDivergence(
        frozen, [{ id: 'old' }], { revision: 1 },
    ), null);

    const divergence = detectManagedLegacyDivergence(
        frozen,
        [{ id: 'old' }, { id: 'offline-addition' }],
        { revision: 2 },
    );
    assert.deepEqual(divergence.changedSources, ['projectData', 'projectSyncData']);
    assert.match(divergence.divergenceId, /^legacy-divergence:/);
    assert.deepEqual(divergence.current.projectData, [
        { id: 'old' }, { id: 'offline-addition' },
    ]);
});
