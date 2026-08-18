'use strict';

/**
 * Dependency graph builder (Harness v0, program Stage 2 PR 2).
 *
 * Builds the complete local import graph over the classified production
 * files: static imports, re-exports, type-only imports, require() calls, and
 * type-position import('...') references. Every edge records its source file,
 * target file, both modules, and its kind (value | type).
 *
 * Fail closed: a relative specifier that does not resolve to a classified
 * file is an error, never silently skipped.
 */

const fs = require('fs');
const path = require('path');
const { loadArchitecturePolicy } = require('./loadArchitecturePolicy');

const IMPORT_PATTERN =
    /(?:import|export)([^'"]*?)\bfrom\s*['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]|require\(\s*['"](\.[^'"]+)['"]\s*\)|import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

function edgeKind(importClause) {
    return /^\s*type\b/.test(importClause || '') ? 'type' : 'value';
}

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
function buildDependencyGraph(rootDirectory) {
    const { classification, errors } = loadArchitecturePolicy(rootDirectory);
    const classifiedFiles = new Set(classification.keys());
    const edges = [];

    for (const [file, owner] of classification) {
        const text = fs.readFileSync(path.join(rootDirectory, file), 'utf8');
        IMPORT_PATTERN.lastIndex = 0;
        let match;
        while ((match = IMPORT_PATTERN.exec(text))) {
            const [, importClause, fromSpecifier, bareSpecifier, requireSpecifier, dynamicSpecifier] = match;
            const specifier = fromSpecifier || bareSpecifier || requireSpecifier || dynamicSpecifier;
            const kind = fromSpecifier
                ? edgeKind(importClause)
                : dynamicSpecifier ? 'type' : 'value';
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
