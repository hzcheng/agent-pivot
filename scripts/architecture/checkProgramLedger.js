'use strict';

/**
 * Program ledger enforcement (Harness v0; charter Section 8.5).
 *
 * docs/testing/architecture-program.json records each module's migration
 * state. This check validates the ledger schema, the state vocabulary, and
 * mechanically enforces strict-mode preconditions: a strict module has no
 * baseline fingerprint or waiver naming it, its P0/P1 invariants have
 * behavior owners, and its single-writer families declare writers. An agent
 * cannot mark a module strict while debt still names it.
 *
 * Review R9 (Important 9): every registered module must have exactly one
 * ledger entry; a strict entry must carry a structured target contract
 * (target.publicEntrypoints matching the registry exactly) and zero deep
 * imports into module internals, computed from the dependency graph — the
 * strict claim is verified against the graph, not asserted in prose.
 */

const fs = require('fs');
const path = require('path');
const { loadArchitecturePolicy, compileGlob } = require('./loadArchitecturePolicy');
const { buildDependencyGraph } = require('./buildDependencyGraph');

const LEDGER_PATH = path.join('docs', 'testing', 'architecture-program.json');
const BASELINE_PATH = path.join('.ci', 'architecture-debt-baseline.json');
const WAIVERS_PATH = path.join('docs', 'testing', 'architecture-waivers.json');
const INVARIANTS_PATH = path.join('docs', 'testing', 'architecture-invariants.json');

function readJson(rootDirectory, relativePath, errors, label) {
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
    } catch (error) {
        errors.push(`ledger: cannot read ${relativePath}: ${error.message}`);
        return null;
    }
}

/** External edges into a module's files that bypass its declared entrypoints. */
function countDeepImports(rootDirectory, moduleId, publicEntrypoints) {
    const { edges, errors } = buildDependencyGraph(rootDirectory);
    if (errors.length > 0) { return -1; }
    const entrypoints = publicEntrypoints.map(compileGlob);
    return edges.filter(edge => edge.targetModule === moduleId
        && edge.sourceModule !== moduleId
        && !entrypoints.some(pattern => pattern.test(edge.target))).length;
}

function runProgramLedgerCheck(rootDirectory) {
    const errors = [];
    const policy = loadArchitecturePolicy(rootDirectory);
    errors.push(...policy.errors);
    const ledger = readJson(rootDirectory, LEDGER_PATH, errors, 'ledger');
    const baseline = readJson(rootDirectory, BASELINE_PATH, errors, 'baseline');
    const waivers = readJson(rootDirectory, WAIVERS_PATH, errors, 'waivers');
    const invariants = readJson(rootDirectory, INVARIANTS_PATH, errors, 'invariants');
    if (!ledger || !baseline || !waivers || !invariants) { return { errors }; }

    const states = Array.isArray(ledger.states) ? ledger.states : [];
    const modules = ledger.modules && typeof ledger.modules === 'object'
        ? ledger.modules : {};
    const registryIds = new Set(policy.modules.map(module => module.id));

    for (const [moduleId, entry] of Object.entries(modules)) {
        if (!registryIds.has(moduleId)) {
            errors.push(`ledger: ${moduleId} is not a registered module`);
        }
        if (!entry || !states.includes(entry.state)) {
            errors.push(`ledger: ${moduleId} has an unknown state '${entry && entry.state}'`);
        }
    }
    // Review R9 (Important 9): every registered module has exactly one
    // ledger entry — an untracked module escapes the program's progress
    // accounting.
    for (const moduleId of registryIds) {
        if (!(moduleId in modules)) {
            errors.push(`ledger: ${moduleId} has no ledger entry (every registered `
                + 'module must be tracked)');
        }
    }

    const baselineFingerprints = Object.values((baseline && baseline.rules) || {})
        .flatMap(rule => rule.fingerprints || []);
    const waiverFingerprints = new Set(((waivers && waivers.waivers) || [])
        .flatMap(waiver => waiver.fingerprints || []));
    const invariantList = Array.isArray(invariants.invariants) ? invariants.invariants : [];
    const fingerprintModules = fingerprint => {
        if (fingerprint.startsWith('2:')) { return fingerprint.slice(2).split('->'); }
        if (fingerprint.startsWith('scc:')) { return fingerprint.slice(4).split('|'); }
        return [];
    };
    const namesModule = (fingerprint, moduleId) =>
        fingerprintModules(fingerprint).includes(moduleId);

    for (const [moduleId, entry] of Object.entries(modules)) {
        if (!entry || entry.state !== 'strict') { continue; }
        // Exact-once classification is a strict precondition (red line 1).
        if (policy.errors.length > 0) {
            errors.push(`ledger: ${moduleId} cannot be strict while the closed-world `
                + 'classification has errors');
        }
        // Structured target contract (review R9): the strict claim must
        // name the approved entrypoint surface and prove it against the
        // dependency graph.
        const module = policy.modules.find(candidate => candidate.id === moduleId);
        const target = entry.target;
        if (!target || !Array.isArray(target.publicEntrypoints)
            || target.publicEntrypoints.length === 0) {
            errors.push(`ledger: ${moduleId} is strict but declares no target.publicEntrypoints `
                + '— the strict claim must reference the structured target contract');
        } else {
            const registryEntrypoints = [...(module.publicEntrypoints || [])].sort();
            const declared = [...target.publicEntrypoints].sort();
            if (JSON.stringify(registryEntrypoints) !== JSON.stringify(declared)) {
                errors.push(`ledger: ${moduleId} target.publicEntrypoints `
                    + `(${declared.join(', ')}) do not match the registry `
                    + `(${registryEntrypoints.join(', ')})`);
            }
            const deepImports = countDeepImports(rootDirectory, moduleId, target.publicEntrypoints);
            if (deepImports < 0) {
                errors.push(`ledger: ${moduleId} strict target cannot be evaluated while the `
                    + 'dependency graph has errors');
            } else if (deepImports > 0) {
                errors.push(`ledger: ${moduleId} claims strict but ${deepImports} external `
                    + 'edge(s) deep-import its internals');
            }
        }
        const namingBaseline = baselineFingerprints.filter(fingerprint =>
            namesModule(fingerprint, moduleId));
        for (const fingerprint of namingBaseline) {
            errors.push(`ledger: ${moduleId} cannot be strict while baseline entry `
                + `'${fingerprint}' names it`);
        }
        const namingWaivers = [...waiverFingerprints].filter(fingerprint =>
            namesModule(fingerprint, moduleId));
        for (const fingerprint of namingWaivers) {
            errors.push(`ledger: ${moduleId} cannot be strict while waiver-covered `
                + `fingerprint '${fingerprint}' names it`);
        }
        for (const invariant of invariantList.filter(item => item.module === moduleId)) {
            if ((invariant.priority === 'P0' || invariant.priority === 'P1')
                && (!Array.isArray(invariant.behaviorOwners)
                    || invariant.behaviorOwners.length === 0)) {
                errors.push(`ledger: ${moduleId} cannot be strict while ${invariant.id} `
                    + 'has no behavior owner');
            }
            if ((invariant.enforcement || []).includes('single-writer')
                && (!Array.isArray(invariant.writers) || invariant.writers.length === 0)) {
                errors.push(`ledger: ${moduleId} cannot be strict while ${invariant.id} `
                    + 'declares no writer set');
            }
        }
    }
    return { errors };
}

function main() {
    const { errors } = runProgramLedgerCheck(path.resolve(__dirname, '..', '..'));
    if (errors.length > 0) {
        console.error('Program ledger checks FAILED:');
        for (const error of errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log('Program ledger checks passed: module states valid, '
        + 'strict-mode preconditions hold.');
}

if (require.main === module) { main(); }

module.exports = { runProgramLedgerCheck };
