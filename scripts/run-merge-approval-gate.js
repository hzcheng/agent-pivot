'use strict';

// Posts the `merge-approval` commit status on a PR head after evaluating the
// owner approval comment and the change-impact declaration. Runs from the
// merge-approval-gate workflow on pull_request_target and issue_comment
// events: the workflow file and this script always come from the default
// branch, and the PR head is only ever read as data (round-2 review
// Blocker 1 — a PR must not approve itself by editing the gate). Fail-closed:
// unexpected errors exit non-zero without posting, so a broken gate blocks
// merges loudly instead of silently opening them.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { evaluateMergeApproval } = require('./lib/mergeApprovals');
const { evaluateChangeImpactDeclaration } = require('./lib/changeImpactDeclaration');
const { collectChangeImpactContext } = require('./lib/changeImpactContext');

const STATUS_CONTEXT = 'merge-approval';

function readEventPayload() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath) {
        throw new Error('GITHUB_EVENT_PATH is not set');
    }
    return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function resolvePullRequestNumber(payload) {
    if (payload.pull_request?.number) {
        return payload.pull_request.number;
    }
    // issue_comment events fire for plain issues too; only PRs carry this key.
    if (payload.issue?.pull_request && payload.issue.number) {
        return payload.issue.number;
    }
    return null;
}

async function api(token, method, resource, body) {
    const response = await fetch(`https://api.github.com${resource}`, {
        method,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
        throw new Error(`${method} ${resource} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}

async function listAllComments(token, repo, prNumber) {
    const comments = [];
    for (let page = 1; page <= 10; page += 1) {
        const batch = await api(
            token,
            'GET',
            `/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        );
        comments.push(...batch);
        if (batch.length < 100) {
            break;
        }
    }
    return comments;
}

function git(args) {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/**
 * Evaluate the PR body declaration against the regenerated impact report for
 * the exact head — without ever executing head code (round-2 review
 * Blocker 1). The head tree is materialized as a detached, read-only git
 * worktree used purely as data; the evaluator code itself comes from the
 * default-branch checkout (the workflow runs on pull_request_target).
 */
function evaluateDeclarationForPullRequest({ pullRequest, prNumber }) {
    const baseRefName = pullRequest.base?.ref;
    const headSha = pullRequest.head?.sha;
    if (!baseRefName || !headSha) {
        return ['PR is missing base/head information for the declaration check'];
    }
    git(['fetch', 'origin', baseRefName, `pull/${prNumber}/head`]);
    const worktreeDir = path.join(os.tmpdir(), `gate-head-${process.pid}`);
    try {
        git(['worktree', 'add', '--detach', worktreeDir, headSha]);
        const context = collectChangeImpactContext({
            rootDirectory: worktreeDir,
            baseRef: `origin/${baseRefName}`,
        });
        const { errors } = evaluateChangeImpactDeclaration({
            body: pullRequest.body || '',
            headSha,
            classification: context.classification,
            report: context.report,
            assignedCapabilities: context.assignedCapabilities,
            expectedBehaviors: context.expectedBehaviors,
        });
        return [...context.errors, ...errors];
    } finally {
        git(['worktree', 'remove', '--force', worktreeDir]);
    }
}

async function main() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) {
        throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    }
    const payload = readEventPayload();
    const prNumber = resolvePullRequestNumber(payload);
    if (!prNumber) {
        console.log('Not a pull request event; nothing to evaluate.');
        return;
    }
    const ownerLogin = repo.split('/')[0];

    const pullRequest = await api(token, 'GET', `/repos/${repo}/pulls/${prNumber}`);
    const headSha = pullRequest.head?.sha;
    if (!headSha) {
        throw new Error(`PR #${prNumber} has no head sha`);
    }

    const comments = await listAllComments(token, repo, prNumber);
    // Round-2 review Blocker 2: approval binds the exact head SHA, never the
    // committer clock — backdating a commit cannot launder a stale approval.
    const verdict = evaluateMergeApproval({
        comments,
        authorLogin: ownerLogin,
        headSha,
    });

    // Review R4 (charter 8.10): the PR body declaration is compared with the
    // regenerated architecture impact for the exact head being approved.
    // Git failures crash the job before posting, which blocks the merge
    // (fail-closed); declaration mismatches post a failure status.
    const declarationErrors = evaluateDeclarationForPullRequest({ pullRequest, prNumber });

    const reasons = [];
    if (!verdict.approved) { reasons.push(verdict.reason); }
    reasons.push(...declarationErrors.slice(0, 3));
    if (declarationErrors.length > 3) {
        reasons.push(`+${declarationErrors.length - 3} more declaration errors`);
    }
    const status = {
        context: STATUS_CONTEXT,
        state: verdict.approved && declarationErrors.length === 0 ? 'success' : 'failure',
        description: (reasons.join(' | ') || 'approved by owner comment').slice(0, 140),
        target_url: verdict.commentUrl || payload.comment?.html_url || undefined,
    };
    await api(token, 'POST', `/repos/${repo}/statuses/${headSha}`, status);
    console.log(`${STATUS_CONTEXT}: ${status.state} — ${status.description}`);
    // The verdict lives in the commit status, not this job's exit code: the
    // required check stays red until approval, while the workflow run itself
    // stays green (it computed and posted successfully). If we crash before
    // posting, the missing status still blocks the merge (fail-closed).
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
