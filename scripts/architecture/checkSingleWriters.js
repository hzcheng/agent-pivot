'use strict';

/**
 * Single-writer enforcement (Harness v0, program Stage 2 PR 3).
 *
 * Validates the invariant catalog (docs/testing/architecture-invariants.json)
 * structurally and cross-file, then mechanically checks every invariant whose
 * enforcement includes "single-writer": a write-method touch on the state
 * family's store outside the declared writer set fails. The writer set is a
 * ratchet — it may only shrink during migration, never grow.
 *
 * The write-method scan is AST-based (review R7): property access
 * (`store.updateMember(...)`), element access (`store['updateMember'](...)`),
 * and destructuring (`const { updateMember } = store`, including aliased)
 * are all detected, so renaming the receiver or re-binding the method cannot
 * launder a write past the guard. What it cannot detect: a write through a
 * mock-typed double in a file that never mentions the store module — such a
 * file would also fail the module-boundary guard on the import edge, and the
 * behavior owner tests pin the authority semantics.
 *
 * Bypass check: every literal in stateFamily.persistenceKeys may appear only
 * inside the store file — a memento-key reference is a raw write path around
 * the authority.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
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
                if (family.persistenceKeys !== undefined) {
                    if (!Array.isArray(family.persistenceKeys)
                        || family.persistenceKeys.length === 0
                        || family.persistenceKeys.some(key => typeof key !== 'string' || !key)) {
                        errors.push(`${owner}: stateFamily.persistenceKeys must be a non-empty `
                            + 'array of strings');
                    } else {
                        // A declared key that no longer exists in the store is
                        // stale policy, not protection.
                        const storeText = fs.existsSync(path.join(rootDirectory, family.storePath))
                            ? fs.readFileSync(path.join(rootDirectory, family.storePath), 'utf8')
                            : '';
                        for (const key of family.persistenceKeys) {
                            if (!storeText.includes(key)) {
                                errors.push(`${owner}: persistence key '${key}' does not appear in `
                                    + `${family.storePath} — stale or mistyped keys protect nothing`);
                            }
                        }
                    }
                }
            }
            if (!Array.isArray(invariant.writers) || invariant.writers.length === 0) {
                errors.push(`${owner}: single-writer enforcement requires a non-empty writers set`);
            }
        }
    }
    return { catalog, errors };
}

/**
 * AST scan: every property access, element access, or destructuring binding
 * that names a write method — resilient to import aliases, receiver renames,
 * .bind extraction, and bracket access (review R7).
 */
function findWriteMethodTouches(file, text, writeMethods) {
    const sourceFile = ts.createSourceFile(
        file, text, ts.ScriptTarget.Latest, true,
        file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const touches = new Set();
    const visit = node => {
        if (ts.isPropertyAccessExpression(node) && writeMethods.has(node.name.text)) {
            touches.add(`touches write method '${node.name.text}'`);
        } else if (ts.isElementAccessExpression(node)) {
            const argument = node.argumentExpression;
            if (argument && (ts.isStringLiteral(argument)
                || ts.isNoSubstitutionTemplateLiteral(argument))
                && writeMethods.has(argument.text)) {
                touches.add(`touches write method '${argument.text}' via element access`);
            }
        } else if (ts.isBindingElement(node)) {
            const name = node.propertyName && ts.isIdentifier(node.propertyName)
                ? node.propertyName.text
                : (ts.isIdentifier(node.name) ? node.name.text : null);
            if (name && writeMethods.has(name)) {
                touches.add(`destructures write method '${name}'`);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return [...touches].sort();
}

/** Scan declared state families for write-method touches outside the writers. */
function checkWriters(rootDirectory, catalog, policy) {
    const errors = [];
    const invariants = (catalog.invariants || [])
        .filter(invariant => invariant.stateFamily
            && (invariant.enforcement || []).includes('single-writer'));
    for (const invariant of invariants) {
        const family = invariant.stateFamily;
        const writers = new Set([...invariant.writers, family.storePath]);
        const storeReference = path.basename(family.storePath).replace(/\.[^.]+$/, '');
        const writeMethods = new Set(family.writeMethods);
        const persistenceKeys = family.persistenceKeys || [];
        for (const file of policy.files) {
            if (writers.has(file)) { continue; }
            const text = fs.readFileSync(path.join(rootDirectory, file), 'utf8');
            for (const key of persistenceKeys) {
                if (text.includes(key)) {
                    errors.push(`single-writer: ${file} references persistence key '${key}' of the `
                        + `${family.storePath} state family outside the store — a raw storage write `
                        + `bypasses the authority of ${invariant.id}`);
                }
            }
            // A same-named method on an unrelated store is not a bypass: the
            // file must also reference the state family's store.
            if (!text.includes(storeReference)) { continue; }
            for (const touch of findWriteMethodTouches(file, text, writeMethods)) {
                errors.push(`single-writer: ${file} ${touch} on the `
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
