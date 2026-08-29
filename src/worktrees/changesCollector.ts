'use strict';

import { execFile } from 'child_process';
import type { MemberBaseline } from './types';

const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_STATUS_ENTRIES = 5_000;
const MAX_PATH_LENGTH = 4 * 1024;

/**
 * SCM-aligned working groups (changes-panel PRD §4.3): the four groups
 * Source Control shows, in its fixed order.
 */
export type WorkingChangeGroup = 'merge' | 'staged' | 'changes' | 'untracked';

export const WORKING_CHANGE_GROUP_ORDER: readonly WorkingChangeGroup[] = [
    'merge', 'staged', 'changes', 'untracked',
];

export interface WorkingChangeItem {
    group: WorkingChangeGroup;
    /** Two-letter porcelain XY code (e.g. 'MM'), or '??' for untracked. */
    xy: string;
    path: string;
    /** Rename source (porcelain -z emits to-path first, then from-path). */
    originalPath?: string;
}

export type MemberChangesAvailability =
  | 'available'
  | 'baselineUnavailable'
  | 'historyRewritten'
  | 'unreadable';

/**
 * Tracking-branch state (changes-panel PRD §14.1): `none` is the stated
 * fact "no upstream configured" (or a detached HEAD), `unknown` means the
 * fact query itself failed — unknown is never rendered as zero.
 */
export type MemberUpstreamState =
  | {
        status: 'tracked';
        /**
         * Upstream full ref (e.g. 'refs/remotes/origin/fix-x'). The field
         * carries only the full ref; the display short name ('origin/fix-x')
         * is derived by stripping the 'refs/remotes/' prefix in the webview
         * — the simplest side, since that is where rendering happens.
         */
        fullRef: string;
        /** Resolved sha of the upstream ref at collection time. */
        sha: string;
        ahead: number;
        behind: number;
    }
  | { status: 'none' }
  | { status: 'unknown' };

export interface MemberChangesSnapshot {
    availability: MemberChangesAvailability;
    /** Parsed working items (bounded by MAX_STATUS_ENTRIES per group). */
    workingItems: WorkingChangeItem[];
    /**
     * SCM resource-row count (changes-panel PRD §4.3): one file that is
     * both staged and unstaged counts twice — never call this "files".
     */
    workingItemCount: number;
    /** True when the raw status output hit the entry cap. */
    truncated: boolean;
    /** Commits on HEAD since the baseline; absent when unknown. */
    aheadCount?: number;
    /**
     * Task-result file count (changes-panel PRD §5.3): files whose net
     * content differs between the baseline and the current worktree
     * (committed + uncommitted + untracked — Task result ⊃ Working
     * changes, PRD §4.3). Absent when unknown.
     */
    taskFileCount?: number;
    /**
     * HEAD commit sha at collection time (changes-panel PRD §14.4);
     * absent when the member is unreadable or the rev-parse failed.
     */
    headSha?: string;
    /**
     * Current local branch short name. An empty string is the known detached
     * HEAD state; an absent value means the branch query itself failed.
     */
    branchName?: string;
    /**
     * Tracking-branch state (changes-panel PRD §14.1 three-state chain),
     * collected independently of the baseline; absent only when the
     * member is unreadable.
     */
    upstream?: MemberUpstreamState;
    collectedAt: number;
}

export type ExecGit = (
    args: string[],
    cwd: string
) => Promise<{ stdout: string; stderr: string }>;

export interface ChangesCollectorOptions {
    execGit?: ExecGit;
    now?: () => number;
    maxStatusEntries?: number;
}

function defaultExecGit(args: string[], cwd: string) {
    return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        execFile('git', args, {
            cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT_BYTES,
        }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;

/** Exit code of a failed git process, when the error carries one. */
function exitCode(error: unknown): number | undefined {
    if (error && typeof error === 'object'
        && typeof (error as { code?: unknown }).code === 'number') {
        return (error as { code: number }).code;
    }
    return undefined;
}

/**
 * Classifies one porcelain XY pair the way Source Control groups it
 * (changes-panel PRD §4.3): a file staged AND modified again appears in
 * both 'staged' and 'changes', matching the SCM resource model.
 */
export function classifyPorcelainXY(x: string, y: string): WorkingChangeGroup[] {
    if (x === '?' || y === '?') {
        return ['untracked'];
    }
    if (x === '!' || y === '!') {
        return [];
    }
    if (UNMERGED_XY.has(x + y)) {
        return ['merge'];
    }
    const groups: WorkingChangeGroup[] = [];
    if (x !== ' ' && x !== '.') {
        groups.push('staged');
    }
    if (y !== ' ' && y !== '.') {
        groups.push('changes');
    }
    return groups;
}

/**
 * Parses `git status --porcelain=v1 -z` output. The -z format is
 * unambiguous for spaces/newlines in paths; rename entries carry the
 * to-path first, then the from-path (the non-z `from -> to` order is
 * reversed under -z).
 */
export function parsePorcelainZ(input: string): { xy: string; path: string; originalPath?: string }[] {
    const entries: { xy: string; path: string; originalPath?: string }[] = [];
    const tokens = input.split('\0');
    let index = 0;
    while (index < tokens.length) {
        const record = tokens[index];
        index += 1;
        if (!record) {
            continue;
        }
        if (record.length < 4 || record[2] !== ' ') {
            // Malformed record: stop rather than guess at path boundaries.
            break;
        }
        const xy = record.slice(0, 2);
        const entryPath = record.slice(3);
        if (!entryPath || entryPath.length > MAX_PATH_LENGTH) {
            continue;
        }
        let originalPath: string | undefined;
        if (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C') {
            const from = tokens[index];
            index += 1;
            if (typeof from === 'string' && from
                && from.length <= MAX_PATH_LENGTH) {
                originalPath = from;
            }
        }
        entries.push({ xy, path: entryPath, ...(originalPath ? { originalPath } : {}) });
    }
    return entries;
}

/**
 * Collects one member worktree's change snapshot (changes-panel PRD
 * §4.3): working four-group status self-collected with
 * `--untracked-files=all` (independent of the user's SCM untracked
 * setting), plus the ahead count against the frozen baseline with an
 * ancestry check, plus the tracking-branch state (PRD §14.1) with the
 * HEAD sha. Git failures degrade to 'unreadable' — never throw,
 * never report unknown as zero.
 */
export class ChangesCollector {
    private readonly execGit: ExecGit;
    private readonly now: () => number;
    private readonly maxStatusEntries: number;

    constructor(options: ChangesCollectorOptions = {}) {
        this.execGit = options.execGit || defaultExecGit;
        this.now = options.now || Date.now;
        this.maxStatusEntries = options.maxStatusEntries ?? MAX_STATUS_ENTRIES;
    }

    async collect(
        worktreePath: string,
        baseline?: MemberBaseline
    ): Promise<MemberChangesSnapshot> {
        const collectedAt = this.now();
        let statusOutput: string;
        try {
            const result = await this.execGit([
                '-C', worktreePath,
                'status', '--porcelain=v1', '-z', '--untracked-files=all',
            ], worktreePath);
            statusOutput = result.stdout;
        } catch (_error) {
            return {
                availability: 'unreadable',
                workingItems: [],
                workingItemCount: 0,
                truncated: false,
                collectedAt,
            };
        }
        const parsed = parsePorcelainZ(statusOutput);
        const truncated = parsed.length > this.maxStatusEntries;
        const workingItems: WorkingChangeItem[] = [];
        for (const entry of parsed.slice(0, this.maxStatusEntries)) {
            for (const group of classifyPorcelainXY(entry.xy[0], entry.xy[1])) {
                workingItems.push({
                    group,
                    xy: entry.xy,
                    path: entry.path,
                    ...(entry.originalPath
                        ? { originalPath: entry.originalPath }
                        : {}),
                });
            }
        }
        const snapshot: MemberChangesSnapshot = {
            availability: baseline ? 'available' : 'baselineUnavailable',
            workingItems,
            workingItemCount: workingItems.length,
            truncated,
            collectedAt,
        };
        // Tracking state rides the same readability gate as the status
        // but is independent of the baseline (PRD §14.1): a member with
        // no recorded task start still reports its upstream facts.
        const tracking = await this.collectTracking(worktreePath);
        if (tracking.headSha !== undefined) {
            snapshot.headSha = tracking.headSha;
        }
        if (tracking.branchName !== undefined) {
            snapshot.branchName = tracking.branchName;
        }
        snapshot.upstream = tracking.upstream;
        if (!baseline) {
            return snapshot;
        }
        try {
            // merge-base --is-ancestor exits 1 (execFile rejects) when the
            // baseline is no longer an ancestor of HEAD.
            await this.execGit([
                '-C', worktreePath,
                'merge-base', '--is-ancestor', baseline.commitSha, 'HEAD',
            ], worktreePath);
        } catch (_error) {
            // Rebase / reset / unrelated history (PRD §4.2): the baseline
            // is no longer an ancestor — report it, never fake a count.
            snapshot.availability = 'historyRewritten';
            return snapshot;
        }
        try {
            const ahead = await this.execGit([
                '-C', worktreePath,
                'rev-list', '--count', `${baseline.commitSha}..HEAD`,
            ], worktreePath);
            const count = Number.parseInt(ahead.stdout.trim(), 10);
            if (Number.isSafeInteger(count) && count >= 0) {
                snapshot.aheadCount = count;
            }
        } catch (_error) {
            // ahead stays unknown; the aggregate layer renders '↑?'.
        }
        try {
            const diff = await this.execGit([
                '-C', worktreePath,
                'diff', '--name-only', '-z', baseline.commitSha,
            ], worktreePath);
            const others = await this.execGit([
                '-C', worktreePath,
                'ls-files', '--others', '--exclude-standard', '-z',
            ], worktreePath);
            // Task result ⊃ Working changes (PRD §4.3): the tracked diff
            // alone silently drops untracked files. Both listings must
            // succeed — a tracked-only count would fake completeness.
            const paths = new Set<string>();
            for (const output of [diff.stdout, others.stdout]) {
                for (const token of output.split('\0')) {
                    if (token && token.length <= MAX_PATH_LENGTH) {
                        paths.add(token);
                    }
                }
            }
            snapshot.taskFileCount = paths.size;
        } catch (_error) {
            // taskFileCount stays unknown; the task layer hides itself.
        }
        return snapshot;
    }

    /**
     * Tracking-branch fact chain (changes-panel PRD §14.1 附注): four
     * read-only queries, each independently degraded — a failure yields
     * 'unknown', never a faked count; a successful but empty upstream
     * query is the fact 'none'. headSha rides the step ③ rev-parse (HEAD
     * alone when no upstream ref exists) so every readable member reports
     * it. Never throws; ≤4 extra git processes per member.
     */
    private async collectTracking(
        worktreePath: string
    ): Promise<{
        branchName?: string;
        headSha?: string;
        upstream: MemberUpstreamState;
    }> {
        // ① Current branch ref. `symbolic-ref -q` exits 1 quietly on a
        // detached HEAD — that is the fact "no branch" (→ none), while a
        // genuine failure (timeout, git gone) degrades to unknown.
        let branchRef: string | undefined;
        let branchName: string | undefined;
        try {
            const symbolic = await this.execGit([
                '-C', worktreePath, 'symbolic-ref', '-q', 'HEAD',
            ], worktreePath);
            branchRef = symbolic.stdout.trim() || undefined;
            branchName = branchRef?.startsWith('refs/heads/')
                ? branchRef.slice('refs/heads/'.length)
                : undefined;
        } catch (error) {
            if (exitCode(error) !== 1) {
                return {
                    headSha: await this.revParseHead(worktreePath),
                    upstream: { status: 'unknown' },
                };
            }
            branchName = '';
        }
        // ② Upstream full ref for the branch; empty output = none.
        let fullRef: string | undefined;
        if (branchRef) {
            try {
                const refs = await this.execGit([
                    '-C', worktreePath,
                    'for-each-ref', '--format=%(upstream)', branchRef,
                ], worktreePath);
                fullRef = refs.stdout.trim() || undefined;
            } catch (_error) {
                return {
                    ...(branchName !== undefined ? { branchName } : {}),
                    headSha: await this.revParseHead(worktreePath),
                    upstream: { status: 'unknown' },
                };
            }
        }
        if (!fullRef) {
            return {
                ...(branchName !== undefined ? { branchName } : {}),
                headSha: await this.revParseHead(worktreePath),
                upstream: { status: 'none' },
            };
        }
        // ③ One rev-parse process resolves HEAD and the upstream sha.
        let headSha: string | undefined;
        let upstreamSha: string | undefined;
        try {
            const shas = await this.execGit([
                '-C', worktreePath, 'rev-parse', 'HEAD', fullRef,
            ], worktreePath);
            const lines = shas.stdout.split('\n')
                .map(line => line.trim()).filter(Boolean);
            headSha = FULL_SHA_PATTERN.test(lines[0] || '')
                ? lines[0] : undefined;
            upstreamSha = FULL_SHA_PATTERN.test(lines[1] || '')
                ? lines[1] : undefined;
        } catch (_error) {
            return {
                ...(branchName !== undefined ? { branchName } : {}),
                upstream: { status: 'unknown' },
            };
        }
        if (!headSha || !upstreamSha) {
            return {
                ...(branchName !== undefined ? { branchName } : {}),
                ...(headSha ? { headSha } : {}),
                upstream: { status: 'unknown' },
            };
        }
        // ④ Fork counts: left = behind, right = ahead (PRD §14.1 — the
        // order is easy to swap; the assertion message lives in tests).
        try {
            const counts = await this.execGit([
                '-C', worktreePath,
                'rev-list', '--left-right', '--count',
                `${upstreamSha}...${headSha}`,
            ], worktreePath);
            const match = /^(\d+)\t(\d+)$/u.exec(counts.stdout.trim());
            if (!match) {
                return {
                    ...(branchName !== undefined ? { branchName } : {}),
                    headSha,
                    upstream: { status: 'unknown' },
                };
            }
            return {
                ...(branchName !== undefined ? { branchName } : {}),
                headSha,
                upstream: {
                    status: 'tracked',
                    fullRef,
                    sha: upstreamSha,
                    ahead: Number.parseInt(match[2], 10),
                    behind: Number.parseInt(match[1], 10),
                },
            };
        } catch (_error) {
            return {
                ...(branchName !== undefined ? { branchName } : {}),
                headSha,
                upstream: { status: 'unknown' },
            };
        }
    }

    /** HEAD sha for members without a resolved upstream ref. */
    private async revParseHead(worktreePath: string): Promise<string | undefined> {
        try {
            const result = await this.execGit([
                '-C', worktreePath, 'rev-parse', 'HEAD',
            ], worktreePath);
            const sha = result.stdout.trim();
            return FULL_SHA_PATTERN.test(sha) ? sha : undefined;
        } catch (_error) {
            return undefined;
        }
    }
}

export type AggregateCompleteness = 'complete' | 'partial' | 'unavailable';

export interface ChangesAggregate {
    completeness: AggregateCompleteness;
    /** Sum of workingItemCount over readable members. */
    workingItemCount: number;
    /** True when ≥1 readable member exists but ≥1 is unreadable. */
    workingPartial: boolean;
    /** Sum of known ahead counts; undefined when none are known. */
    aheadCount?: number;
    /** True when ≥1 member has an unknown ahead (baseline missing etc.). */
    aheadPartial: boolean;
    /** True when every member is unreadable (retired / git gone). */
    allUnreadable: boolean;
}

/**
 * Cross-member aggregation (changes-panel PRD §4.3): unknown is never
 * rendered as zero — partial states surface as `3+`, `↑?`, `↑—` in the
 * UI layer.
 */
export function aggregateMemberChanges(
    members: readonly MemberChangesSnapshot[]
): ChangesAggregate {
    const readable = members.filter(member => member.availability !== 'unreadable');
    const unreadable = members.length - readable.length;
    const workingPartial = readable.length > 0 && unreadable > 0;
    const knownAhead = readable.filter(member =>
        member.availability === 'available' && member.aheadCount !== undefined);
    const aheadPartial = readable.some(member =>
        member.availability !== 'available' || member.aheadCount === undefined);
    return {
        completeness: readable.length === 0
            ? 'unavailable'
            : workingPartial || aheadPartial
                ? 'partial'
                : 'complete',
        workingItemCount: readable.reduce((sum, member) =>
            sum + member.workingItemCount, 0),
        workingPartial,
        aheadCount: knownAhead.length
            ? knownAhead.reduce((sum, member) => sum + (member.aheadCount ?? 0), 0)
            : undefined,
        aheadPartial,
        allUnreadable: members.length > 0 && readable.length === 0,
    };
}
