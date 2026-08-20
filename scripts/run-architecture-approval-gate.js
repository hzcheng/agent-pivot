'use strict';

/**
 * Architecture approval gate — checks that protected path changes have
 * an explicit `approve-architecture <full-head-sha>` owner comment.
 *
 * This is distinct from the standard merge approval (`approve <sha>`).
 * Standard approval cannot substitute for architecture approval.
 */

const { execFileSync } = require('child_process');
// The canonical protected-path list lives in the trusted kernel (Harness
// Simplification decision: one canonical truth, not two drifting copies).
const { PROTECTED_PATHS, isProtected } = require('./architecture/trustedKernel');

function main() {
    const headSha = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA;
    const baseRef = process.env.PR_BASE_REF || 'origin/main';

    if (!headSha) {
        console.error('Architecture approval gate: missing PR head SHA');
        process.exit(1);
    }

    // Check if any protected files changed. The workflow checks out the base
    // branch (pull_request_target), so the PR head is diffed via its fetched
    // SHA — diffing baseRef against HEAD would compare the base to itself.
    const changed = execFileSync('git', ['diff', '--name-only', baseRef, headSha], {
        encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    }).trim().split('\n').filter(Boolean);

    const protectedChanged = changed.filter(isProtected);

    if (protectedChanged.length === 0) {
        console.log('Architecture approval gate: no protected path changes; nothing to approve.');
        return;
    }

    // Check for architecture approval comment
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = process.env.PR_NUMBER;
    const token = process.env.GITHUB_TOKEN;

    if (!repo || !prNumber || !token) {
        console.error(`Architecture approval gate: ${protectedChanged.length} protected file(s) changed: ${protectedChanged.slice(0, 5).join(', ')}${protectedChanged.length > 5 ? '...' : ''}`);
        console.error(`Architecture approval gate: cannot verify approval (missing GITHUB_REPOSITORY/PR_NUMBER/GITHUB_TOKEN)`);
        console.error(`Comment 'approve-architecture ${headSha}' on the pull request to authorize.`);
        process.exit(1);
    }

    try {
        // Use gh CLI to check for architecture approval comment
        const comments = execFileSync('gh', [
            'api', `repos/${repo}/issues/${prNumber}/comments`,
            '--jq', '.[].body',
        ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).trim();

        const approved = comments.split('\n').some(line =>
            line.trim() === `approve-architecture ${headSha}`);

        if (approved) {
            console.log(`Architecture approval gate: owner approved architecture changes for ${headSha.substring(0, 8)}.`);
            return;
        }
    } catch (err) {
        console.error(`Architecture approval gate: error checking comments: ${err.message}`);
    }

    console.error(`Architecture approval gate: ${protectedChanged.length} protected file(s) changed without architecture approval.`);
    console.error('Protected files changed:');
    for (const file of protectedChanged.slice(0, 10)) {
        console.error(`  ${file}`);
    }
    if (protectedChanged.length > 10) {
        console.error(`  ... and ${protectedChanged.length - 10} more`);
    }
    console.error(`\nComment 'approve-architecture ${headSha}' on the pull request to authorize.`);
    console.error('Standard approval (approve <sha>) is not sufficient for architecture changes.');
    process.exit(1);
}

if (require.main === module) { main(); }

module.exports = { isProtected, PROTECTED_PATHS };
