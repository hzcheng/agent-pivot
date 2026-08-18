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
 */

const fs = require('fs');
const path = require('path');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');

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
