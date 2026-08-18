'use strict';

/**
 * Dependency graph builder (Harness v0, program Stage 2 PR 2).
 *
 * Builds the complete local import graph over the classified production
 * files with a TypeScript AST walk (review R7): static imports, re-exports,
 * type-only imports, require() calls, type-position import('...') types, and
 * runtime dynamic imports. Every edge records its source file, target file,
 * both modules, and its kind (value | type).
 *
 * A runtime `await import('./x')` is a value edge (the cycle ratchet
 * analyzes value edges, so a dynamic import can never smuggle a runtime
 * cycle past it); only type-position `import('./x').T` types stay type
 * edges. Fail closed: a relative specifier that does not resolve to a
 * classified file is an error, and any import/export/require form the
 * walker does not recognize is an error, never silently skipped.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');

function resolveTarget(sourceFile, specifier, classifiedFiles) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), specifier));
    const candidates = specifier.endsWith('.js')
        ? [target, target.replace(/\.js$/, '.ts')]
        : [target, `${target}.ts`, `${target}.js`,
            path.posix.join(target, 'index.ts'), path.posix.join(target, 'index.js')];
    return candidates.find(candidate => classifiedFiles.has(candidate)) || null;
}

/**
 * Returns { edges, errors }. edges: [{ source, target, sourceModule,
 * targetModule, kind }]. Module-less files never occur (classification is
 * exact-once), but resolution failures are errors.
 */
function literalText(node) {
    return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        ? node.text
        : null;
}

/**
 * Extract { specifier, kind } edge candidates from one source file. Only
 * relative specifiers become edges; bare package specifiers are out of
 * scope. Unrecognized local-reference forms are errors (fail closed).
 */
function extractEdgeCandidates(file, text) {
    const sourceFile = ts.createSourceFile(
        file, text, ts.ScriptTarget.Latest, true,
        file.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS);
    const candidates = [];
    const errors = [];
    const visit = node => {
        if (ts.isImportDeclaration(node)) {
            const specifier = literalText(node.moduleSpecifier);
            if (specifier !== null) {
                candidates.push({
                    specifier,
                    // `import type ...` is a pure type edge; any value
                    // specifier (including a mixed clause) makes it a
                    // value edge.
                    kind: node.importClause && node.importClause.isTypeOnly ? 'type' : 'value',
                });
            }
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const specifier = literalText(node.moduleSpecifier);
            if (specifier !== null) {
                candidates.push({
                    specifier,
                    kind: node.isTypeOnly ? 'type' : 'value',
                });
            }
        } else if (ts.isImportEqualsDeclaration(node)) {
            const reference = node.moduleReference;
            if (ts.isExternalModuleReference(reference)) {
                const specifier = literalText(reference.expression);
                if (specifier !== null) {
                    candidates.push({ specifier, kind: 'value' });
                } else if (reference.expression
                    && reference.expression.getText(sourceFile).startsWith('.')) {
                    errors.push(`${file}: unrecognized import-require form '` +
                        `${reference.expression.getText(sourceFile)}'`);
                }
            }
            // Namespace aliases (import X = A.B) carry no module specifier;
            // they are not edges.
        } else if (ts.isImportTypeNode(node)) {
            // Type-position import('./x').T — the only form that stays a
            // type edge.
            const argument = node.argument;
            const specifier = ts.isLiteralTypeNode(argument)
                ? literalText(argument.literal)
                : null;
            if (specifier !== null) {
                candidates.push({ specifier, kind: 'type' });
            } else {
                errors.push(`${file}: unrecognized type-import form in import type`);
            }
        } else if (ts.isCallExpression(node)) {
            if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
                // Runtime dynamic import — a genuine value edge.
                const specifier = literalText(node.arguments[0]);
                if (specifier !== null) {
                    candidates.push({ specifier, kind: 'value' });
                } else {
                    errors.push(`${file}: dynamic import() with a non-literal specifier`);
                }
            } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
                const specifier = literalText(node.arguments[0]);
                if (specifier !== null) {
                    candidates.push({ specifier, kind: 'value' });
                } else {
                    errors.push(`${file}: require() with a non-literal specifier`);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { candidates, errors };
}

function buildDependencyGraph(rootDirectory) {
    const { classification, errors } = loadArchitecturePolicy(rootDirectory);
    const classifiedFiles = new Set(classification.keys());
    const edges = [];

    for (const [file, owner] of classification) {
        const text = fs.readFileSync(path.join(rootDirectory, file), 'utf8');
        const { candidates, errors: extractionErrors } = extractEdgeCandidates(file, text);
        errors.push(...extractionErrors);
        for (const { specifier, kind } of candidates) {
            if (!specifier.startsWith('.')) { continue; }
            const target = resolveTarget(file, specifier, classifiedFiles);
            if (!target) {
                errors.push(`dependency-graph: ${file} has an unresolvable local specifier '${specifier}'`);
                continue;
            }
            edges.push({
                source: file,
                target,
                sourceModule: owner.moduleId,
                targetModule: classification.get(target).moduleId,
                kind,
            });
        }
    }
    return { edges, errors, classification };
}

/** Module-level adjacency (optionally value-kind only). */
function moduleAdjacency(edges, valueOnly) {
    const adjacency = new Map();
    for (const edge of edges) {
        if (valueOnly && edge.kind !== 'value') { continue; }
        if (edge.sourceModule === edge.targetModule) { continue; }
        if (!adjacency.has(edge.sourceModule)) { adjacency.set(edge.sourceModule, new Set()); }
        adjacency.get(edge.sourceModule).add(edge.targetModule);
    }
    return adjacency;
}

/**
 * Bounded cycle reporting: enumerating all simple cycles explodes
 * exponentially on this graph, so the ratchet tracks (a) direct 2-cycles and
 * (b) strongly connected components of size >= 2. Both are cheap and stable:
 * a new 2-cycle or an SCC that gains a member is new debt; an SCC that
 * shrinks or splits is debt removal.
 */
function moduleTwoCycles(edges) {
    const adjacency = moduleAdjacency(edges, true);
    const pairs = [];
    for (const [source, targets] of adjacency) {
        for (const target of targets) {
            if (source < target && adjacency.get(target) && adjacency.get(target).has(source)) {
                pairs.push(`${source}->${target}`);
            }
        }
    }
    return pairs.sort();
}

/** Tarjan SCC over the value-edge module graph; returns cyclic clusters only. */
function moduleCyclicClusters(edges) {
    const adjacency = moduleAdjacency(edges, true);
    const indexByNode = new Map();
    const lowLink = new Map();
    const stack = [];
    const onStack = new Set();
    const clusters = [];
    let nextIndex = 0;

    function strongConnect(node) {
        indexByNode.set(node, nextIndex);
        lowLink.set(node, nextIndex);
        nextIndex += 1;
        stack.push(node);
        onStack.add(node);
        for (const target of adjacency.get(node) || []) {
            if (!indexByNode.has(target)) {
                strongConnect(target);
                lowLink.set(node, Math.min(lowLink.get(node), lowLink.get(target)));
            } else if (onStack.has(target)) {
                lowLink.set(node, Math.min(lowLink.get(node), indexByNode.get(target)));
            }
        }
        if (lowLink.get(node) === indexByNode.get(node)) {
            const cluster = [];
            let member;
            do {
                member = stack.pop();
                onStack.delete(member);
                cluster.push(member);
            } while (member !== node);
            if (cluster.length > 2) { clusters.push(cluster.sort()); }
        }
    }
    for (const node of [...adjacency.keys()].sort()) {
        if (!indexByNode.has(node)) { strongConnect(node); }
    }
    // Size-2 clusters are already tracked as 2-cycles; only larger clusters
    // are SCC-level debt.
    return clusters.map(cluster => cluster.join('|')).sort();
}

module.exports = {
    buildDependencyGraph,
    moduleAdjacency,
    moduleTwoCycles,
    moduleCyclicClusters,
};
