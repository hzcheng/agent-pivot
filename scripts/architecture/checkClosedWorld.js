'use strict';

/**
 * Closed-world architecture classification check (Harness v0, Stage 2 PR 1).
 *
 * Verifies that every production source file under the declared scope roots
 * has exactly one architecture module and exactly one role, and that the
 * registry carries no stale patterns or unresolved references. Fail closed:
 * anything the policy does not understand is an error.
 *
 * Usage: node scripts/architecture/checkClosedWorld.js
 * Exit code 0 with a summary report when the classification is clean.
 * The runner is exported so the owner unit tests exercise it under coverage.
 */

const path = require('path');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');

function runClosedWorldCheck(rootDirectory) {
    const { modules, files, classification, errors } = loadArchitecturePolicy(rootDirectory);

    if (errors.length > 0) {
        console.error('Closed-world architecture classification FAILED:');
        for (const error of errors) {
            console.error(`  ✗ ${error}`);
        }
        console.error('');
        console.error('Remediation: every production file must be owned by exactly one module');
        console.error('in docs/testing/architecture-modules.json and assigned exactly one role.');
        console.error('New files need a deliberate classification; stale patterns must be pruned.');
        return 1;
    }

    const perModule = new Map();
    for (const [, assignment] of classification) {
        const key = `${assignment.moduleId} (${assignment.role})`;
        perModule.set(key, (perModule.get(key) || 0) + 1);
    }
    console.log(`Closed-world architecture classification passed: ${classification.size} files, `
        + `${modules.length} modules.`);
    for (const module of modules) {
        const moduleFiles = files.filter(file =>
            classification.get(file) && classification.get(file).moduleId === module.id);
        const roleCounts = module.roles
            .map(roleEntry => {
                const count = moduleFiles.filter(file =>
                    classification.get(file).role === roleEntry.role).length;
                return `${roleEntry.role}:${count}`;
            })
            .join(' ');
        console.log(`  ${module.id}: ${moduleFiles.length} files [${roleCounts}]`);
    }
    return 0;
}

if (require.main === module) {
    const exitCode = runClosedWorldCheck(path.resolve(__dirname, '..', '..'));
    if (exitCode !== 0) {
        process.exitCode = exitCode;
    }
}

module.exports = { runClosedWorldCheck };
