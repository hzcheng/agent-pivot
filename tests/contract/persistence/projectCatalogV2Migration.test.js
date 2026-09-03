'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function migration() {
    return require('../../../out/projects/catalogV2/migration');
}

function materialize(document) {
    return require('../../../out/projects/catalogV2/merge').materializeProjectCatalogV2(document);
}

function nestedDevContainerAuthority(target = 'devbox') {
    const anchor = Buffer.from(JSON.stringify({
        hostPath: '/home/dev/workspace',
        localDocker: false,
        configFile: { path: '/home/dev/workspace/.devcontainer/devcontainer.json' },
    }), 'utf8').toString('hex');
    return `vscode-remote://dev-container%2B${anchor}%40ssh-remote%2B${target}/work/worker`;
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
            path: nestedDevContainerAuthority(),
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
        parseLegacyRemoteMigrationTarget(nestedDevContainerAuthority(), 'container-project'),
        {
            machineFingerprint: 'ssh:devbox',
            environmentFingerprint: 'ssh:devbox:dev-container:' + JSON.stringify({
                hostPath: '/home/dev/workspace',
                configPath: '/home/dev/workspace/.devcontainer/devcontainer.json',
                sourceProjectId: null,
            }),
            environmentKind: 'devContainer',
            normalizedPath: '/work/worker',
            localConnection: {
                kind: 'ssh', target: 'devbox', resolverAuthority: 'ssh-remote+devbox',
            },
            launchAnchor: {
                hostPath: '/home/dev/workspace',
                configPath: '/home/dev/workspace/.devcontainer/devcontainer.json',
                sourceProjectId: null,
            },
            needsAssignment: false,
            needsSetup: false,
        },
    );
    const attached = parseLegacyRemoteMigrationTarget(
        'vscode-remote://attached-container%2Bruntime-container-id/work/app',
        'attached-project',
    );
    assert.equal(attached.environmentKind, 'legacyRemote');
    assert.equal(attached.launchAnchor, null);
    assert.equal(attached.needsSetup, true);
    assert.equal(JSON.stringify(attached).includes('runtime-container-id'), false);

    const opaque = parseLegacyRemoteMigrationTarget(
        'vscode-remote://dev-container%2Bruntime123%40ssh-remote%2Bdevbox/work/app',
        'opaque-project',
    );
    assert.equal(opaque.environmentKind, 'legacyRemote');
    assert.equal(opaque.launchAnchor, null);
    assert.equal(opaque.needsSetup, true);
    const sameOpaqueProjectAfterRuntimeChange = parseLegacyRemoteMigrationTarget(
        'vscode-remote://dev-container%2Bruntime456%40ssh-remote%2Bdevbox/work/app',
        'opaque-project',
    );
    const differentOpaqueProject = parseLegacyRemoteMigrationTarget(
        'vscode-remote://dev-container%2Bruntime123%40ssh-remote%2Bdevbox/work/other',
        'other-opaque-project',
    );
    assert.equal(sameOpaqueProjectAfterRuntimeChange.environmentFingerprint, opaque.environmentFingerprint);
    assert.notEqual(differentOpaqueProject.environmentFingerprint, opaque.environmentFingerprint);
    assert.equal(opaque.environmentFingerprint.includes('runtime123'), false);
    assert.equal(sameOpaqueProjectAfterRuntimeChange.environmentFingerprint.includes('runtime456'), false);

    const attachedAfterRuntimeChange = parseLegacyRemoteMigrationTarget(
        'vscode-remote://attached-container%2Banother-runtime-id/work/app',
        'attached-project',
    );
    const otherAttachedProject = parseLegacyRemoteMigrationTarget(
        'vscode-remote://attached-container%2Bruntime-container-id/work/other',
        'other-attached-project',
    );
    assert.equal(attachedAfterRuntimeChange.environmentFingerprint, attached.environmentFingerprint);
    assert.notEqual(otherAttachedProject.environmentFingerprint, attached.environmentFingerprint);

    const wsl = parseLegacyRemoteMigrationTarget(
        'vscode-remote://wsl%2BUbuntu/home/dev/app',
        'wsl-project',
    );
    assert.equal(wsl.machineFingerprint, 'wsl:Ubuntu');
    assert.deepEqual(wsl.localConnection, {
        kind: 'wsl', target: 'Ubuntu', resolverAuthority: 'wsl+Ubuntu',
    });
    assert.equal(wsl.needsSetup, false);
});

test('PROJECT-CATALOG-V2-DETERMINISTIC-MIGRATION-001 produces byte-identical shadow documents on two clients', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const first = migrateProjectCatalogV1ToV2(groups());
    const second = migrateProjectCatalogV1ToV2(JSON.parse(JSON.stringify(groups())));

    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(JSON.stringify(first.document).includes('devbox'), false,
        'the synced V2 document must not contain a client-local SSH target');
    assert.equal(JSON.stringify(first.report).includes('devbox'), false,
        'the persistable migration report must not contain a client-local SSH target');
    assert.equal(first.localBindingProposals[0].target, 'devbox');
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
    assert.equal(catalog.machines.some(machine => machine.displayName === 'Needs Assignment'), true);
    assert.deepEqual(catalog.conflicts, []);
});

test('PROJECT-CATALOG-V2-GROUP-TAG-MIGRATION-001 never silently truncates legacy tags', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const input = groups();
    input[0].groupName = 'g'.repeat(300);
    input[0].projects[0].tags = Array.from({ length: 300 }, (_, index) => `legacy-${index}`);

    const result = migrateProjectCatalogV1ToV2(input);
    const api = materialize(result.document).projects.find(project => project.name === 'API');

    assert.equal(api.tags.length, 301);
    assert.equal(api.tags.at(-1), 'g'.repeat(300));
});

test('PROJECT-CATALOG-V2-GROUP-TAG-MIGRATION-001 counts only newly added Group tags and preserves flattened order', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const input = groups();
    input[0].projects[0].tags.push('backend team');
    input.push({
        id: 'second-group',
        groupName: 'Other',
        collapsed: false,
        projects: [{
            id: 'later-project',
            name: 'Later',
            path: 'vscode-remote://ssh-remote%2Bdevbox/work/later',
            tags: [],
        }],
    });

    const result = migrateProjectCatalogV1ToV2(input);
    const catalog = materialize(result.document);

    assert.equal(result.report.uniqueGroupTagCount, 2);
    assert.equal(result.report.groupTagAssociationsAdded, 3);
    assert.deepEqual(
        catalog.projects.slice().sort((left, right) => left.position.localeCompare(right.position)).map(project => project.name),
        ['API', 'Worker', 'Local Copy', 'Later'],
    );
    assert.equal(new Set(catalog.projects.map(project => project.position)).size, 4);
});

test('PROJECT-CATALOG-V2-ORDER-001 places Host before Dev Container regardless of V1 encounter order', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const input = groups();
    input[0].projects = [input[0].projects[1], input[0].projects[0]];

    const catalog = materialize(migrateProjectCatalogV1ToV2(input).document);
    const devContainer = catalog.environments.find(environment => environment.kind === 'devContainer');
    const environments = catalog.environments
        .filter(environment => environment.machineId === devContainer.machineId)
        .slice()
        .sort((left, right) => left.position.localeCompare(right.position));

    assert.deepEqual(environments.slice(0, 2).map(environment => environment.kind), ['host', 'devContainer']);
});

test('PROJECT-CATALOG-V2-ORDER-001 synthesizes exactly one Host for a container-only Machine', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const input = groups();
    input[0].projects = [input[0].projects[1]];

    const catalog = materialize(migrateProjectCatalogV1ToV2(input).document);
    const machine = catalog.machines[0];
    const environments = catalog.environments
        .filter(environment => environment.machineId === machine.id)
        .slice()
        .sort((left, right) => left.position.localeCompare(right.position));

    assert.deepEqual(environments.map(environment => environment.kind), ['host', 'devContainer']);
    assert.equal(environments.filter(environment => environment.kind === 'host').length, 1);
});

test('PROJECT-CATALOG-V2-DETERMINISTIC-MIGRATION-001 changes the migration actor when V1 inputs diverge', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const first = migrateProjectCatalogV1ToV2(groups());
    const changed = groups();
    changed[0].projects[0].name = 'API changed offline';
    const second = migrateProjectCatalogV1ToV2(changed);

    assert.notEqual(first.report.sourceFingerprint, second.report.sourceFingerprint);

    const remoteTypeChanged = groups();
    remoteTypeChanged[0].projects[0].remoteType = 1;
    assert.notEqual(
        first.report.sourceFingerprint,
        migrateProjectCatalogV1ToV2(remoteTypeChanged).report.sourceFingerprint,
    );
});

test('PROJECT-CATALOG-V2-DETERMINISTIC-MIGRATION-001 keeps one Project identity and one real conflict', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const { mergeProjectCatalogV2Documents } = require('../../../out/projects/catalogV2/merge');
    const left = groups();
    const right = groups();
    right[0].collapsed = true;
    right[0].projects[0].path = 'vscode-remote://ssh-remote%2Bdevbox/work/api-moved';

    const merged = materialize(mergeProjectCatalogV2Documents(
        migrateProjectCatalogV1ToV2(left).document,
        migrateProjectCatalogV1ToV2(right).document,
    ));

    assert.equal(merged.projects.length, 3);
    assert.deepEqual(merged.conflicts.map(conflict => [conflict.entityKind, conflict.field]), [
        ['projects', 'path'],
    ]);
});

test('PROJECT-CATALOG-V2-DETERMINISTIC-MIGRATION-001 builds the 500 Project preview without quadratic reparsing', () => {
    const { migrateProjectCatalogV1ToV2 } = migration();
    const input = [{
        id: 'large',
        groupName: 'Large',
        collapsed: false,
        projects: Array.from({ length: 500 }, (_, index) => ({
            id: `project-${index}`,
            name: `Project ${index}`,
            path: `vscode-remote://ssh-remote%2Bdevbox/work/project-${index}`,
            tags: [],
        })),
    }];
    const startedAt = Date.now();

    const result = migrateProjectCatalogV1ToV2(input);

    assert.equal(result.report.projectCount, 500);
    assert.ok(Date.now() - startedAt < 5_000);
});
