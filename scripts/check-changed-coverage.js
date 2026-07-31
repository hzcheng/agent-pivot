'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ELIGIBLE_CODE_PATH = /^(?:src|scripts|shared|extensions\/[^/]+\/src)\/.*\.(?:js|ts)$/;

function parseChangedLines(diff) {
    const changed = new Map();
    let file;
    let nextLine = 0;
    for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith('+++ ')) {
            file = line.startsWith('+++ b/') ? line.slice(6) : undefined;
            if (file && !changed.has(file)) {
                changed.set(file, new Set());
            }
            continue;
        }
        const hunk = line.match(
            /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
        );
        if (hunk) {
            nextLine = Number(hunk[1]);
            continue;
        }
        if (!file || line.startsWith('--- ')) {
            continue;
        }
        if (line.startsWith('+')) {
            changed.get(file).add(nextLine);
            nextLine += 1;
        } else if (!line.startsWith('-')) {
            nextLine += 1;
        }
    }
    return changed;
}

function relativeCoveragePath(root, coveragePath) {
    return path.relative(root, coveragePath).split(path.sep).join('/');
}

function collectChangedLineCoverage(root, coverage, changed) {
    const entries = new Map(Object.entries(coverage).map(([file, value]) => [
        relativeCoveragePath(root, file),
        value,
    ]));
    const missingFiles = [];
    const files = [];
    let total = 0;
    let covered = 0;
    for (const [file, changedLines] of changed) {
        if (!ELIGIBLE_CODE_PATH.test(file) || changedLines.size === 0) {
            continue;
        }
        const entry = entries.get(file);
        if (!entry) {
            missingFiles.push(file);
            continue;
        }
        const lineHits = new Map();
        for (const [id, location] of Object.entries(entry.statementMap || {})) {
            const line = location?.start?.line;
            if (!changedLines.has(line)) {
                continue;
            }
            lineHits.set(line, Math.max(
                lineHits.get(line) || 0,
                entry.s?.[id] || 0
            ));
        }
        const uncoveredLines = [...lineHits]
            .filter(([_line, hits]) => hits === 0)
            .map(([line]) => line)
            .sort((left, right) => left - right);
        const fileTotal = lineHits.size;
        const fileCovered = fileTotal - uncoveredLines.length;
        if (fileTotal > 0) {
            files.push({
                file,
                total: fileTotal,
                covered: fileCovered,
                uncoveredLines,
            });
            total += fileTotal;
            covered += fileCovered;
        }
    }
    return { total, covered, files, missingFiles };
}

function changedCoveragePercentage(result) {
    return result.total === 0 ? 100 : result.covered / result.total * 100;
}

function resolveDiffBase(root, environment = process.env) {
    const explicit = environment.COVERAGE_DIFF_BASE;
    const pullRequestBase = environment.GITHUB_BASE_REF
        ? `origin/${environment.GITHUB_BASE_REF}`
        : undefined;
    const candidates = [explicit, pullRequestBase, 'origin/main']
        .filter(Boolean);
    for (const candidate of candidates) {
        try {
            childProcess.execFileSync(
                'git',
                ['rev-parse', '--verify', `${candidate}^{commit}`],
                { cwd: root, stdio: 'ignore' }
            );
            const candidateSha = childProcess.execFileSync(
                'git',
                ['rev-parse', `${candidate}^{commit}`],
                { cwd: root, encoding: 'utf8' }
            ).trim();
            const headSha = childProcess.execFileSync(
                'git',
                ['rev-parse', 'HEAD^{commit}'],
                { cwd: root, encoding: 'utf8' }
            ).trim();
            let worktreeDiffers = false;
            try {
                childProcess.execFileSync(
                    'git',
                    ['diff', '--quiet', candidate, '--'],
                    { cwd: root, stdio: 'ignore' }
                );
            } catch (_error) {
                worktreeDiffers = true;
            }
            if (candidateSha !== headSha || worktreeDiffers
                || candidate === explicit
                || candidate === pullRequestBase) {
                return candidate;
            }
        } catch (_error) {
            // Try the next deterministic base candidate.
        }
    }
    childProcess.execFileSync(
        'git',
        ['rev-parse', '--verify', 'HEAD^^{commit}'],
        { cwd: root, stdio: 'ignore' }
    );
    return 'HEAD^';
}

function readThreshold(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.lines !== 'number'
        || !Number.isFinite(value.lines)
        || value.lines < 0
        || value.lines > 100) {
        throw new Error('changed coverage lines threshold must be between 0 and 100');
    }
    return value.lines;
}

function main(options = {}) {
    const root = options.root || path.resolve(__dirname, '..');
    const coveragePath = path.join(root, 'coverage', 'coverage-final.json');
    const thresholdPath = path.join(root, '.ci', 'changed-coverage.json');
    const coverage = options.coverage || JSON.parse(
        fs.readFileSync(coveragePath, 'utf8')
    );
    const threshold = options.threshold ?? readThreshold(JSON.parse(
        fs.readFileSync(thresholdPath, 'utf8')
    ));
    const base = options.base || resolveDiffBase(root);
    const diff = options.diff ?? childProcess.execFileSync(
        'git',
        ['diff', '--unified=0', '--no-color', base, '--'],
        { cwd: root, encoding: 'utf8' }
    );
    const logger = options.logger || console;
    const result = collectChangedLineCoverage(
        root,
        coverage,
        parseChangedLines(diff)
    );
    if (result.missingFiles.length > 0) {
        for (const file of result.missingFiles) {
            logger.error(`changed code is not instrumented: ${file}`);
        }
        return 1;
    }
    const percentage = changedCoveragePercentage(result);
    if (percentage + Number.EPSILON < threshold) {
        for (const file of result.files.filter(item =>
            item.uncoveredLines.length > 0
        )) {
            logger.error(
                `${file.file} uncovered changed lines: `
                + file.uncoveredLines.join(', ')
            );
        }
        logger.error(
            `changed line coverage ${percentage.toFixed(2)}% is below ${threshold.toFixed(2)}%`
        );
        return 1;
    }
    logger.log(
        `Changed line coverage checks passed: ${percentage.toFixed(2)}% `
        + `(${result.covered}/${result.total}) against ${base}.`
    );
    return 0;
}

if (require.main === module) {
    try {
        process.exitCode = main();
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

module.exports = {
    changedCoveragePercentage,
    collectChangedLineCoverage,
    main,
    parseChangedLines,
    readThreshold,
    relativeCoveragePath,
    resolveDiffBase,
};
