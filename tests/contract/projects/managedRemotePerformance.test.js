'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
    createCausalVersion,
    createVersionedCandidates,
    joinVersionVectors,
    vectorIncludingVersion,
} = require('../../../out/projects/managedRemote/causal');
const {
    createEmptyManagedCatalogEnvelope,
    createManagedRevisionSlot,
    normalizeManagedCatalogEnvelope,
} = require('../../../out/projects/managedRemote/envelope');
const {
    joinManagedRemoteCatalogs,
    materializeManagedRemoteCatalog,
} = require('../../../out/projects/managedRemote/merge');
const {
    MANAGED_REMOTE_PAYLOAD_CEILING_BYTES,
    serializedManagedEnvelopeBytes,
} = require('../../../out/projects/managedRemote/payload');

const { largeCatalog } = require('../../fixtures/managedRemoteCatalog');

test('MANAGED-REMOTE-PERFORMANCE-001 keeps the 50 Machine / 500 Project recovery envelope bounded', () => {
    const left = largeCatalog('left', ' A');
    const right = largeCatalog('right', ' B');
    const joined = joinManagedRemoteCatalogs(left, right);
    const materialized = materializeManagedRemoteCatalog(joined);

    const envelope = createEmptyManagedCatalogEnvelope('envelope');
    const version = createCausalVersion(envelope.causalContext, 'envelope');
    envelope.authority = createVersionedCandidates({
        lifecycle: 'active',
        active: createManagedRevisionSlot(joined),
        previous: createManagedRevisionSlot(left),
    }, version);
    envelope.causalContext = joinVersionVectors(
        envelope.causalContext, vectorIncludingVersion(version),
    );
    const normalized = normalizeManagedCatalogEnvelope(envelope);

    assert.equal(materialized.projects.length, 500);
    assert.ok(
        serializedManagedEnvelopeBytes(normalized) <= MANAGED_REMOTE_PAYLOAD_CEILING_BYTES,
        `${serializedManagedEnvelopeBytes(normalized)} exceeds product payload ceiling`,
    );
});
