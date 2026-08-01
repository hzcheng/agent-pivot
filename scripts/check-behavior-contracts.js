'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadBehaviorCatalog, validateBehaviorCatalog } = require('./lib/behaviorCatalog');
const {
    collectAuditedCommits,
    collectUnauditedCommits,
    loadMainCapabilityCoverage,
    loadWorkflowSources,
    validateMainCapabilityCoverage,
} = require('./lib/mainCapabilityCoverage');

function main() {
    const repositoryRoot = path.resolve(__dirname, '..');
    const catalogPath = path.join(repositoryRoot, 'docs', 'testing', 'behavior-contracts.json');
    const capabilityPath = path.join(
        repositoryRoot,
        'docs',
        'testing',
        'main-capability-coverage.json'
    );
    let entries;
    let manifest;
    try {
        entries = loadBehaviorCatalog(catalogPath);
        manifest = loadMainCapabilityCoverage(capabilityPath);
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
        return;
    }

    const behaviorErrors = validateBehaviorCatalog(entries, { repositoryRoot });
    let capabilityErrors;
    try {
        capabilityErrors = validateMainCapabilityCoverage(manifest, {
            repositoryRoot,
            behaviors: entries,
            scripts: require(path.join(repositoryRoot, 'package.json')).scripts,
            workflows: loadWorkflowSources(repositoryRoot),
            auditedCommits: collectAuditedCommits(repositoryRoot, manifest.audit),
            unauditedCommits: collectUnauditedCommits(repositoryRoot, manifest.audit),
        });
    } catch (error) {
        capabilityErrors = [`cannot collect main capability evidence: ${error.message}`];
    }
    const errors = [...behaviorErrors, ...capabilityErrors];
    if (errors.length > 0) {
        for (const error of errors) {
            console.error(error);
        }
        process.exitCode = 1;
        return;
    }

    console.log('Behavior contract catalog checks passed.');
    console.log('Main capability regression coverage checks passed.');
}

main();
