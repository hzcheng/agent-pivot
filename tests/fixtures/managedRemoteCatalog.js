'use strict';

const {
    applyManagedCatalogTransaction,
    createEmptyManagedRemoteCatalog,
    hostEnvironmentId,
} = require('../../out/projects/managedRemote/merge');

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

module.exports = { largeCatalog };
