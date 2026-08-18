#!/usr/bin/env node
'use strict';

/**
 * Generates the ```change-impact-declaration block for the current head
 * (review R4; charter 8.10). Run this right before pushing a pull request
 * and paste the block into the PR body. The declaration binds the head SHA:
 * regenerate it whenever the head moves, otherwise the merge-approval gate
 * rejects it as stale.
 *
 * Every new classified file is emitted with an empty reason placeholder —
 * fill each one with why the file belongs to its module before pasting; the
 * gate rejects empty reasons.
 *
 * Usage: node scripts/generate-change-impact-declaration.js [base-ref]
 */

const path = require('path');
const { collectChangeImpactContext } = require('./lib/changeImpactContext');

function buildDeclaration({ rootDirectory, baseRef }) {
    const context = collectChangeImpactContext({ rootDirectory, baseRef });
    const declaration = {
        headSha: context.headSha,
        capabilities: context.assignedCapabilities,
        modules: Object.keys(context.report.touchedModules).sort(),
        invariants: context.report.changedInvariantIds || [],
        policyDelta: context.classification,
        baselineWaiverDelta: (context.report.protectedTouched || [])
            .some(file => file.endsWith('architecture-debt-baseline.json')
                || file.endsWith('architecture-waivers.json'))
            ? 'changed'
            : 'zero',
        newFiles: (context.report.newClassifiedFiles || [])
            .map(entry => ({ path: entry.path, module: entry.module, reason: '' })),
    };
    const block = '```change-impact-declaration\n'
        + `${JSON.stringify(declaration, null, 2)}\n`
        + '```';
    return { block, declaration, context };
}

function main() {
    const baseRef = process.argv[2] || process.env.COVERAGE_DIFF_BASE
        || (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`)
        || 'origin/main';
    const rootDirectory = path.resolve(__dirname, '..');
    const { block, declaration, context } = buildDeclaration({ rootDirectory, baseRef });

    console.log(block);

    if (declaration.newFiles.length > 0) {
        console.error('\nFill every empty newFiles reason before pasting — the gate rejects empty reasons.');
    }
    if (context.errors.length > 0) {
        console.error('\nResolve these issues before publishing:');
        for (const error of context.errors) { console.error(`  ✗ ${error}`); }
        process.exitCode = 1;
    }
}

if (require.main === module) { main(); }

module.exports = { buildDeclaration };
