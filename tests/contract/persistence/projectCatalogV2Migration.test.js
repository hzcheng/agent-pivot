'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function migration() {
    return require('../../../out/projects/catalogV2/migration');
}

function materialize(document) {
    return require('../../../out/projects/catalogV2/merge').materializeProjectCatalogV2(document);
}

function groups() {
    return [{
        id: 'legacy-group',
        groupName: 'Backend Team',
        collapsed: false,
        projects: [{
            id: 'host-project',
            name: 'API',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/api',
            tags: Array.from({ length: 12 }, (_, index) => `tag-${index}`),
            favorite: true,
            favoriteOrder: 2,
            color: '#123456',
        }, {
            id: 'container-project',
            name: 'Worker',
            path: 'vscode-remote://dev-container%2Bworkspace%40ssh-remote%2Bdevbox/work/worker',
            tags: ['x'.repeat(80)],
            color: '#654321',
        }, {
            id: 'local-project',
            name: 'Local Copy',
            path: '/work/local-copy',
            tags: [],
            color: '#abcdef',
        }],
    }];
}

test('PROJECT-CATALOG-V2-REMOTE-PARSER-001 extracts a nested SSH Dev Container without persisting its SSH alias', () => {
    const { parseLegacyRemoteMigrationTarget } = migration();
    assert.deepEqual(
        parseLegacyRemoteMigrationTarget('vscode-remote://dev-container%2Bworkspace%40ssh-remote%2Bdevbox/work/app'),
        {
            machineFingerprint: 'ssh:devbox',
            environmentFingerprint: 'ssh:devbox:dev-container:workspace',
            environmentKind: 'devContainer',
            normalizedPath: '/work/app',
            localConnection: { kind: 'ssh', target: 'devbox' },
            launchAnchor: 'workspace',
            needsAssignment: false,
            needsSetup: false,
        },
    );
    const attached = parseLegacyRemoteMigrationTarget(
        'vscode-remote://attached-container%2Bruntime-container-id/work/app',
    );
    assert.equal(attached.environmentKind, 'legacyRemote');
    assert.equal(attached.launchAnchor, null);
    assert.equal(attached.needsSetup, true);
});

test('PROJECT-CATALOG-V2-DETERMINISTIC-MIGRATION-001 produces byte-identical shadow documents on two clients', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const first = migrateProjectCatalogV1ToV2(groups());
    const second = migrateProjectCatalogV1ToV2(JSON.parse(JSON.stringify(groups())));

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(first.document).includes('devbox'), false,
        'the synced V2 document must not contain a client-local SSH target');
    assert.equal(first.report.localBindings[0].target, 'devbox');
    assert.deepEqual(first.report, second.report);
});

test('PROJECT-CATALOG-V2-GROUP-TAG-MIGRATION-001 preserves over-limit tags and marks local projects unassigned', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const result = migrateProjectCatalogV1ToV2(groups());
    const catalog = materialize(result.document);
    const api = catalog.projects.find(project => project.name === 'API');
    const worker = catalog.projects.find(project => project.name === 'Worker');

    assert.equal(api.tags.length, 13);
    assert.equal(api.tags.at(-1), 'Backend Team');
    assert.equal(worker.tags[0].length, 80);
    assert.equal(result.report.projectCount, 3);
    assert.equal(result.report.needsAssignmentProjectIds.length, 1);
    assert.equal(catalog.machines.some(machine => machine.name === 'Needs Assignment'), true);
    assert.deepEqual(catalog.conflicts, []);
});

test('PROJECT-CATALOG-V2-DETERMINISTIC-MIGRATION-001 changes the migration actor when V1 inputs diverge', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const first = migrateProjectCatalogV1ToV2(groups());
    const changed = groups();
    changed[0].projects[0].name = 'API changed offline';
    const second = migrateProjectCatalogV1ToV2(changed);

    assert.notEqual(first.report.sourceFingerprint, second.report.sourceFingerprint);
});
