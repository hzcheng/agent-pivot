'use strict';

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const test = require('node:test');

const {
    createCausalVersion,
    createVersionedCandidates,
    joinVersionVectors,
    vectorIncludingVersion,
} = require('../../../out/projects/managedRemote/causal');
const {
    createChecksummedLegacySnapshot,
    createEmptyManagedCatalogEnvelope,
    createManagedRevisionSlot,
    normalizeManagedCatalogEnvelope,
} = require('../../../out/projects/managedRemote/envelope');
const {
    applyManagedCatalogTransaction,
    createEmptyManagedRemoteCatalog,
    hostEnvironmentId,
    joinManagedRemoteCatalogs,
    materializeManagedRemoteCatalog,
} = require('../../../out/projects/managedRemote/merge');
const {
    MANAGED_REMOTE_PAYLOAD_CEILING_BYTES,
    serializedManagedEnvelopeBytes,
} = require('../../../out/projects/managedRemote/payload');

function largeCatalog(actorId, suffix) {
    const machines = {};
    const environments = {};
    const projects = {};
    const layout = {
        machineIds: [],
        environmentIdsByMachine: {},
        projectIdsByEnvironment: {},
        favoriteProjectIds: [],
    };
    for (let machineIndex = 0; machineIndex < 50; machineIndex += 1) {
        const machineId = `machine:${machineIndex}`;
        const environmentId = hostEnvironmentId(machineId);
        machines[machineId] = {
            id: machineId,
            name: `Machine ${machineIndex}${suffix}`,
            connection: {
                kind: 'ssh',
                host: `machine-${machineIndex}.example.com`,
                user: 'developer',
                port: machineIndex % 2 ? 22 : 22022,
            },
        };
        environments[environmentId] = {
            id: environmentId, machineId, kind: 'host', name: 'Host',
        };
        layout.machineIds.push(machineId);
        layout.environmentIdsByMachine[machineId] = [environmentId];
        layout.projectIdsByEnvironment[environmentId] = [];
        for (let projectIndex = 0; projectIndex < 10; projectIndex += 1) {
            const ordinal = machineIndex * 10 + projectIndex;
            const projectId = `project:${machineIndex}:${projectIndex}`;
            projects[projectId] = {
                id: projectId,
                environmentId,
                name: `Project ${machineIndex}-${projectIndex}`,
                description: `Description ${suffix}`,
                remotePath: `/work/${machineIndex}/${projectIndex}`,
                tags: [`tag-${ordinal % 100}`, `tag-${(ordinal + 1) % 100}`],
                favorite: projectIndex === 0,
            };
            layout.projectIdsByEnvironment[environmentId].push(projectId);
            if (projectIndex === 0) { layout.favoriteProjectIds.push(projectId); }
        }
    }
    return applyManagedCatalogTransaction(createEmptyManagedRemoteCatalog('seed'), actorId, {
        machines, environments, projects, layout,
    });
}

test('MANAGED-REMOTE-PERFORMANCE-001 keeps the 50 Machine / 500 Project recovery envelope bounded', () => {
    const left = largeCatalog('left', ' A');
    const right = largeCatalog('right', ' B');
    const started = performance.now();
    const joined = joinManagedRemoteCatalogs(left, right);
    const materialized = materializeManagedRemoteCatalog(joined);
    const elapsed = performance.now() - started;

    const envelope = createEmptyManagedCatalogEnvelope('envelope');
    const version = createCausalVersion(envelope.causalContext, 'envelope');
    const legacy = createChecksummedLegacySnapshot(
        Object.values(left.projects).map(register => register.candidates[0].value),
        { schemaVersion: 1 },
    );
    envelope.authority = createVersionedCandidates({
        lifecycle: 'active',
        active: createManagedRevisionSlot(joined),
        previous: createManagedRevisionSlot(left),
    }, version);
    envelope.rollbackPlans['rollback:fixture'] = createVersionedCandidates({
        planId: 'rollback:fixture', phase: 'prepared', target: legacy,
    }, version);
    envelope.causalContext = joinVersionVectors(
        envelope.causalContext, vectorIncludingVersion(version),
    );
    const normalized = normalizeManagedCatalogEnvelope(envelope);

    assert.equal(materialized.projects.length, 500);
    assert.ok(elapsed < 200, `merge + materialize took ${elapsed.toFixed(1)}ms`);
    assert.ok(
        serializedManagedEnvelopeBytes(normalized) <= MANAGED_REMOTE_PAYLOAD_CEILING_BYTES,
        `${serializedManagedEnvelopeBytes(normalized)} exceeds product payload ceiling`,
    );
});
