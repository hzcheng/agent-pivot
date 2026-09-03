'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const ENVIRONMENT_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_ENVIRONMENT_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR_A = 'a'.repeat(32);
const ACTOR_B = 'b'.repeat(32);
const ACTOR_C = 'c'.repeat(32);
const ACTOR_D = 'd'.repeat(32);

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function model() {
    return require('../../../out/projects/catalogV2/merge');
}

function envelopeModel() {
    return require('../../../out/projects/catalogV2/envelope');
}

function commitModel() {
    return require('../../../out/projects/catalogV2/commitProtocol');
}

function makeCatalog() {
    const { createEmptyProjectCatalogV2, applyProjectCatalogV2Patch } = model();
    let document = createEmptyProjectCatalogV2();
    document = applyProjectCatalogV2Patch(document, 'machines', MACHINE_ID, {
        displayName: 'Devbox', color: '#336699', position: 'a', source: 'manual',
    }, ACTOR_A);
    document = applyProjectCatalogV2Patch(document, 'environments', ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'host', displayName: 'Host', position: 'a', launchAnchor: null,
    }, ACTOR_A);
    document = applyProjectCatalogV2Patch(document, 'environments', OTHER_ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'devContainer', displayName: 'Container', position: 'b', launchAnchor: null,
    }, ACTOR_A);
    return applyProjectCatalogV2Patch(document, 'projects', PROJECT_ID, {
        environmentId: ENVIRONMENT_ID,
        name: 'Agent Pivot',
        description: null,
        path: '/work/agent-pivot',
        position: 'a',
        tags: ['active', 'api'],
        favorite: true,
        favoritePosition: 'a',
        color: '#112233',
        remoteType: 'ssh',
        legacyPlacement: null,
    }, ACTOR_A);
}

test('PROJECT-CATALOG-V2-CAUSAL-001 merges concurrent edits to different fields without a conflict', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    const renamed = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Pivot' }, ACTOR_B);
    const recolored = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { color: '#abcdef' }, ACTOR_C);

    const result = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(renamed, recolored));

    assert.equal(result.projects[0].name, 'Pivot');
    assert.equal(result.projects[0].color, '#abcdef');
    assert.deepEqual(result.conflicts, []);
});

test('PROJECT-CATALOG-V2-CAUSAL-001 retains concurrent same-field candidates until a dominating resolution', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    const left = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Left' }, ACTOR_B);
    const right = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Right' }, ACTOR_C);
    const merged = mergeProjectCatalogV2Documents(left, right);

    const conflicted = materializeProjectCatalogV2(merged);
    assert.equal(conflicted.projects[0].name, 'Agent Pivot');
    assert.deepEqual(conflicted.conflicts, [{
        entityKind: 'projects', entityId: PROJECT_ID, field: 'name', kind: 'field',
    }]);
    const resolved = applyProjectCatalogV2Patch(merged, 'projects', PROJECT_ID, { name: 'Chosen' }, ACTOR_D);
    assert.equal(materializeProjectCatalogV2(resolved).projects[0].name, 'Chosen');
    assert.deepEqual(materializeProjectCatalogV2(resolved).conflicts, []);
});

test('PROJECT-CATALOG-V2-CAUSAL-001 does not resurrect a causally stale conflict baseline', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const oldActor = 'f'.repeat(32);
    let old = makeCatalog();
    old = applyProjectCatalogV2Patch(old, 'projects', PROJECT_ID, { name: 'Old' }, oldActor);
    const lastResolved = applyProjectCatalogV2Patch(old, 'projects', PROJECT_ID, { name: 'Last resolved' }, ACTOR_A);
    const left = applyProjectCatalogV2Patch(lastResolved, 'projects', PROJECT_ID, { name: 'Left' }, ACTOR_B);
    const right = applyProjectCatalogV2Patch(lastResolved, 'projects', PROJECT_ID, { name: 'Right' }, ACTOR_C);

    const reconciledWithAncestor = mergeProjectCatalogV2Documents(left, lastResolved);
    const conflicted = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(reconciledWithAncestor, right));

    assert.equal(conflicted.projects[0].name, 'Last resolved');
    assert.equal(conflicted.conflicts.some(conflict => conflict.field === 'name'), true);
});

test('PROJECT-CATALOG-V2-CAUSAL-001 keeps equal-value dots so later descendants merge associatively', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    const left = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Same' }, ACTOR_A);
    const right = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Same' }, ACTOR_B);
    const leftDescendant = applyProjectCatalogV2Patch(left, 'projects', PROJECT_ID, { name: 'From left' }, ACTOR_C);

    const leftAssociated = mergeProjectCatalogV2Documents(
        mergeProjectCatalogV2Documents(left, right),
        leftDescendant,
    );
    const rightAssociated = mergeProjectCatalogV2Documents(
        left,
        mergeProjectCatalogV2Documents(right, leftDescendant),
    );

    assert.deepEqual(
        mergeProjectCatalogV2Documents(left, right),
        mergeProjectCatalogV2Documents(right, left),
    );
    assert.deepEqual(leftAssociated, rightAssociated);
    assert.deepEqual(materializeProjectCatalogV2(leftAssociated), materializeProjectCatalogV2(rightAssociated));
});

test('PROJECT-CATALOG-V2-CAUSAL-001 merges baseline histories associatively', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    const actorX = 'e'.repeat(32);
    const actorY = 'f'.repeat(32);
    const actorZ = 'd'.repeat(32);
    const x1 = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'X1' }, actorX);
    const x = applyProjectCatalogV2Patch(x1, 'projects', PROJECT_ID, { name: 'X2' }, actorX);
    const y1 = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Y1' }, actorY);
    const y = applyProjectCatalogV2Patch(y1, 'projects', PROJECT_ID, { name: 'Y2' }, actorY);
    const z1 = applyProjectCatalogV2Patch(y1, 'projects', PROJECT_ID, { name: 'Z1' }, actorZ);
    const z = applyProjectCatalogV2Patch(z1, 'projects', PROJECT_ID, { name: 'Z2' }, actorZ);

    const leftAssociated = mergeProjectCatalogV2Documents(mergeProjectCatalogV2Documents(x, y), z);
    const rightAssociated = mergeProjectCatalogV2Documents(x, mergeProjectCatalogV2Documents(y, z));

    assert.deepEqual(
        mergeProjectCatalogV2Documents(x, y),
        mergeProjectCatalogV2Documents(y, x),
    );
    assert.deepEqual(leftAssociated, rightAssociated);
    assert.deepEqual(materializeProjectCatalogV2(leftAssociated), materializeProjectCatalogV2(rightAssociated));
});

test('PROJECT-CATALOG-V2-PLACEMENT-001 exposes concurrent placement and delete-update conflicts', () => {
    const {
        applyProjectCatalogV2Patch,
        deleteProjectCatalogV2Entity,
        mergeProjectCatalogV2Documents,
        materializeProjectCatalogV2,
    } = model();
    const base = makeCatalog();
    const moved = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, {
        environmentId: OTHER_ENVIRONMENT_ID,
    }, ACTOR_B);
    const placedElsewhere = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, {
        environmentId: ENVIRONMENT_ID,
    }, ACTOR_C);
    const placement = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(moved, placedElsewhere));
    assert.equal(placement.conflicts.some(conflict => conflict.kind === 'placement'), true);

    const deleted = deleteProjectCatalogV2Entity(base, 'projects', PROJECT_ID, ACTOR_B);
    const updated = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Updated' }, ACTOR_C);
    const concurrent = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(deleted, updated));
    assert.equal(concurrent.projects.length, 1);
    assert.equal(concurrent.conflicts.some(conflict => conflict.kind === 'delete-update'), true);

    const observedDelete = deleteProjectCatalogV2Entity(updated, 'projects', PROJECT_ID, ACTOR_B);
    assert.deepEqual(materializeProjectCatalogV2(observedDelete).projects, []);
});

test('PROJECT-CATALOG-V2-TOMBSTONE-001 rejects an implicit partial recreation after deletion', () => {
    const { applyProjectCatalogV2Patch, deleteProjectCatalogV2Entity } = model();
    const deleted = deleteProjectCatalogV2Entity(makeCatalog(), 'projects', PROJECT_ID, ACTOR_B);

    assert.throws(
        () => applyProjectCatalogV2Patch(deleted, 'projects', PROJECT_ID, { name: 'Stale update' }, ACTOR_C),
        /deleted projects record cannot be patched/,
    );
});

test('PROJECT-CATALOG-V2-SCHEMA-001 rejects partial live records', () => {
    const { parseProjectCatalogV2Document } = model();
    const partial = clone(makeCatalog());
    delete partial.environments[ENVIRONMENT_ID].fields.launchAnchor;

    assert.equal(parseProjectCatalogV2Document(partial), null);
});

test('PROJECT-CATALOG-V2-PROFILE-LEAK-001 rejects connection targets from every catalog entity', () => {
    const { applyProjectCatalogV2Patch, parseProjectCatalogV2Document } = model();
    const base = makeCatalog();
    assert.throws(
        () => applyProjectCatalogV2Patch(base, 'machines', MACHINE_ID, { sshTarget: 'private-alias' }, ACTOR_B),
        /patch field is invalid/,
    );
    const leaked = clone(base);
    leaked.machines[MACHINE_ID].fields.remoteAuthority = leaked.machines[MACHINE_ID].fields.displayName;
    assert.equal(parseProjectCatalogV2Document(leaked), null);
});

test('PROJECT-CATALOG-V2-ENVELOPE-001 validates checksums and falls back to a valid previous revision', () => {
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        readProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch } = model();
    const first = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const secondDocument = applyProjectCatalogV2Patch(first.active.document, 'projects', PROJECT_ID, {
        name: 'Second',
    }, ACTOR_B);
    const second = activateProjectCatalogV2Candidate(stageProjectCatalogV2Candidate(first, secondDocument));
    const corrupted = clone(second);
    corrupted.active.document.projects[PROJECT_ID].fields.name.candidates[0].value = 'Corrupted';

    const recovered = readProjectCatalogV2Envelope(corrupted);

    assert.equal(recovered.source, 'previous');
    assert.equal(recovered.recoveryRequired, true);
    assert.equal(recovered.document.projects[PROJECT_ID].fields.name.candidates[0].value, 'Agent Pivot');
});

test('PROJECT-CATALOG-V2-ENVELOPE-001 keeps a valid active revision when a non-active slot is corrupt', () => {
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        readProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const active = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const corruptCandidate = clone(active.active);
    corruptCandidate.document.projects[PROJECT_ID].fields.name.candidates[0].value = 'Corrupted';

    const recovered = readProjectCatalogV2Envelope({ ...active, candidate: corruptCandidate });

    assert.equal(recovered.source, 'active');
    assert.equal(recovered.recoveryRequired, true);
    assert.equal(recovered.document.projects[PROJECT_ID].fields.name.candidates[0].value, 'Agent Pivot');
});

test('PROJECT-CATALOG-V2-ENVELOPE-001 preserves a valid candidate when active is corrupt', () => {
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        readProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch } = model();
    const active = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const candidateDocument = applyProjectCatalogV2Patch(active.active.document, 'projects', PROJECT_ID, {
        name: 'Recover me',
    }, ACTOR_B);
    const staged = stageProjectCatalogV2Candidate(active, candidateDocument);
    staged.active.document.projects[PROJECT_ID].fields.name.candidates[0].value = 'Corrupt';

    const recovered = readProjectCatalogV2Envelope(staged);

    assert.equal(recovered.recoveryRequired, true);
    assert.equal(recovered.envelope.candidate.document.projects[PROJECT_ID].fields.name.candidates[0].value, 'Recover me');
});

test('PROJECT-CATALOG-V2-ENVELOPE-001 isolates a corrupt previous slot from a valid active revision', () => {
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        readProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const first = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const second = activateProjectCatalogV2Candidate(stageProjectCatalogV2Candidate(first, makeCatalog()));
    second.previous.checksum = '0'.repeat(64);

    const recovered = readProjectCatalogV2Envelope(second);

    assert.equal(recovered.source, 'active');
    assert.equal(recovered.recoveryRequired, true);
    assert.equal(recovered.document.projects[PROJECT_ID].fields.name.candidates[0].value, 'Agent Pivot');
});

test('PROJECT-CATALOG-V2-COMMIT-001 keeps the prior active revision when activation crashes', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        readProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch, materializeProjectCatalogV2 } = model();
    const baseline = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    let backend = clone(baseline);
    let replica = clone(baseline);
    let backendWrites = 0;
    const coordinator = new ProjectCatalogV2CommitCoordinator({
        readBackend: () => clone(backend),
        writeBackend: async value => {
            backendWrites += 1;
            if (backendWrites === 2) throw new Error('activation crash');
            backend = clone(value);
        },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
    });
    const changed = applyProjectCatalogV2Patch(baseline.active.document, 'projects', PROJECT_ID, {
        name: 'Uncommitted',
    }, ACTOR_B);

    await assert.rejects(coordinator.commit(changed), /activation crash/);

    const observed = readProjectCatalogV2Envelope(backend);
    assert.equal(observed.recoveryRequired, true);
    assert.equal(materializeProjectCatalogV2(observed.document).projects[0].name, 'Agent Pivot');
});

test('PROJECT-CATALOG-V2-COMMIT-001 refuses to overwrite an unconfirmed recovery candidate', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch } = model();
    const baseline = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const unconfirmed = applyProjectCatalogV2Patch(baseline.active.document, 'projects', PROJECT_ID, {
        name: 'Unconfirmed',
    }, ACTOR_B);
    let backend = stageProjectCatalogV2Candidate(baseline, unconfirmed);
    let replica = clone(backend);
    const coordinator = new ProjectCatalogV2CommitCoordinator({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
    });
    const next = applyProjectCatalogV2Patch(baseline.active.document, 'projects', PROJECT_ID, {
        color: '#ffffff',
    }, ACTOR_C);

    const recovery = await coordinator.reconcile();
    assert.equal(recovery.recoveryCandidates.length, 1);
    assert.equal(
        recovery.recoveryCandidates[0].document.projects[PROJECT_ID].fields.name.candidates[0].value,
        'Unconfirmed',
    );
    await assert.rejects(coordinator.commit(next), /recovery is required/);
    assert.equal(backend.candidate.document.projects[PROJECT_ID].fields.name.candidates[0].value, 'Unconfirmed');
});

test('PROJECT-CATALOG-V2-COMMIT-001 completes activation when one store already activated the candidate', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch, materializeProjectCatalogV2 } = model();
    const oldEnvelope = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const changed = applyProjectCatalogV2Patch(oldEnvelope.active.document, 'projects', PROJECT_ID, {
        name: 'Activated once',
    }, ACTOR_B);
    const staged = stageProjectCatalogV2Candidate(oldEnvelope, changed);
    let backend = activateProjectCatalogV2Candidate(staged);
    let replica = clone(staged);
    const coordinator = new ProjectCatalogV2CommitCoordinator({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
    });

    const recovered = await coordinator.reconcile();

    assert.equal(recovered.recoveryRequired, false);
    assert.equal(materializeProjectCatalogV2(recovered.document).projects[0].name, 'Activated once');
    assert.equal(backend.activeRevision, replica.activeRevision);
    assert.equal(replica.candidate, null);
});

test('PROJECT-CATALOG-V2-COMMIT-001 explicitly activates, discards, or clears recovery candidates', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch, materializeProjectCatalogV2 } = model();
    const oldEnvelope = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const changed = applyProjectCatalogV2Patch(oldEnvelope.active.document, 'projects', PROJECT_ID, {
        name: 'Pending recovery',
    }, ACTOR_B);
    let backend = stageProjectCatalogV2Candidate(oldEnvelope, changed);
    let replica = clone(backend);
    const dependencies = {
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
    };
    let coordinator = new ProjectCatalogV2CommitCoordinator(dependencies);
    const pending = await coordinator.reconcile();
    const activated = await coordinator.activateRecoveryCandidate(pending.recoveryCandidates[0].revision);
    assert.equal(materializeProjectCatalogV2(activated.document).projects[0].name, 'Pending recovery');

    const discardedDocument = applyProjectCatalogV2Patch(activated.document, 'projects', PROJECT_ID, {
        name: 'Discard me',
    }, ACTOR_C);
    backend = stageProjectCatalogV2Candidate(backend, discardedDocument);
    replica = clone(backend);
    coordinator = new ProjectCatalogV2CommitCoordinator(dependencies);
    const discardPending = await coordinator.reconcile();
    const discarded = await coordinator.discardRecoveryCandidate(discardPending.recoveryCandidates[0].revision);
    assert.equal(materializeProjectCatalogV2(discarded.document).projects[0].name, 'Pending recovery');

    const corruptCandidate = stageProjectCatalogV2Candidate(backend, discardedDocument);
    corruptCandidate.candidate.checksum = '0'.repeat(64);
    backend = corruptCandidate;
    replica = clone(corruptCandidate);
    coordinator = new ProjectCatalogV2CommitCoordinator(dependencies);
    assert.equal((await coordinator.reconcile()).recoveryCandidates.length, 0);
    const cleared = await coordinator.discardRecoveryState();
    assert.equal(cleared.recoveryRequired, false);
    assert.equal(backend.candidate, null);
});

test('PROJECT-CATALOG-V2-CAUSAL-001 does not report a conflict for concurrent equal values', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    const left = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Same' }, ACTOR_B);
    const right = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: 'Same' }, ACTOR_C);

    const result = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(left, right));

    assert.equal(result.projects[0].name, 'Same');
    assert.deepEqual(result.conflicts, []);
});

test('PROJECT-CATALOG-V2-CAUSAL-001 retains more than 32 distinct concurrent values for review', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    let merged = base;
    for (let index = 1; index <= 33; index += 1) {
        const actor = index.toString(16).padStart(32, '0');
        const branch = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { name: `Name ${index}` }, actor);
        merged = mergeProjectCatalogV2Documents(merged, branch);
    }

    const result = materializeProjectCatalogV2(merged);

    assert.equal(result.projects[0].name, 'Agent Pivot');
    assert.equal(result.conflicts.filter(conflict => conflict.field === 'name').length, 1);
});

test('PROJECT-CATALOG-V2-SCHEMA-001 preserves legacy tag counts and lengths above UI edit limits', () => {
    const { applyProjectCatalogV2Patch, materializeProjectCatalogV2 } = model();
    const tags = Array.from({ length: 10_001 }, (_, index) => `tag-${index}`);
    tags.push('x'.repeat(8193));

    const document = applyProjectCatalogV2Patch(makeCatalog(), 'projects', PROJECT_ID, { tags }, ACTOR_B);

    assert.deepEqual(materializeProjectCatalogV2(document).projects[0].tags, tags);
});

test('PROJECT-CATALOG-V2-CAUSAL-001 remains writable after 10,000 prior activation actors', () => {
    const { applyProjectCatalogV2Patch, createEmptyProjectCatalogV2, parseProjectCatalogV2Document } = model();
    const document = createEmptyProjectCatalogV2();
    for (let index = 0; index < 10_000; index += 1) {
        document.versionVector[index.toString(16).padStart(32, '0')] = 1;
    }
    assert.ok(parseProjectCatalogV2Document(document));

    const updated = applyProjectCatalogV2Patch(document, 'machines', MACHINE_ID, {
        displayName: 'Actor 10001', color: null, position: 'a', source: 'manual',
    }, ACTOR_A);

    assert.equal(Object.keys(updated.versionVector).length, 10_001);
    assert.ok(parseProjectCatalogV2Document(updated));
});

test('PROJECT-CATALOG-V2-ORDER-001 converges concurrent position updates without a blocking conflict', () => {
    const { applyProjectCatalogV2Patch, mergeProjectCatalogV2Documents, materializeProjectCatalogV2 } = model();
    const base = makeCatalog();
    const left = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { position: 'left' }, ACTOR_B);
    const right = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, { position: 'right' }, ACTOR_C);

    const leftRight = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(left, right));
    const rightLeft = materializeProjectCatalogV2(mergeProjectCatalogV2Documents(right, left));

    assert.equal(leftRight.projects[0].position, rightLeft.projects[0].position);
    assert.notEqual(leftRight.projects[0].position, 'a');
    assert.deepEqual(leftRight.conflicts, []);
});

test('PROJECT-CATALOG-V2-ORDER-001 materializes records by position instead of UUID order', () => {
    const { applyProjectCatalogV2Patch, materializeProjectCatalogV2 } = model();
    const laterProjectId = '55555555-5555-4555-8555-555555555555';
    const laterMachineId = '66666666-6666-4666-8666-666666666666';
    const laterEnvironmentId = '77777777-7777-4777-8777-777777777777';
    let document = applyProjectCatalogV2Patch(makeCatalog(), 'machines', MACHINE_ID, { position: 'z' }, ACTOR_B);
    document = applyProjectCatalogV2Patch(document, 'environments', ENVIRONMENT_ID, { position: 'z' }, ACTOR_B);
    document = applyProjectCatalogV2Patch(document, 'projects', PROJECT_ID, { position: 'z' }, ACTOR_B);
    document = applyProjectCatalogV2Patch(document, 'machines', laterMachineId, {
        displayName: 'First machine', color: null, position: 'a', source: 'manual',
    }, ACTOR_C);
    document = applyProjectCatalogV2Patch(document, 'environments', laterEnvironmentId, {
        machineId: laterMachineId, kind: 'host', displayName: 'Host', position: 'a', launchAnchor: null,
    }, ACTOR_C);
    document = applyProjectCatalogV2Patch(document, 'projects', laterProjectId, {
        environmentId: ENVIRONMENT_ID,
        name: 'First by position',
        description: null,
        path: '/work/first',
        position: 'a',
        tags: [],
        favorite: false,
        favoritePosition: null,
        color: null,
        remoteType: null,
        legacyPlacement: null,
    }, ACTOR_C);

    const materialized = materializeProjectCatalogV2(document);
    assert.deepEqual(materialized.machines.map(machine => machine.id), [laterMachineId, MACHINE_ID]);
    assert.deepEqual(materialized.environments.map(environment => environment.id), [laterEnvironmentId, OTHER_ENVIRONMENT_ID, ENVIRONMENT_ID]);
    assert.deepEqual(materialized.projects.map(project => project.id), [laterProjectId, PROJECT_ID]);
});

test('PROJECT-CATALOG-V2-REPLICA-001 reconciles an out-of-order backend with the newer local replica', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const { applyProjectCatalogV2Patch, materializeProjectCatalogV2 } = model();
    const oldEnvelope = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    const newerDocument = applyProjectCatalogV2Patch(oldEnvelope.active.document, 'projects', PROJECT_ID, {
        name: 'Replica wins causally',
    }, ACTOR_B);
    const newEnvelope = activateProjectCatalogV2Candidate(stageProjectCatalogV2Candidate(oldEnvelope, newerDocument));
    let backend = clone(oldEnvelope);
    let replica = clone(newEnvelope);
    const coordinator = new ProjectCatalogV2CommitCoordinator({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
    });

    const reconciled = await coordinator.reconcile();

    assert.equal(materializeProjectCatalogV2(reconciled.document).projects[0].name, 'Replica wins causally');
    assert.equal(backend.activeRevision, replica.activeRevision);
});

test('PROJECT-CATALOG-V2-REPLICA-001 repairs a missing backend from the validated replica', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const replicaEnvelope = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), makeCatalog()),
    );
    let backend = null;
    let replica = clone(replicaEnvelope);
    const coordinator = new ProjectCatalogV2CommitCoordinator({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
    });

    const reconciled = await coordinator.reconcile();

    assert.equal(reconciled.recoveryRequired, false);
    assert.equal(backend.activeRevision, replica.activeRevision);
    assert.deepEqual(backend, replica);
});

test('PROJECT-CATALOG-V2-STRUCTURE-001 validates the final merged document before activation', async () => {
    const { ProjectCatalogV2CommitCoordinator } = commitModel();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const {
        applyProjectCatalogV2Patch,
        createEmptyProjectCatalogV2,
        deleteProjectCatalogV2Entity,
        materializeProjectCatalogV2,
    } = model();
    let base = applyProjectCatalogV2Patch(createEmptyProjectCatalogV2(), 'machines', MACHINE_ID, {
        displayName: 'Devbox', color: null, position: 'a', source: 'manual',
    }, ACTOR_A);
    base = applyProjectCatalogV2Patch(base, 'environments', ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'host', displayName: 'Host', position: 'a', launchAnchor: null,
    }, ACTOR_A);
    const oldEnvelope = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), base),
    );
    let deletion = deleteProjectCatalogV2Entity(base, 'environments', ENVIRONMENT_ID, ACTOR_B);
    deletion = deleteProjectCatalogV2Entity(deletion, 'machines', MACHINE_ID, ACTOR_B);
    const concurrentChild = applyProjectCatalogV2Patch(base, 'environments', OTHER_ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'devContainer', displayName: 'Container', position: 'b', launchAnchor: null,
    }, ACTOR_C);
    let backend = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(oldEnvelope, concurrentChild),
    );
    let replica = clone(oldEnvelope);
    const activeBefore = backend.activeRevision;
    const coordinator = new ProjectCatalogV2CommitCoordinator({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        validateDocument: document => {
            const invalid = materializeProjectCatalogV2(document).conflicts.some(conflict =>
                conflict.kind === 'missing-parent' || conflict.kind === 'missing-host' || conflict.kind === 'duplicate-host');
            if (invalid) throw new Error('invalid catalog structure');
        },
    });

    await assert.rejects(coordinator.commit(deletion), /invalid catalog structure/);
    assert.equal(backend.activeRevision, activeBefore);
});

test('PROJECT-CATALOG-V2-SERVICE-001 serializes one workspace writer and persists its actor separately', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    let backend = null;
    let replica = null;
    let actorId = null;
    let actorWrites = 0;
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        recordCatalogActorId: async value => { actorWrites += 1; actorId = value; },
        createUniqueCatalogActorId: () => ACTOR_A,
    });
    await service.patch('machines', MACHINE_ID, {
        displayName: 'Devbox', color: null, position: 'a', source: 'manual',
    });
    await Promise.all([
        service.patch('machines', MACHINE_ID, { displayName: 'Renamed' }),
        service.patch('machines', MACHINE_ID, { color: '#abcdef' }),
    ]);

    const catalog = await service.getCatalog();
    assert.deepEqual(catalog.machines, [{
        id: MACHINE_ID,
        color: '#abcdef',
        displayName: 'Renamed',
        position: 'a',
        source: 'manual',
    }]);
    assert.deepEqual(catalog.conflicts, []);
    assert.equal(catalog.environments.length, 1);
    assert.equal(catalog.environments[0].kind, 'host');
    assert.equal(actorWrites, 1);
    assert.equal(actorId, ACTOR_A);
    assert.equal(backend.activeRevision, replica.activeRevision);
});

test('PROJECT-CATALOG-V2-SERVICE-001 rejects duplicate Host and non-empty parent deletion before persistence', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    let backend = null;
    let replica = null;
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        createUniqueCatalogActorId: () => ACTOR_A,
    });
    await service.patch('machines', MACHINE_ID, {
        displayName: 'Devbox', color: null, position: 'a', source: 'manual',
    });
    const host = (await service.getCatalog()).environments[0];
    await service.patch('projects', PROJECT_ID, {
        environmentId: host.id,
        name: 'Project',
        description: null,
        path: '/work/project',
        position: 'a',
        tags: [],
        favorite: false,
        favoritePosition: null,
        color: null,
        remoteType: null,
        legacyPlacement: null,
    });
    const activeBefore = backend.activeRevision;

    await assert.rejects(service.patch('environments', OTHER_ENVIRONMENT_ID, {
        machineId: MACHINE_ID,
        kind: 'host',
        displayName: 'Second Host',
        position: 'b',
        launchAnchor: null,
    }), /multiple Host environments/);
    await assert.rejects(service.delete('machines', MACHINE_ID), /still contains a Project/);
    assert.equal(backend.activeRevision, activeBefore);
});

test('PROJECT-CATALOG-V2-SERVICE-001 removes an empty Machine and its fixed Host atomically', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    let backend = null;
    let replica = null;
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        createUniqueCatalogActorId: () => ACTOR_A,
    });
    await service.patch('machines', MACHINE_ID, {
        displayName: 'Devbox', color: null, position: 'a', source: 'manual',
    });
    assert.equal((await service.getCatalog()).environments[0].kind, 'host');

    await service.delete('machines', MACHINE_ID);

    const catalog = await service.getCatalog();
    assert.deepEqual(catalog.machines, []);
    assert.deepEqual(catalog.environments, []);
    assert.deepEqual(catalog.conflicts, []);
});

test('PROJECT-CATALOG-V2-SERVICE-001 blocks deletion of every hidden placement candidate parent', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    const {
        applyProjectCatalogV2Patch,
        mergeProjectCatalogV2Documents,
    } = model();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    const secondMachineId = '66666666-6666-4666-8666-666666666666';
    const secondHostId = '77777777-7777-4777-8777-777777777777';
    let base = makeCatalog();
    base = applyProjectCatalogV2Patch(base, 'machines', secondMachineId, {
        displayName: 'Second', color: null, position: 'b', source: 'manual',
    }, ACTOR_A);
    base = applyProjectCatalogV2Patch(base, 'environments', secondHostId, {
        machineId: secondMachineId, kind: 'host', displayName: 'Host', position: 'a', launchAnchor: null,
    }, ACTOR_A);
    const projectMoved = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, {
        environmentId: OTHER_ENVIRONMENT_ID,
    }, ACTOR_B);
    const projectStayed = applyProjectCatalogV2Patch(base, 'projects', PROJECT_ID, {
        environmentId: ENVIRONMENT_ID,
    }, ACTOR_C);
    const environmentMoved = applyProjectCatalogV2Patch(base, 'environments', OTHER_ENVIRONMENT_ID, {
        machineId: secondMachineId,
    }, ACTOR_B);
    const environmentStayed = applyProjectCatalogV2Patch(base, 'environments', OTHER_ENVIRONMENT_ID, {
        machineId: MACHINE_ID,
    }, ACTOR_C);

    const envelopeFor = document => activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), document),
    );
    let backend = envelopeFor(mergeProjectCatalogV2Documents(projectMoved, projectStayed));
    let replica = clone(backend);
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        createUniqueCatalogActorId: () => ACTOR_D,
    });

    await assert.rejects(service.delete('environments', OTHER_ENVIRONMENT_ID), /still contains a Project/);

    backend = envelopeFor(mergeProjectCatalogV2Documents(environmentMoved, environmentStayed));
    replica = clone(backend);
    await assert.rejects(service.delete('machines', secondMachineId), /unresolved Environment placement/);
});

test('PROJECT-CATALOG-V2-SERVICE-001 keeps structural merge conflicts reviewable and repairs a missing fixed Host', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    const {
        applyProjectCatalogV2Patch,
        deleteProjectCatalogV2Entity,
        mergeProjectCatalogV2Documents,
    } = model();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    let base = makeCatalog();
    base = deleteProjectCatalogV2Entity(base, 'projects', PROJECT_ID, ACTOR_A);
    base = deleteProjectCatalogV2Entity(base, 'environments', OTHER_ENVIRONMENT_ID, ACTOR_A);
    const deletedHost = deleteProjectCatalogV2Entity(base, 'environments', ENVIRONMENT_ID, ACTOR_B);
    const deletedMachine = deleteProjectCatalogV2Entity(deletedHost, 'machines', MACHINE_ID, ACTOR_B);
    const concurrentUpdate = applyProjectCatalogV2Patch(base, 'machines', MACHINE_ID, {
        displayName: 'Updated elsewhere',
    }, ACTOR_C);
    const merged = mergeProjectCatalogV2Documents(deletedMachine, concurrentUpdate);
    let backend = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), merged),
    );
    let replica = clone(backend);
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        createUniqueCatalogActorId: () => ACTOR_D,
    });

    const reviewable = await service.getCatalog();
    assert.equal(reviewable.conflicts.some(conflict => conflict.kind === 'missing-host'), true);
    assert.equal(reviewable.conflicts.some(conflict => conflict.kind === 'delete-update'), true);

    await service.patch('machines', MACHINE_ID, { displayName: 'Keep Machine' });

    const repaired = await service.getCatalog();
    assert.equal(repaired.environments.filter(environment =>
        environment.machineId === MACHINE_ID && environment.kind === 'host').length, 1);
    assert.equal(repaired.conflicts.some(conflict => conflict.kind === 'missing-host'), false);
    assert.equal(repaired.conflicts.some(conflict => conflict.kind === 'delete-update'), false);
});

test('PROJECT-CATALOG-V2-SERVICE-001 requires explicit removal of an empty non-Host Environment', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    let backend = null;
    let replica = null;
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        createUniqueCatalogActorId: () => ACTOR_A,
    });
    await service.patch('machines', MACHINE_ID, {
        displayName: 'Devbox', color: null, position: 'a', source: 'manual',
    });
    await service.patch('environments', OTHER_ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'devContainer', displayName: 'Container', position: 'b', launchAnchor: null,
    });

    await assert.rejects(service.delete('machines', MACHINE_ID), /still contains a non-Host Environment/);
    await service.delete('environments', OTHER_ENVIRONMENT_ID);
    await service.delete('machines', MACHINE_ID);

    assert.deepEqual((await service.getCatalog()).machines, []);
});

test('PROJECT-CATALOG-V2-SERVICE-001 preserves a hidden Dev Container kind candidate when deleting a Machine', async () => {
    const { ProjectCatalogV2Service } = require('../../../out/services/projectCatalogV2Service');
    const {
        applyProjectCatalogV2Patch,
        createEmptyProjectCatalogV2,
        mergeProjectCatalogV2Documents,
    } = model();
    const {
        activateProjectCatalogV2Candidate,
        createEmptyProjectCatalogV2Envelope,
        stageProjectCatalogV2Candidate,
    } = envelopeModel();
    let base = applyProjectCatalogV2Patch(createEmptyProjectCatalogV2(), 'machines', MACHINE_ID, {
        displayName: 'Devbox', color: null, position: 'a', source: 'manual',
    }, ACTOR_A);
    base = applyProjectCatalogV2Patch(base, 'environments', ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'host', displayName: 'Host', position: 'a', launchAnchor: null,
    }, ACTOR_A);
    const devContainer = applyProjectCatalogV2Patch(base, 'environments', ENVIRONMENT_ID, {
        kind: 'devContainer',
    }, ACTOR_B);
    const host = applyProjectCatalogV2Patch(base, 'environments', ENVIRONMENT_ID, {
        kind: 'host',
    }, ACTOR_C);
    const merged = mergeProjectCatalogV2Documents(devContainer, host);
    const active = activateProjectCatalogV2Candidate(
        stageProjectCatalogV2Candidate(createEmptyProjectCatalogV2Envelope(), merged),
    );
    let backend = clone(active);
    let replica = clone(active);
    const service = new ProjectCatalogV2Service({
        readBackend: () => clone(backend),
        writeBackend: async value => { backend = clone(value); },
        readReplica: () => clone(replica),
        writeReplica: async value => { replica = clone(value); },
        createUniqueCatalogActorId: () => ACTOR_D,
    });
    const before = await service.getCatalog();
    assert.equal(before.environments[0].kind, 'host');
    assert.equal(before.conflicts.some(conflict =>
        conflict.entityId === ENVIRONMENT_ID && conflict.field === 'kind'), true);

    await assert.rejects(service.delete('machines', MACHINE_ID), /non-Host Environment or unresolved Environment kind/);

    const after = await service.getCatalog();
    assert.equal(after.machines.length, 1);
    assert.equal(after.environments.length, 1);
    assert.equal(after.conflicts.some(conflict =>
        conflict.entityId === ENVIRONMENT_ID && conflict.field === 'kind'), true);
});
