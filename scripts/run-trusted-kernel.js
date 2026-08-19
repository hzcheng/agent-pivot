'use strict';

/**
 * Trusted kernel CLI entry point — materializes PR HEAD from git and
 * runs the trusted kernel evaluator. This file is not unit-tested; the
 * core logic lives in scripts/architecture/trustedKernel.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runKernel } = require('./architecture/trustedKernel');
const { architectureApprovalBoundSha } = require('./lib/mergeApprovals');

const ROOT = path.resolve(__dirname, '..');

function materializeHead(headRef, baseRef) {
    const headDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trusted-kernel-head-'));
    try {
        try {
            execFileSync('git', ['--git-dir', path.join(ROOT, '.git'), '--work-tree', headDir, 'checkout', headRef, '--', '.'], {
                cwd: ROOT, stdio: 'pipe',
            });
        } catch {
            // Fallback: use git archive + git show
            fs.mkdirSync(headDir, { recursive: true });
            try {
                // List all files in HEAD
                const headFiles = execFileSync('git', ['ls-tree', '-r', '--name-only', headRef], {
                    cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
                }).trim().split('\n').filter(Boolean);
                for (const file of headFiles) {
                    const fileDir = path.dirname(path.join(headDir, file));
                    fs.mkdirSync(fileDir, { recursive: true });
                    try {
                        const content = execFileSync('git', ['show', headRef + ':' + file], {
                            cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
                        });
                        fs.writeFileSync(path.join(headDir, file), content);
                    } catch { /* skip */ }
                }
            } catch (e) {
                return { headDir, error: 'failed to materialize PR HEAD: ' + e.message };
            }
        }
        return { headDir, error: null };
    } catch (e) {
        return { headDir, error: 'failed to materialize PR HEAD: ' + e.message };
    }
}

/**
 * The kernel consumes the owner's `approve-architecture <full-head-sha>`
 * comment directly from the PR (Harness Simplification decision: protected
 * path changes require architecture approval bound to the exact head).
 * Fail-closed: when the lookup cannot run (missing token/PR context), the
 * approval is treated as absent. `ARCHITECTURE_APPROVED=true` remains as a
 * local-development override.
 */
async function detectArchitectureApproval(headRef) {
    if (process.env.ARCHITECTURE_APPROVED === 'true') { return true; }
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    const prNumber = process.env.PR_NUMBER;
    if (!token || !repo || !prNumber) { return false; }
    const ownerLogin = repo.split('/')[0].toLowerCase();
    const expected = String(headRef || '').toLowerCase();
    for (let page = 1; page <= 10; page += 1) {
        const response = await fetch(
            `https://api.github.com/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
            {
                headers: {
                    Accept: 'application/vnd.github+json',
                    Authorization: `Bearer ${token}`,
                    'X-GitHub-Api-Version': '2022-11-28',
                },
            });
        if (!response.ok) { return false; }
        const batch = await response.json();
        for (const comment of batch) {
            if (String(comment?.user?.login || '').toLowerCase() !== ownerLogin) { continue; }
            if (architectureApprovalBoundSha(comment.body) === expected) { return true; }
        }
        if (batch.length < 100) { break; }
    }
    return false;
}

async function main() {
    const headRef = process.env.PR_HEAD_REF || 'HEAD';
    const baseRef = process.env.PR_BASE_REF || 'origin/main';
    const hasArchitectureApproval = await detectArchitectureApproval(headRef);

    const { headDir, error } = materializeHead(headRef, baseRef);
    try {
        if (error) {
            console.error('Trusted kernel FAILED: ' + error);
            process.exit(1);
        }
        const { errors } = runKernel({
            headDir, baseDir: ROOT, baseRef, headRef, hasArchitectureApproval,
        });
        if (errors.length > 0) {
            console.error('Trusted kernel FAILED:');
            for (const err of errors) console.error('  ✗ ' + err);
            process.exit(1);
        }
        console.log('Trusted kernel passed: all checks satisfied.');
    } finally {
        try { fs.rmSync(headDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('Trusted kernel FAILED: ' + (error instanceof Error ? error.message : String(error)));
        process.exit(1);
    });
}
