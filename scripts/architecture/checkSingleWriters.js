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
 * The write-method scan uses the TypeScript type checker (round-2 review
 * Important 1, superseding the R7 name-matching pass): the receiver of a
 * write-method call is resolved to its declaring class through barrels,
 * aliases, element access, destructuring, and import renames, so only a
 * receiver whose type is actually the store class trips the guard — and a
 * store value passed as an argument into a non-writer file is flagged as a
 * provision bypass (structural-typing injections need a provision site to
 * do harm). What it cannot detect: a writer deliberately handing the store
 * to a helper inside another file — that is writer discipline, covered by
 * review.
 *
 * Bypass check: every literal in stateFamily.persistenceKeys may appear only
 * inside the store file — a memento-key reference is a raw write path around
 * the authority.
 *
 * Harness Simplification PR 5/6: a family whose stateFamily declares
 * `writerFacade: true` no longer needs the type-resolved method scan. Its
 * store exposes no write capability through the module entrypoint (a
 * capability-free handle plus narrow read/write views), so enforcement is
 * structural: only declared writers and the module entrypoint may import the
 * store file, checked on the dependency graph instead of the AST.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');
const { buildDependencyGraph } = require('./buildDependencyGraph');

const INVARIANTS_PATH = path.join('docs', 'testing', 'architecture-invariants.json');
const INVARIANT_ID_PATTERN = /^ARCH-[A-Z0-9]+(?:-[A-Z0-9]+)*-\d{3}$/;
const PRIORITIES = ['P0', 'P1', 'P2'];
const KINDS = ['product', 'state-machine', 'identity', 'persistence', 'protocol',
    'concurrency', 'recovery', 'dependency', 'performance', 'security'];
const ENFORCEMENTS = ['module-boundary', 'single-writer', 'behavior', 'fault-matrix'];

/** Top-level exported symbol names defined (never merely re-exported) in a file. */
function definedExportedSymbols(rootDirectory, relativePath) {
    const text = fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8');
    const sourceFile = ts.createSourceFile(
        relativePath, text, ts.ScriptTarget.Latest, true,
        relativePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const defined = new Set();
    const isExported = node => node.modifiers
        && node.modifiers.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const visit = node => {
        if (isExported(node) && node.name && ts.isIdentifier(node.name)
            && (ts.isClassDeclaration(node) || ts.isFunctionDeclaration(node)
                || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
                || ts.isEnumDeclaration(node))) {
            defined.add(node.name.text);
        }
        if (ts.isVariableStatement(node) && isExported(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name)) { defined.add(declaration.name.text); }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return defined;
}

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
            // Review R9 (Important 3): the authority symbol must be defined
            // in the authority file — a re-export is not an authority — and
            // the file's module must be the invariant's module or an
            // explicitly declared participant.
            if (typeof invariant.authority.symbol === 'string' && invariant.authority.symbol
                && fs.existsSync(path.join(rootDirectory, invariant.authority.path))) {
                const defined = definedExportedSymbols(rootDirectory, invariant.authority.path);
                if (!defined.has(invariant.authority.symbol)) {
                    errors.push(`${owner}: authority.symbol '${invariant.authority.symbol}' is not `
                        + `defined in ${invariant.authority.path} (a re-export is not an authority)`);
                }
            }
            const authorityModule = policy.classification.get(invariant.authority.path)?.moduleId;
            const participants = invariant.participatingModules || [];
            if (authorityModule && authorityModule !== invariant.module
                && !participants.includes(authorityModule)) {
                errors.push(`${owner}: authority path ${invariant.authority.path} belongs to `
                    + `${authorityModule}, not ${invariant.module} — declare the cross-module `
                    + 'participation in participatingModules');
            }
        }
        if (invariant.participatingModules !== undefined) {
            if (!Array.isArray(invariant.participatingModules)
                || invariant.participatingModules.length === 0
                || invariant.participatingModules.some(moduleId => !moduleIds.has(moduleId))) {
                errors.push(`${owner}: participatingModules must be a non-empty array of known `
                    + 'module ids');
            }
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
            if (family && family.writerFacade !== undefined
                && typeof family.writerFacade !== 'boolean') {
                errors.push(`${owner}: stateFamily.writerFacade must be a boolean when present`);
            }
        }
    }
    return { catalog, errors };
}

/**
 * One shared TypeScript program per run (round-2 review Important 1): type
 * resolution sees through barrels, aliases, and re-exports. Local
 * class/interface types resolve without lib types; unresolved externals
 * become `any` and simply never match the store class.
 */
function buildTypeContext(rootDirectory, files) {
    const program = ts.createProgram(files.map(file => path.join(rootDirectory, file)), {
        noEmit: true,
        allowJs: true,
        checkJs: false,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        strict: false,
        types: [],
    });
    return { program, checker: program.getTypeChecker() };
}

/** The file that declares the CLASS of the expression's type, or null. */
function declaringFileOf(rootDirectory, checker, node) {
    const type = checker.getTypeAtLocation(node);
    const symbol = type && (type.getSymbol() || type.symbol);
    const declaration = symbol && symbol.declarations && symbol.declarations[0];
    // Only class instances carry write capability; plain interfaces declared
    // in the store file (member records etc.) are data, not the store.
    if (!declaration || !ts.isClassDeclaration(declaration)) { return null; }
    const fileName = declaration.getSourceFile().fileName;
    const relative = path.relative(rootDirectory, fileName).split(path.sep).join('/');
    return relative.startsWith('..') ? null : relative;
}

/**
 * Type-resolved scan: write-method calls whose receiver is actually the
 * store class (barrels and aliases included), destructuring off a
 * store-typed value, and store-class values provisioned as call arguments
 * into files outside the store's writer union.
 */
function findTypeResolvedViolations(rootDirectory, typeContext, file, families, unionWriters) {
    const sourceFile = typeContext.program.getSourceFile(path.join(rootDirectory, file));
    if (!sourceFile) { return []; }
    const violations = [];
    const { checker } = typeContext;
    const visit = node => {
        if ((ts.isPropertyAccessExpression(node)
                && families.some(family => family.writeMethods.has(node.name.text)))
            || (ts.isElementAccessExpression(node)
                && ts.isStringLiteral(node.argumentExpression)
                && families.some(family =>
                    family.writeMethods.has(node.argumentExpression.text)))) {
            const declaringFile = declaringFileOf(rootDirectory, checker, node.expression);
            for (const family of families) {
                const isElement = ts.isElementAccessExpression(node);
                const methodName = isElement ? node.argumentExpression.text : node.name.text;
                if (!family.writeMethods.has(methodName)) { continue; }
                if (declaringFile === family.storePath && !family.writers.has(file)) {
                    // Message keeps the historical 'touches write method' /
                    // 'via element access' substrings: the guard mutation
                    // parity lane re-runs base suites against this guard.
                    violations.push(`touches write method '${methodName}'`
                        + `${isElement ? ' via element access' : ''} on a ${family.storePath}-typed`
                        + ` receiver outside the declared writers of ${family.id}`);
                }
            }
        } else if (ts.isBindingElement(node)) {
            const name = node.propertyName && ts.isIdentifier(node.propertyName)
                ? node.propertyName.text
                : (ts.isIdentifier(node.name) ? node.name.text : null);
            if (!name || !families.some(family => family.writeMethods.has(name))) { return; }
            const declaration = node.parent && node.parent.parent;
            const initializer = declaration && ts.isVariableDeclaration(declaration)
                ? declaration.initializer
                : null;
            if (!initializer) { return; }
            for (const family of families) {
                if (!family.writeMethods.has(name)) { continue; }
                const declaringFile = declaringFileOf(rootDirectory, checker, initializer);
                if (declaringFile === family.storePath && !family.writers.has(file)) {
                    violations.push(`destructures write method '${name}' off a `
                        + `${family.storePath}-typed value outside the declared writers of ${family.id}`);
                }
            }
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            if (unionWriters.has(file)) { return; }
            for (const argument of node.arguments || []) {
                const declaringFile = declaringFileOf(rootDirectory, checker, argument);
                for (const family of families) {
                    if (declaringFile === family.storePath) {
                        violations.push(`provisions a ${family.storePath}-typed value into `
                            + `a call outside the declared writers of ${family.id} (structural `
                            + 'injection bypass)');
                        break;
                    }
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return violations;
}

/** Scan declared state families for write-method touches outside the writers. */
function checkWriters(rootDirectory, catalog, policy) {
    const errors = [];
    const invariants = (catalog.invariants || [])
        .filter(invariant => invariant.stateFamily
            && (invariant.enforcement || []).includes('single-writer'));
    // Group by store: the writer union across families sharing one store
    // governs the provision rule; per-family sets govern write calls.
    const familiesByStore = new Map();
    for (const invariant of invariants) {
        const family = invariant.stateFamily;
        if (!familiesByStore.has(family.storePath)) {
            familiesByStore.set(family.storePath, []);
        }
        familiesByStore.get(family.storePath).push({
            id: invariant.id,
            storePath: family.storePath,
            writeMethods: new Set(family.writeMethods),
            writers: new Set([...invariant.writers, family.storePath]),
            persistenceKeys: family.persistenceKeys || [],
            writerFacade: family.writerFacade === true,
        });
    }
    // Harness Simplification PR 5/6: a family declaring `writerFacade`
    // exposes no write capability through the module entrypoint (handle +
    // narrow views), so the type-resolved method scan is replaced by a
    // structural import rule: only declared writers (and the module
    // entrypoint wiring the facade) may import the store file at all.
    const facadeStores = new Map();
    for (const [storePath, families] of familiesByStore) {
        const withFacade = families.filter(family => family.writerFacade);
        if (withFacade.length > 0 && withFacade.length !== families.length) {
            errors.push(`single-writer: families sharing store ${storePath} disagree on `
                + 'writerFacade — the facade is a store-level property');
            continue;
        }
        if (withFacade.length > 0) { facadeStores.set(storePath, families); }
    }
    if (facadeStores.size > 0) {
        const { edges, errors: graphErrors } = buildDependencyGraph(rootDirectory);
        errors.push(...graphErrors);
        const entrypointsByModule = new Map(policy.modules.map(module =>
            [module.id, new Set(module.publicEntrypoints || [])]));
        for (const [storePath, families] of facadeStores) {
            const unionWriters = new Set(families.flatMap(family => [...family.writers]));
            const storeModule = policy.classification.get(storePath)?.moduleId;
            const allowed = new Set([
                ...unionWriters,
                ...(entrypointsByModule.get(storeModule) || new Set()),
                storePath,
            ]);
            for (const edge of edges) {
                if (edge.target !== storePath || allowed.has(edge.source)) { continue; }
                errors.push(`single-writer: ${edge.source} imports facade store ${storePath} — `
                    + 'only declared writers and the module entrypoint may import it; write '
                    + 'capability is no longer reachable through the entrypoint');
            }
        }
    }
    let typeContext = null;
    const typeContextLazy = () => {
        if (!typeContext) { typeContext = buildTypeContext(rootDirectory, policy.files); }
        return typeContext;
    };
    for (const [storePath, families] of familiesByStore) {
        const unionWriters = new Set(families.flatMap(family => [...family.writers]));
        const persistenceKeys = [...new Set(families.flatMap(family => family.persistenceKeys))];
        for (const file of policy.files) {
            if (!unionWriters.has(file)) {
                const text = fs.readFileSync(path.join(rootDirectory, file), 'utf8');
                for (const key of persistenceKeys) {
                    if (text.includes(key)) {
                        errors.push(`single-writer: ${file} references persistence key '${key}' of the `
                            + `${storePath} state family outside the store — a raw storage write `
                            + 'bypasses the authority');
                    }
                }
            }
            if (unionWriters.has(file) || facadeStores.has(storePath)) { continue; }
            for (const violation of findTypeResolvedViolations(
                rootDirectory, typeContextLazy(), file, families, unionWriters)) {
                errors.push(`single-writer: ${file} ${violation} — route the write through `
                    + 'the authority or land an approved architecture change that amends the '
                    + 'writer set');
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
