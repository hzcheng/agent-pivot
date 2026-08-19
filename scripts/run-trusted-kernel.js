'use strict';

/**
 * Trusted kernel CLI entry point — materializes PR HEAD from git and
 * runs the trusted kernel evaluator. This file is not unit-tested; the
 * core logic lives in scripts/architecture/trustedKernel.js.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { runKernel, discoverFiles } = require('./architecture/trustedKernel');

const ROOT = path.resolve(__dirname, '..');

function materializeHead(headRef, baseRef) {
    const headDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'trusted-kernel-head-'));
    try {
        try {
            execFileSync('git', ['--git-dir', path.join(ROOT, '.git'), '--work-tree', headDir, 'checkout', headRef, '--', '.'], {
                cwd: ROOT, stdio: 'pipe',
            });
        } catch {
            fs.mkdirSync(headDir, { recursive: true });
            const changedFiles = execFileSync('git', ['diff', '--name-only', baseRef + '...' + headRef], {
                cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
            }).trim().split('\n').filter(Boolean);
            const allFiles = discoverFiles(ROOT);
            for (const file of allFiles) {
                const fileDir = path.dirname(path.join(headDir, file));
                fs.mkdirSync(fileDir, { recursive: true });
                if (changedFiles.includes(file)) {
                    try {
                        const c = execFileSync('git', ['show', headRef + ':' + file], {
                            cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
                        });
                        fs.writeFileSync(path.join(headDir, file), c);
                    } catch { /* deleted */ }
                } else {
                    fs.copyFileSync(path.join(ROOT, file), path.join(headDir, file));
                }
            }
            for (const dir of ['docs/testing', '.ci']) {
                fs.mkdirSync(path.join(headDir, dir), { recursive: true });
                try {
                    const pf = execFileSync('git', ['ls-tree', '-r', '--name-only', headRef, '--', dir], {
                        cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
                    }).trim().split('\n').filter(Boolean);
                    for (const p of pf) {
                        fs.mkdirSync(path.dirname(path.join(headDir, p)), { recursive: true });
                        try {
                            fs.writeFileSync(path.join(headDir, p),
                                execFileSync('git', ['show', headRef + ':' + p], {
                                    cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
                                }));
                        } catch { /* skip */ }
                    }
                } catch { /* skip */ }
            }
        }
        return { headDir, error: null };
    } catch (e) {
        return { headDir, error: 'failed to materialize PR HEAD: ' + e.message };
    }
}

function main() {
    const headRef = process.env.PR_HEAD_REF || 'HEAD';
    const baseRef = process.env.PR_BASE_REF || 'origin/main';
    const hasArchitectureApproval = process.env.ARCHITECTURE_APPROVED === 'true';

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

if (require.main === module) { main(); }
