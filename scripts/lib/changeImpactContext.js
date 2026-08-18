'use strict';

/**
 * Shared glue for the Change Impact Declaration (review R4): collects the
 * regenerated truth for a base..head range — the architecture impact report,
 * the gate classification, and the capability assignments recorded by the
 * main-capability audit. Consumed by the declaration generator (local) and
 * the merge-approval gate (CI). The caller ensures the working tree is
 * checked out at the head being evaluated.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const {
    collectArchitectureDiff,
    defaultGit,
} = require('../architecture/reportArchitectureDiff');
const { classifyArchitectureChange } = require('../architecture/checkArchitectureChange');

const CAPABILITY_AUDIT_PATH = 'docs/testing/main-capability-coverage.json';

function git(rootDirectory, args) {
    return execFileSync('git', args, { cwd: rootDirectory, encoding: 'utf8' }).trim();
}

/** Capability assignments for every commit in the range, from the audit file. */
function capabilityAssignments(rootDirectory, commits) {
    const auditPath = path.join(rootDirectory, CAPABILITY_AUDIT_PATH);
    if (!fs.existsSync(auditPath)) {
        return { assignedCapabilities: [], errors: [`${CAPABILITY_AUDIT_PATH} is missing at the PR head`] };
    }
    let audit;
    try {
        audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
    } catch (error) {
        return { assignedCapabilities: [], errors: [`${CAPABILITY_AUDIT_PATH} is not valid JSON (${error.message})`] };
    }
    const documentationCommits = new Set((audit.audit && audit.audit.ignoredDocumentationCommits) || []);
    const capabilityByCommit = new Map();
    for (const capability of audit.capabilities || []) {
        for (const sha of capability.commits || []) {
            capabilityByCommit.set(sha, capability.id);
        }
    }
    const assigned = new Set();
    const errors = [];
    for (const sha of commits) {
        if (documentationCommits.has(sha)) { continue; }
        const capability = capabilityByCommit.get(sha);
        if (!capability) {
            errors.push(`commit ${sha} is not assigned to any MAIN-* capability in`
                + ` ${CAPABILITY_AUDIT_PATH} — run scripts/regenerate-capability-audit.js`);
            continue;
        }
        assigned.add(capability);
    }
    return { assignedCapabilities: [...assigned].sort(), errors };
}

/**
 * collectChangeImpactContext({ rootDirectory, baseRef }) -> {
 *   headSha, report, classification, assignedCapabilities, errors,
 * }
 */
function collectChangeImpactContext({ rootDirectory, baseRef }) {
    const headSha = git(rootDirectory, ['rev-parse', 'HEAD']);
    const commits = git(rootDirectory, ['rev-list', '--no-merges', `${baseRef}..HEAD`])
        .split('\n').filter(Boolean);
    const report = collectArchitectureDiff({
        rootDirectory,
        baseRef,
        git: defaultGit(rootDirectory),
    });
    const { classification, errors: classificationErrors } = classifyArchitectureChange(report);
    const capabilities = capabilityAssignments(rootDirectory, commits);
    return {
        headSha,
        report,
        classification,
        assignedCapabilities: capabilities.assignedCapabilities,
        errors: [
            ...(report.errors || []),
            ...classificationErrors,
            ...capabilities.errors,
        ],
    };
}

module.exports = {
    CAPABILITY_AUDIT_PATH,
    capabilityAssignments,
    collectChangeImpactContext,
};
