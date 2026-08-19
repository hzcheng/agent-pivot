'use strict';

// Post-merge audit (L3): every PR merged into main since the gate activated
// must carry an owner approval comment. The gate (L2) enforces the timing at
// merge time; this audit is the backstop that the marker exists at all, so
// protection changes or bypasses surface as a red main branch.

const { approvalBoundSha, isApprovalComment, mergeRequiresApproval } = require('./lib/mergeApprovals');

const RECENT_MERGES_TO_AUDIT = 5;
// The merged head's tree decides the rule: presence of approvalBoundSha in
// scripts/lib/mergeApprovals.js means the merge was gated by the SHA-bound
// gate (round-2 review Blocker 2), so the approval must bind the merged head.
const SHA_BINDING_MARKER = 'approvalBoundSha';

async function api(token, resource, options = {}) {
    const response = await fetch(`https://api.github.com${resource}`, {
        headers: {
            Accept: options.raw ? 'application/vnd.github.raw' : 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });
    if (!response.ok) {
        throw new Error(`GET ${resource} failed: ${response.status} ${await response.text()}`);
    }
    return options.raw ? response.text() : response.json();
}

/** The head SHA a merge commit pulled in: the merge commit's second parent. */
async function mergedHeadSha(token, repo, mergeCommitSha) {
    const commit = await api(token, `/repos/${repo}/commits/${mergeCommitSha}`);
    const parents = commit.parents || [];
    return parents.length > 1 ? parents[1].sha : null;
}

/** Whether the merged tree carries the SHA-binding gate. */
async function treeHasShaBinding(token, repo, ref) {
    try {
        const content = await api(
            token,
            `/repos/${repo}/contents/scripts/lib/mergeApprovals.js?ref=${ref}`,
            { raw: true },
        );
        return content.includes(SHA_BINDING_MARKER);
    } catch {
        return false;
    }
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
        const headSha = await mergedHeadSha(token, repo, pr.merge_commit_sha);
        const shaBound = headSha ? await treeHasShaBinding(token, repo, headSha) : false;
        const approved = comments.some(comment => {
            if (String(comment?.user?.login || '').toLowerCase() !== ownerLogin) { return false; }
            if (shaBound) {
                return headSha !== null && approvalBoundSha(comment.body) === headSha.toLowerCase();
            }
            return isApprovalComment(comment.body);
        });
        if (!approved) {
            violations.push(`#${pr.number} (${pr.title}) merged at ${pr.merged_at} without `
                + (shaBound ? `an owner approval bound to the merged head ${headSha}`
                    : 'an owner approval comment'));
        } else {
            console.log(`#${pr.number}: approval marker present${shaBound ? ' (SHA-bound)' : ''}`);
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
