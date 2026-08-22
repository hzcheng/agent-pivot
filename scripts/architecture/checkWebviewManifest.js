'use strict';

/**
 * Webview declared-manifest enforcement (Harness v0, program Stage 2 PR 5;
 * charter v3 Section 8.6; symbol-level model from review R7).
 *
 * The 37 src/webview/*.js scripts carry no static imports, so the module
 * graph cannot police them. This check enforces the declared manifest
 * (docs/testing/architecture-webview-manifest.json):
 * - membership: every production webview script belongs to exactly one bundle;
 * - load order: the manifest mirrors the builders (bundle inputPaths and the
 *   conversation viewer document) and drift in either direction fails;
 * - globals, closed-world: EVERY window.* or globalThis.* reference must be
 *   declared — an undeclared custom property fails. Script-produced symbols
 *   have exactly one producer (proven by an assignment in that file) and an
 *   exact consumers set; producer and consumers share one bundle; a consumer
 *   with a load-time (top-level) read must load after the producer. host /
 *   vendor / builtin entries model symbols the scripts never produce.
 * - evasion forms fail closed: dynamic window[...] / globalThis[...] access,
 *   bare (unprefixed) references to declared globals, and script writes to
 *   host/vendor/builtin symbols.
 * - staleness: a declared symbol nobody references fails; a declared consumer
 *   that never reads fails; an undeclared reader fails.
 * - direct copies (Harness efficiency PRD, P0-A): every bundle script declares
 *   a directCopies entry mapping it to its byte-identical media/ build output,
 *   unless explicitly listed in the bundle's bundledOnly array; individually
 *   loaded bundles (conversation-viewer) must keep bundledOnly empty. Copy
 *   targets are unique media/<basename> paths. The dashboard bundle declares
 *   its derived output, which the builder must actually write.
 */

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const MANIFEST_PATH = path.join('docs', 'testing', 'architecture-webview-manifest.json');
const BUNDLE_BUILDER = path.join('scripts', 'build-dashboard-webview-bundle.js');
const VIEWER_DOCUMENT = path.join('src', 'aiSessions', 'conversation', 'viewerDocument.ts');
const SYMBOL_PATTERN = /^window\.[A-Za-z_$][A-Za-z0-9_$]*$/;
const PRODUCER_KINDS = ['host', 'vendor', 'builtin'];

function readJson(rootDirectory, relativePath, errors) {
    try {
        return JSON.parse(fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8'));
    } catch (error) {
        errors.push(`webview-manifest: cannot read ${relativePath}: ${error.message}`);
        return null;
    }
}

function checkBundleOrder(rootDirectory) {
    const builderText = fs.readFileSync(path.join(rootDirectory, BUNDLE_BUILDER), 'utf8');
    const builderOrder = [...builderText.matchAll(/'(src\/webview\/[^']+\.js)'/g)]
        .map(match => match[1]);
    const viewerText = fs.readFileSync(path.join(rootDirectory, VIEWER_DOCUMENT), 'utf8');
    const viewerOrder = [...viewerText.matchAll(/mediaUri\('(conversation[A-Za-z]+Scripts\.js)'\)/g)]
        .map(match => `src/webview/${match[1]}`);
    return { builderOrder, viewerOrder };
}

/** window/globalThis usage in one script: writes, reads, load-time reads, dynamic access, bare references. */
function analyzeScript(rootDirectory, script, declaredBareNames) {
    const text = fs.readFileSync(path.join(rootDirectory, script), 'utf8');
    const sourceFile = ts.createSourceFile(
        script, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const writes = new Set();
    const reads = new Set();
    const loadTimeReads = new Set();
    const dynamicAccess = [];
    const bareReferences = [];
    const visit = node => {
        if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
            && (node.expression.text === 'window' || node.expression.text === 'globalThis')) {
            const symbol = `window.${node.name.text}`;
            const parent = node.parent;
            const isWrite = parent && ts.isBinaryExpression(parent)
                && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
                && parent.left === node;
            if (isWrite) {
                writes.add(symbol);
            } else {
                reads.add(symbol);
                let enclosing = node.parent;
                let deferred = false;
                while (enclosing) {
                    if (ts.isFunctionLike(enclosing)) { deferred = true; break; }
                    enclosing = enclosing.parent;
                }
                if (!deferred) { loadTimeReads.add(symbol); }
            }
        } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)
            && (node.expression.text === 'window' || node.expression.text === 'globalThis')) {
            dynamicAccess.push(`${node.expression.text}[...]`);
        } else if (ts.isIdentifier(node) && declaredBareNames.has(node.text)) {
            const parent = node.parent;
            const isPropertyName = parent && ts.isPropertyAccessExpression(parent)
                && parent.name === node;
            const isAssignmentKey = parent && ts.isPropertyAssignment(parent)
                && parent.name === node;
            if (!isPropertyName && !isAssignmentKey) {
                bareReferences.push(node.text);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return {
        writes, reads, loadTimeReads,
        dynamicAccess: [...new Set(dynamicAccess)].sort(),
        bareReferences: [...new Set(bareReferences)].sort(),
    };
}

function validateGlobalsSchema(manifest, bundleOf, rootDirectory, errors) {
    const globals = Array.isArray(manifest.globals) ? manifest.globals : [];
    if (globals.length === 0) {
        errors.push('webview-manifest: globals must be a non-empty array');
        return new Map();
    }
    const seen = new Map();
    for (const entry of globals) {
        const label = `webview-manifest: global ${entry && entry.symbol ? entry.symbol : '<missing symbol>'}`;
        if (!entry || typeof entry.symbol !== 'string' || !SYMBOL_PATTERN.test(entry.symbol)) {
            errors.push(`${label}: symbol must match ${SYMBOL_PATTERN}`);
            continue;
        }
        if (seen.has(entry.symbol)) {
            errors.push(`${label}: duplicate symbol declaration`);
            continue;
        }
        const producer = entry.producer;
        const isScriptProducer = typeof producer === 'string'
            && !PRODUCER_KINDS.includes(producer);
        if (typeof producer !== 'string'
            || (!isScriptProducer && !PRODUCER_KINDS.includes(producer))) {
            errors.push(`${label}: producer must be a script path or one of ${PRODUCER_KINDS.join(', ')}`);
            continue;
        }
        if (isScriptProducer) {
            if (!bundleOf.has(producer)) {
                errors.push(`${label}: producer ${producer} is not a bundle member`);
            } else if (!fs.existsSync(path.join(rootDirectory, producer))) {
                errors.push(`${label}: producer ${producer} does not exist`);
            }
            if (!Array.isArray(entry.consumers)) {
                errors.push(`${label}: consumers must be an array of bundle member scripts`);
            } else {
                for (const consumer of entry.consumers) {
                    if (!bundleOf.has(consumer)) {
                        errors.push(`${label}: consumer ${consumer} is not a bundle member`);
                    } else if (bundleOf.get(consumer) !== bundleOf.get(producer)) {
                        errors.push(`${label}: consumer ${consumer} is in bundle `
                            + `'${bundleOf.get(consumer)}' but the producer ${producer} is in `
                            + `'${bundleOf.get(producer)}' (cross-bundle globals are forbidden)`);
                    }
                }
            }
        } else if (entry.consumers !== undefined) {
            errors.push(`${label}: ${producer} symbols must not declare consumers`);
        }
        seen.set(entry.symbol, entry);
    }
    return seen;
}

function runWebviewManifestCheck(rootDirectory) {
    const errors = [];
    const manifest = readJson(rootDirectory, MANIFEST_PATH, errors);
    if (!manifest) { return { errors }; }
    if (manifest.version !== 3) {
        errors.push('webview-manifest: version must be 3 (direct-copy distribution, P0-A)');
    }
    const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];

    // Membership: exact-once over src/webview/*.js, and every entry exists.
    const membership = new Map();
    const webviewDirectory = path.join(rootDirectory, 'src', 'webview');
    const scriptsOnDisk = fs.readdirSync(webviewDirectory)
        .filter(name => name.endsWith('.js'))
        .map(name => `src/webview/${name}`)
        .sort();
    for (const bundle of bundles) {
        for (const script of bundle.scripts || []) {
            if (!fs.existsSync(path.join(rootDirectory, script))) {
                errors.push(`webview-manifest: bundle '${bundle.id}' lists ${script}, `
                    + 'which does not exist');
            }
            if (membership.has(script)) {
                errors.push(`webview-manifest: ${script} is in bundles '${membership.get(script)}' `
                    + `and '${bundle.id}' (membership is exact-once)`);
            }
            membership.set(script, bundle.id);
        }
    }
    for (const script of scriptsOnDisk) {
        if (!membership.has(script)) {
            errors.push(`webview-manifest: ${script} is not declared in any bundle`);
        }
    }

    // Load-order fidelity with the builders.
    const { builderOrder, viewerOrder } = checkBundleOrder(rootDirectory);
    for (const bundle of bundles) {
        if (bundle.id === 'dashboard') {
            if (JSON.stringify(bundle.scripts) !== JSON.stringify(builderOrder)) {
                errors.push('webview-manifest: dashboard bundle order differs from '
                    + `${BUNDLE_BUILDER} inputPaths`);
            }
        }
        if (bundle.id === 'conversation-viewer') {
            if (JSON.stringify(bundle.scripts) !== JSON.stringify(viewerOrder)) {
                errors.push('webview-manifest: conversation-viewer bundle order differs from '
                    + `${VIEWER_DOCUMENT} script emission order`);
            }
        }
    }

    // Direct-copy distribution (P0-A): fail closed so a new script can never
    // be added to a bundle without deciding how it ships.
    for (const bundle of bundles) {
        const label = `webview-manifest: bundle '${bundle.id}'`;
        const scripts = bundle.scripts || [];
        const bundledOnly = bundle.bundledOnly || [];
        if (!Array.isArray(bundledOnly)) {
            errors.push(`${label}: bundledOnly must be an array when present`);
            continue;
        }
        if (bundle.id === 'conversation-viewer' && bundledOnly.length > 0) {
            errors.push(`${label}: individually loaded bundles must keep bundledOnly empty`);
        }
        const directCopies = bundle.directCopies || {};
        if (typeof directCopies !== 'object'
            || directCopies === null
            || Array.isArray(directCopies)) {
            errors.push(`${label}: directCopies must be an object mapping source to output`);
            continue;
        }
        for (const script of bundledOnly) {
            if (!scripts.includes(script)) {
                errors.push(`${label}: bundledOnly entry ${script} is not a bundle member`);
            }
            if (directCopies[script] !== undefined) {
                errors.push(`${label}: ${script} is both bundledOnly and direct-copied`);
            }
        }
        for (const script of scripts) {
            if (!bundledOnly.includes(script) && directCopies[script] === undefined) {
                errors.push(`${label}: ${script} declares no directCopies entry — `
                    + 'declare its media output or mark it bundledOnly');
            }
        }
        for (const [source, output] of Object.entries(directCopies)) {
            if (!scripts.includes(source)) {
                errors.push(`${label}: directCopies key ${source} is not a bundle member`);
                continue;
            }
            // Basename-faithful targets are unique by construction: bundle
            // members all live in the flat src/webview/ directory.
            const expected = `media/${path.basename(source)}`;
            if (output !== expected) {
                errors.push(`${label}: directCopies ${source} must map to ${expected}`);
            }
        }
        if (bundle.output !== undefined) {
            if (typeof bundle.output !== 'string' || !bundle.output.startsWith('media/')) {
                errors.push(`${label}: output must be a media/ path`);
            } else if (bundle.id === 'dashboard') {
                const builderText = fs.readFileSync(
                    path.join(rootDirectory, BUNDLE_BUILDER), 'utf8');
                const segments = bundle.output.split('/');
                const written = segments.every(segment =>
                    builderText.includes(`'${segment}'`));
                if (!written) {
                    errors.push(`${label}: declared output ${bundle.output} is not written by `
                        + BUNDLE_BUILDER);
                }
            }
        }
    }

    // Symbol-level globals (review R7).
    const globalsBySymbol = validateGlobalsSchema(manifest, membership, rootDirectory, errors);
    const bundleIndex = new Map();
    for (const bundle of bundles) {
        (bundle.scripts || []).forEach((script, index) => bundleIndex.set(script, index));
    }
    const scriptGlobals = new Map([...globalsBySymbol]
        .filter(([, entry]) => !PRODUCER_KINDS.includes(entry.producer)));
    const declaredBareNames = new Set(
        [...scriptGlobals.keys()].map(symbol => symbol.slice('window.'.length)));

    const referencedSymbols = new Set();
    const actualReaders = new Map();
    const actualWriters = new Map();
    for (const script of scriptsOnDisk) {
        const analysis = analyzeScript(rootDirectory, script, declaredBareNames);
        for (const form of analysis.dynamicAccess) {
            errors.push(`webview-manifest: ${script} uses dynamic ${form} access, `
                + 'which evades the declared-global policy');
        }
        for (const bare of analysis.bareReferences) {
            errors.push(`webview-manifest: ${script} references the declared global `
                + `window.${bare} without the window./globalThis. prefix — bare globals evade `
                + 'the manifest policy');
        }
        for (const symbol of [...analysis.writes, ...analysis.reads]) {
            referencedSymbols.add(symbol);
        }
        for (const symbol of analysis.writes) {
            if (!actualWriters.has(symbol)) { actualWriters.set(symbol, new Set()); }
            actualWriters.get(symbol).add(script);
            const entry = globalsBySymbol.get(symbol);
            if (!entry) {
                errors.push(`webview-manifest: ${script} assigns undeclared global ${symbol}`
                    + ` — declare it in ${MANIFEST_PATH}`);
            } else if (PRODUCER_KINDS.includes(entry.producer)) {
                errors.push(`webview-manifest: ${script} assigns ${symbol}, which is declared as `
                    + `${entry.producer}-produced — a script must not spoof it`);
            } else if (entry.producer !== script) {
                errors.push(`webview-manifest: ${script} assigns ${symbol}, whose only declared `
                    + `producer is ${entry.producer}`);
            }
        }
        for (const symbol of analysis.reads) {
            if (!actualReaders.has(symbol)) { actualReaders.set(symbol, new Set()); }
            actualReaders.get(symbol).add(script);
            const entry = globalsBySymbol.get(symbol);
            if (!entry) {
                errors.push(`webview-manifest: ${script} references undeclared global `
                    + `${symbol} — declare it in ${MANIFEST_PATH}`);
                continue;
            }
            if (!PRODUCER_KINDS.includes(entry.producer)
                && entry.producer !== script
                && !(entry.consumers || []).includes(script)) {
                errors.push(`webview-manifest: ${script} reads ${symbol} but is neither its `
                    + 'producer nor a declared consumer');
            }
            if (!PRODUCER_KINDS.includes(entry.producer) && entry.producer !== script
                && analysis.loadTimeReads.has(symbol)) {
                const producerBundle = membership.get(entry.producer);
                const consumerBundle = membership.get(script);
                if (producerBundle && consumerBundle && producerBundle === consumerBundle
                    && bundleIndex.get(entry.producer) > bundleIndex.get(script)) {
                    errors.push(`webview-manifest: ${script} reads ${symbol} at load time but `
                        + `loads before its producer ${entry.producer} in the ${producerBundle} `
                        + 'bundle — defer the read or fix the load order');
                }
            }
        }
    }
    for (const [symbol, entry] of globalsBySymbol) {
        if (!referencedSymbols.has(symbol)) {
            errors.push(`webview-manifest: ${symbol} is declared but never referenced — stale entry`);
            continue;
        }
        if (PRODUCER_KINDS.includes(entry.producer)) { continue; }
        const writers = actualWriters.get(symbol) || new Set();
        if (!writers.has(entry.producer)) {
            errors.push(`webview-manifest: ${entry.producer} never assigns ${symbol} `
                + '— the declared producer must produce it');
        }
        const declaredConsumers = new Set(entry.consumers || []);
        const readers = new Set(actualReaders.get(symbol) || []);
        readers.delete(entry.producer);
        const missing = [...readers].filter(script => !declaredConsumers.has(script));
        const extra = [...declaredConsumers].filter(script => !readers.has(script)
            && script !== entry.producer);
        if (missing.length > 0) {
            errors.push(`webview-manifest: ${symbol} is read by undeclared consumer(s): `
                + missing.join(', '));
        }
        if (extra.length > 0) {
            errors.push(`webview-manifest: ${symbol} declares consumer(s) that never read it: `
                + extra.join(', '));
        }
    }
    return { errors };
}

function main() {
    const { errors } = runWebviewManifestCheck(path.resolve(__dirname, '..', '..'));
    if (errors.length > 0) {
        console.error('Webview manifest checks FAILED:');
        for (const error of errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
        return;
    }
    console.log('Webview manifest checks passed: exact-once membership, load-order '
        + 'fidelity with both builders, closed-world symbol-level globals, and '
        + 'fail-closed direct-copy distribution.');
}

if (require.main === module) { main(); }

module.exports = { MANIFEST_PATH, runWebviewManifestCheck };
