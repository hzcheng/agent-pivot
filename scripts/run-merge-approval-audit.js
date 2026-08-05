'use strict';

// Post-merge audit (L3): every PR merged into main since the gate activated
// must carry an owner approval comment. The gate (L2) enforces the timing at
// merge time; this audit is the backstop that the marker exists at all, so
// protection changes or bypasses surface as a red main branch.

const { isApprovalComment, mergeRequiresApproval } = require('./lib/mergeApprovals');

const RECENT_MERGES_TO_AUDIT = 5;

async function api(token, resource) {
    const response = await fetch(`https://api.github.com${resource}`, {
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!response.ok) {
        throw new Error(`GET ${resource} failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
}

async function main() {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const repo = process.env.GITHUB_REPOSITORY;
    if (!token || !repo) {
        throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required');
    }
    const ownerLogin = repo.split('/')[0].toLowerCase();

    const closed = await api(
        token,
        `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`,
    );
    const merged = closed
        .filter(pr => pr.merged_at && pr.base?.ref === 'main' && mergeRequiresApproval(pr.merged_at))
        .slice(0, RECENT_MERGES_TO_AUDIT);
    if (!merged.length) {
        console.log('No gated merges to audit yet.');
        return;
    }

    const violations = [];
    for (const pr of merged) {
        const comments = await api(token, `/repos/${repo}/issues/${pr.number}/comments?per_page=100`);
        const approved = comments.some(comment =>
            String(comment?.user?.login || '').toLowerCase() === ownerLogin
            && isApprovalComment(comment.body));
        if (!approved) {
            violations.push(`#${pr.number} (${pr.title}) merged at ${pr.merged_at} without an owner approval comment`);
        } else {
            console.log(`#${pr.number}: approval marker present`);
        }
    }
    if (violations.length) {
        for (const violation of violations) {
            console.error(`MISSING APPROVAL: ${violation}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(`Merge approval audit passed for ${merged.length} merged PR(s).`);
}

main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
