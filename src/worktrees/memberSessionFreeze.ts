'use strict';

import {
    isWorkspaceHostPathContained,
    normalizeWorkspaceHostPath,
} from '../sessionAssignment';

/**
 * Member-freeze rule for worktree deletion (MOD-WORKTREE-LIFECYCLE): a
 * session is frozen into the member's deletion snapshot when its working
 * directory lies inside the member's canonical worktree path. Unavailable
 * providers contribute nothing. Structural session/read types keep the
 * worktree domain free of AI-session imports (ARCH-SESSION-WORKTREE-001).
 *
 * Extracted from the composition root (dashboard.ts) during the shell
 * decomposition; behavior is byte-identical.
 */
export interface FrozenMemberSession {
    provider: string;
    sessionId: string;
}

export interface MemberSessionFreezeDeps {
    getResults: (input: { candidatePaths: string[]; reason: string }) => Record<string, {
        available?: boolean;
        sessions: readonly { id: string; cwd?: string }[];
    }>;
}

export function createMemberSessionFreeze(
    deps: MemberSessionFreezeDeps
): (member: {
    worktreeKey?: { repositoryKey: string; canonicalWorktreePath: string };
    path: string;
}) => Promise<FrozenMemberSession[]> {
    return async member => {
        const memberPath = normalizeWorkspaceHostPath(
            member.worktreeKey?.canonicalWorktreePath || member.path);
        if (!memberPath) {
            return [];
        }
        const results = deps.getResults({
            candidatePaths: [member.path],
            reason: 'worktree-deletion-snapshot',
        });
        const frozen: FrozenMemberSession[] = [];
        for (const [providerId, result] of Object.entries(results)) {
            if (!result.available) {
                continue;
            }
            for (const session of result.sessions) {
                const cwd = normalizeWorkspaceHostPath(session.cwd || '');
                if (cwd && isWorkspaceHostPathContained(memberPath, cwd)) {
                    frozen.push({ provider: providerId, sessionId: session.id });
                }
            }
        }
        return frozen;
    };
}
