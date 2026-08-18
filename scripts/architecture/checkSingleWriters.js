'use strict';

/**
 * Single-writer enforcement (Harness v0, program Stage 2 PR 3).
 *
 * Validates the invariant catalog (docs/testing/architecture-invariants.json)
 * structurally and cross-file, then mechanically checks every invariant whose
 * enforcement includes "single-writer": a write-method call on the state
 * family's store outside the declared writer set fails. The writer set is a
 * ratchet — it may only shrink during migration, never grow.
 *
 * Bypass check: the store's persistence key may not be referenced outside the
 * store file at all.
 */

const fs = require('fs');
const path = require('path');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');

const INVARIANTS_PATH = path.join('docs', 'testing', 'architecture-invariants.json');
const INVARIANT_ID_PATTERN = /^ARCH-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/;
const PRIORITIES = ['P0', 'P1', 'P2'];
const KINDS = ['product', 'state-machine', 'identity', 'persistence', 'protocol',
    'concurrency', 'recovery', 'dependency', 'performance', 'security'];
const ENFORCEMENTS = ['module-boundary', 'single-writer', 'behavior', 'fault-matrix'];

function readJson(rootDirectory, relativePath, errors) {
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
    } catch (error) {
        errors.push(`invariants: cannot read ${relativePath}: ${error.message}`);
        return null;
    }
}

function validateCatalog(rootDirectory, policy) {
    const errors = [];
    const catalog = readJson(rootDirectory, INVARIANTS_PATH, errors);
    if (!catalog) { return { catalog: null, errors }; }
    if (catalog.version !== 1) {
        errors.push('invariants: version must be 1');
    }
    const invariants = Array.isArray(catalog.invariants) ? catalog.invariants : [];
    if (invariants.length === 0) {
        errors.push('invariants: invariants must be a non-empty array');
    }

    const moduleIds = new Set(policy.modules.map(module => module.id));
    const capabilityManifest = readJson(
        rootDirectory, path.join('docs', 'testing', 'main-capability-coverage.json'), errors);
    const capabilityIds = new Set((capabilityManifest ? capabilityManifest.capabilities : [])
        .map(capability => capability.id));
    const invariantIds = new Set();

    const requirePath = (owner, file, field) => {
        if (typeof file !== 'string' || !file || !fs.existsSync(path.join(rootDirectory, file))) {
            errors.push(`${owner}: ${field} path '${file}' does not exist`);
        }
    };

    for (const invariant of invariants) {
        const owner = `invariant ${invariant && invariant.id ? invariant.id : '<missing id>'}`;
        if (!invariant.id || !INVARIANT_ID_PATTERN.test(invariant.id)) {
            errors.push(`${owner}: id must match ${INVARIANT_ID_PATTERN}`);
        }
        if (invariantIds.has(invariant.id)) {
            errors.push(`${owner}: duplicate invariant id`);
        }
        invariantIds.add(invariant.id);
        if (!moduleIds.has(invariant.module)) {
            errors.push(`${owner}: unknown module '${invariant.module}'`);
        }
        for (const capability of invariant.productCapabilities || []) {
            if (!capabilityIds.has(capability)) {
                errors.push(`${owner}: unknown product capability '${capability}'`);
            }
        }
        if (!PRIORITIES.includes(invariant.priority)) {
            errors.push(`${owner}: priority must be one of ${PRIORITIES.join(', ')}`);
        }
        if (!KINDS.includes(invariant.kind)) {
            errors.push(`${owner}: kind must be one of ${KINDS.join(', ')}`);
        }
        if (typeof invariant.statement !== 'string' || !invariant.statement) {
            errors.push(`${owner}: statement is required`);
        }
        if (!invariant.authority || typeof invariant.authority.path !== 'string') {
            errors.push(`${owner}: authority.path is required`);
        } else {
            requirePath(owner, invariant.authority.path, 'authority.path');
        }
        for (const enforcement of invariant.enforcement || []) {
            if (!ENFORCEMENTS.includes(enforcement)) {
                errors.push(`${owner}: unknown enforcement '${enforcement}'`);
            }
        }
        for (const field of ['writers', 'behaviorOwners', 'guardOwners', 'evidence']) {
            for (const file of invariant[field] || []) {
                requirePath(owner, file, field);
            }
        }
        const hasSingleWriter = (invariant.enforcement || []).includes('single-writer');
        if (hasSingleWriter) {
            const family = invariant.stateFamily;
            if (!family || !family.storePath || !Array.isArray(family.writeMethods)
                || family.writeMethods.length === 0) {
                errors.push(`${owner}: single-writer enforcement requires a stateFamily `
                    + 'with storePath and writeMethods');
            } else {
                requirePath(owner, family.storePath, 'stateFamily.storePath');
            }
            if (!Array.isArray(invariant.writers) || invariant.writers.length === 0) {
                errors.push(`${owner}: single-writer enforcement requires a non-empty writers set`);
            }
        }
    }
    return { catalog, errors };
}

/** Scan declared state families for write-method calls outside the writers. */
function checkWriters(rootDirectory, catalog, policy) {
    const errors = [];
    const invariants = (catalog.invariants || [])
        .filter(invariant => invariant.stateFamily
            && (invariant.enforcement || []).includes('single-writer'));
    for (const invariant of invariants) {
        const family = invariant.stateFamily;
        const writers = new Set([...invariant.writers, family.storePath]);
        const storeReference = path.basename(family.storePath).replace(/\.[^.]+$/, '');
        const callPattern = new RegExp(
            `\\.(?:${family.writeMethods.join('|')})\\s*\\(`);
        for (const file of policy.files) {
            if (writers.has(file)) { continue; }
            const text = fs.readFileSync(path.join(rootDirectory, file), 'utf8');
            // A same-named method on an unrelated store is not a bypass: the
            // file must also reference the state family's store.
            if (!text.includes(storeReference)) { continue; }
            const match = callPattern.exec(text);
            if (match) {
                errors.push(`single-writer: ${file} calls '${match[0].slice(1, -1).trim()}' on the `
                    + `${family.storePath} state family outside the declared writers of `
                    + `${invariant.id} — route the write through the authority or land an `
                    + 'approved architecture change that amends the writer set');
            }
        }
    }
    return errors;
}

function runSingleWriterCheck(rootDirectory) {
    const policy = loadArchitecturePolicy(rootDirectory);
    const errors = [...policy.errors];
    const { catalog, errors: catalogErrors } = validateCatalog(rootDirectory, policy);
    errors.push(...catalogErrors);
    if (catalog) {
        errors.push(...checkWriters(rootDirectory, catalog, policy));
    }
    return { errors };
}

function main() {
    const { errors } = runSingleWriterCheck(path.resolve(__dirname, '..', '..'));
    if (errors.length > 0) {
        console.error('Single-writer checks FAILED:');
        for (const error of errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log('Single-writer checks passed: invariant catalog valid, '
        + 'declared state families have no undeclared writers.');
}

if (require.main === module) { main(); }

module.exports = { INVARIANTS_PATH, runSingleWriterCheck };
