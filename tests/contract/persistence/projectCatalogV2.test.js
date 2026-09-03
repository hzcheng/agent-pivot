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
        name: 'Devbox', color: '#336699', order: 0,
    }, ACTOR_A);
    document = applyProjectCatalogV2Patch(document, 'environments', ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'host', name: 'Host', order: 0, launchAnchor: null,
    }, ACTOR_A);
    document = applyProjectCatalogV2Patch(document, 'environments', OTHER_ENVIRONMENT_ID, {
        machineId: MACHINE_ID, kind: 'host', name: 'Other Host', order: 1, launchAnchor: null,
    }, ACTOR_A);
    return applyProjectCatalogV2Patch(document, 'projects', PROJECT_ID, {
        environmentId: ENVIRONMENT_ID,
        name: 'Agent Pivot',
        description: null,
        normalizedPath: '/work/agent-pivot',
        tags: ['active', 'api'],
        favorite: true,
        favoriteOrder: 0,
        color: '#112233',
        order: 0,
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

    assert.deepEqual(materializeProjectCatalogV2(merged).conflicts, [{
        entityKind: 'projects', entityId: PROJECT_ID, field: 'name', kind: 'field',
    }]);
    const resolved = applyProjectCatalogV2Patch(merged, 'projects', PROJECT_ID, { name: 'Chosen' }, ACTOR_D);
    assert.equal(materializeProjectCatalogV2(resolved).projects[0].name, 'Chosen');
    assert.deepEqual(materializeProjectCatalogV2(resolved).conflicts, []);
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

test('PROJECT-CATALOG-V2-PROFILE-LEAK-001 rejects connection targets from every catalog entity', () => {
    const { applyProjectCatalogV2Patch, parseProjectCatalogV2Document } = model();
    const base = makeCatalog();
    assert.throws(
        () => applyProjectCatalogV2Patch(base, 'machines', MACHINE_ID, { sshTarget: 'private-alias' }, ACTOR_B),
        /patch field is invalid/,
    );
    const leaked = clone(base);
    leaked.machines[MACHINE_ID].fields.remoteAuthority = leaked.machines[MACHINE_ID].fields.name;
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
        getCatalogActorId: () => actorId,
        updateCatalogActorId: async value => { actorWrites += 1; actorId = value; },
        createCatalogActorId: () => ACTOR_A,
    });
    await service.patch('machines', MACHINE_ID, {
        name: 'Devbox', color: null, order: 0,
    });
    await Promise.all([
        service.patch('machines', MACHINE_ID, { name: 'Renamed' }),
        service.patch('machines', MACHINE_ID, { color: '#abcdef' }),
    ]);

    const catalog = await service.getCatalog();
    assert.deepEqual(catalog.machines, [{
        id: MACHINE_ID,
        color: '#abcdef',
        name: 'Renamed',
        order: 0,
    }]);
    assert.deepEqual(catalog.conflicts, []);
    assert.equal(actorWrites, 1);
    assert.equal(actorId, ACTOR_A);
    assert.equal(backend.activeRevision, replica.activeRevision);
});
