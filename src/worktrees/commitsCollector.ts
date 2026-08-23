'use strict';

import { execFile } from 'child_process';
import type { ExecGit } from './changesCollector';

/**
 * Commit history collector for the Changes panel Commits tab
 * (changes-panel PRD §14.3): request/response lazy loading, kept off the
 * steady-state changes refresh path.
 *
 * Discipline:
 * - Frozen history head: the first page of a scope pins `historyHead`
 *   (HEAD at that moment); later pages must echo it, and a mismatch is
 *   reported as `history-moved` instead of serving a spliced list.
 * - since-start scope = `<baseline>..<historyHead>`; full scope = the
 *   baseline's ancestors (starting at the baseline itself, the webview
 *   dedupes by sha). No paging from HEAD for the full scope, so there is
 *   no empty page and no missing middle.
 * - Baseline missing / rewritten: a single `Current branch history`
 *   stream over `<historyHead>` — no synthetic Since-start boundary.
 * - Unknown is never rendered as zero: failures surface via `degraded`,
 *   never as an empty list.
 */

const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Page size 50; one extra row decides `hasMore` (PRD §14.3). */
const COMMITS_PAGE_SIZE = 50;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_SUBJECT_LENGTH = 1024;
const MAX_AUTHOR_LENGTH = 256;
const MAX_PATH_LENGTH = 4096;
/** Single-commit file detail cap, shared with the Review chain. */
export const MAX_COMMIT_DETAIL_FILES = 400;

export type CommitFileStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface CommitSummary {
    /** Full SHA; the UI renders the short 7-char form. */
    sha: string;
    subject: string;
    authorName: string;
    /** Author time, unix seconds (rebase-preserving). */
    authorTime: number;
    /** Only present when the member tracks an upstream (PRD §15.5). */
    inTrackingBranch?: boolean;
}

export interface CommitFile {
    path: string;
    /** Rename source path; renames only. */
    oldPath?: string;
    status: CommitFileStatus;
    /** Undefined for binary files (numstat reports '-'). */
    additions?: number;
    deletions?: number;
}

export interface BaselineRow {
    sha: string;
    /** Best-effort; absent when the subject query fails. */
    subject?: string;
}

export type CommitsDegraded =
    | 'unreadable'
    | 'timeout'
    | 'history-moved'
    | 'unknown-commit'
    | 'error';

export type CommitsScope = 'since-start' | 'full';

export interface CommitsListRequest {
    scope: CommitsScope;
    /** Non-negative row offset within the scope. */
    offset: number;
    /** Frozen HEAD sha from the scope's first page; later pages echo it. */
    historyHead?: string;
}

export interface CommitsListResult {
    commits: CommitSummary[];
    hasMore: boolean;
    historyHead: string;
    /** True only on the real last page of a baseline-bounded scope. */
    sectionComplete?: boolean;
    /** Rendered only together with sectionComplete (PRD §15.5.6). */
    baselineRow?: BaselineRow;
    degraded?: CommitsDegraded;
}

export interface CommitDetailResult {
    files: CommitFile[];
    totalFiles: number;
    filesTruncated: boolean;
    /** First parent; undefined for a root commit (diff sides key off it). */
    parentSha?: string;
    degraded?: CommitsDegraded;
}

export interface CommitsCollectorOptions {
    execGit?: ExecGit;
    now?: () => number;
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

function isTimeout(error: unknown): boolean {
    const candidate = error as { killed?: unknown; signal?: unknown };
    return !!candidate && typeof candidate === 'object'
        && (candidate.killed === true || typeof candidate.signal === 'string');
}

function toDegraded(error: unknown): CommitsDegraded {
    return isTimeout(error) ? 'timeout' : 'error';
}

export class CommitsCollector {
    private readonly execGit: ExecGit;

    constructor(options: CommitsCollectorOptions = {}) {
        this.execGit = options.execGit ?? defaultExecGit;
    }

    /**
     * One page of commit summaries. `baselineSha` is the member's frozen
     * baseline (undefined ⇒ single-stream history). `upstreamSha` is the
     * frozen upstream sha when tracking is 'tracked'; it drives the
     * per-row inTrackingBranch badge set.
     */
    async list(
        worktreePath: string,
        request: CommitsListRequest,
        baselineSha?: string,
        upstreamSha?: string
    ): Promise<CommitsListResult> {
        let head: string;
        try {
            const resolved = await this.execGit([
                '-C', worktreePath, 'rev-parse', 'HEAD',
            ], worktreePath);
            head = resolved.stdout.trim();
            if (!FULL_SHA_PATTERN.test(head)) {
                return {
                    commits: [], hasMore: false, historyHead: '',
                    degraded: 'error',
                };
            }
        } catch (error) {
            return {
                commits: [], hasMore: false, historyHead: '',
                degraded: toDegraded(error),
            };
        }
        if (request.historyHead && request.historyHead !== head) {
            // History moved mid-pagination: the webview discards paged
            // data and restarts the scope (PRD §14.3 失效纪律).
            return {
                commits: [], hasMore: false, historyHead: head,
                degraded: 'history-moved',
            };
        }
        const historyHead = head;
        const boundedBaseline = baselineSha
            && FULL_SHA_PATTERN.test(baselineSha)
            ? baselineSha
            : undefined;
        // Full scope without a baseline and a missing baseline both fall
        // back to the single stream over the frozen head (PRD §14.3).
        const range = boundedBaseline
            ? request.scope === 'since-start'
                ? `${boundedBaseline}..${historyHead}`
                : boundedBaseline
            : historyHead;
        const args = [
            '-C', worktreePath, 'log', '--no-decorate',
            '--format=%H%x00%s%x00%an%x00%at',
            `--max-count=${COMMITS_PAGE_SIZE + 1}`,
            `--skip=${Math.max(0, Math.min(request.offset, 1_000_000))}`,
            range,
        ];
        let rows: string[];
        try {
            const listed = await this.execGit(args, worktreePath);
            rows = listed.stdout.split('\n').filter(row => row);
        } catch (error) {
            return {
                commits: [], hasMore: false, historyHead,
                degraded: toDegraded(error),
            };
        }
        const hasMore = rows.length > COMMITS_PAGE_SIZE;
        const commits = rows.slice(0, COMMITS_PAGE_SIZE)
            .map(parseCommitRow)
            .filter((commit): commit is CommitSummary => !!commit);
        if (upstreamSha && FULL_SHA_PATTERN.test(upstreamSha)
            && commits.length) {
            await this.applyTrackingBadge(
                worktreePath, upstreamSha, historyHead, commits);
        }
        const result: CommitsListResult = { commits, hasMore, historyHead };
        if (boundedBaseline && request.scope === 'since-start' && !hasMore) {
            // The baseline closing row rides only the real last page —
            // rendering it mid-pagination would imply no gaps (PRD
            // §15.5.6).
            result.sectionComplete = true;
            result.baselineRow = {
                sha: boundedBaseline,
                ...(await this.baselineSubject(worktreePath, boundedBaseline)),
            };
        }
        return result;
    }

    /**
     * File detail for one commit: two diff-tree commands, because a single
     * command carrying both --name-status and --numstat silently drops
     * numstat (PRD §14.3). -M is mandatory: diff-tree is plumbing and
     * ignores diff.renames.
     */
    async detail(
        worktreePath: string,
        sha: string
    ): Promise<CommitDetailResult> {
        if (!FULL_SHA_PATTERN.test(sha)) {
            return {
                files: [], totalFiles: 0, filesTruncated: false,
                degraded: 'unknown-commit',
            };
        }
        if (!await this.commitExists(worktreePath, sha)) {
            return {
                files: [], totalFiles: 0, filesTruncated: false,
                degraded: 'unknown-commit',
            };
        }
        let parentSha: string | undefined;
        let isRoot = false;
        try {
            const parents = await this.execGit([
                '-C', worktreePath, 'rev-list', '--parents', '-n', '1', sha,
            ], worktreePath);
            const tokens = parents.stdout.trim().split(/\s+/).filter(Boolean);
            parentSha = tokens[1];
            isRoot = tokens.length === 1;
        } catch (error) {
            return {
                files: [], totalFiles: 0, filesTruncated: false,
                degraded: toDegraded(error),
            };
        }
        // Diff shape: an explicit two-tree diff against the first parent.
        // (`diff-tree -m --first-parent <merge>` still prints one section
        // per parent on git 2.51 — the PRD's anchor was misread — while
        // --first-parent alone prints nothing. The two-tree form is the
        // only one that is correct for merges AND plain commits.)
        const rangeArgs = isRoot ? ['--root', sha] : [parentSha!, sha];
        try {
            const [nameStatus, numstat] = await Promise.all([
                this.execGit([
                    '-C', worktreePath, 'diff-tree', '--no-commit-id',
                    '-r', '-z', '-M', '--name-status', ...rangeArgs,
                ], worktreePath),
                this.execGit([
                    '-C', worktreePath, 'diff-tree', '--no-commit-id',
                    '-r', '-z', '-M', '--numstat', ...rangeArgs,
                ], worktreePath),
            ]);
            const statuses = parseNameStatusZ(nameStatus.stdout);
            const stats = parseNumstatZ(numstat.stdout);
            const files: CommitFile[] = statuses.map(entry => {
                const stat = stats.get(entry.path);
                // Binary rows keep the counts absent, not undefined-
                // valued: the webview's exactKeys discipline rejects
                // undefined placeholders (PRD §14.3).
                return {
                    ...entry,
                    ...(stat?.additions !== undefined
                        ? { additions: stat.additions }
                        : {}),
                    ...(stat?.deletions !== undefined
                        ? { deletions: stat.deletions }
                        : {}),
                };
            });
            return {
                files: files.slice(0, MAX_COMMIT_DETAIL_FILES),
                totalFiles: files.length,
                filesTruncated: files.length > MAX_COMMIT_DETAIL_FILES,
                ...(parentSha ? { parentSha } : {}),
            };
        } catch (error) {
            return {
                files: [], totalFiles: 0, filesTruncated: false,
                ...(parentSha ? { parentSha } : {}),
                degraded: toDegraded(error),
            };
        }
    }

    /** cat-file -e guard before opening a diff/review (PRD §14.3). */
    async commitExists(worktreePath: string, sha: string): Promise<boolean> {
        if (!FULL_SHA_PATTERN.test(sha)) {
            return false;
        }
        try {
            await this.execGit([
                '-C', worktreePath, 'cat-file', '-e', sha,
            ], worktreePath);
            return true;
        } catch (_error) {
            return false;
        }
    }

    /** SHAs in HEAD but not in the upstream: badge set complement. */
    private async applyTrackingBadge(
        worktreePath: string,
        upstreamSha: string,
        historyHead: string,
        commits: CommitSummary[]
    ): Promise<void> {
        try {
            const notInTracking = await this.execGit([
                '-C', worktreePath, 'rev-list',
                `${upstreamSha}..${historyHead}`,
            ], worktreePath);
            const pending = new Set(notInTracking.stdout.split('\n')
                .map(line => line.trim()).filter(Boolean));
            for (const commit of commits) {
                commit.inTrackingBranch = !pending.has(commit.sha);
            }
        } catch (_error) {
            // Badge collection degrades independently: rows render
            // without a badge rather than failing the page (PRD §15.5.2).
        }
    }

    private async baselineSubject(
        worktreePath: string,
        baselineSha: string
    ): Promise<{ subject?: string }> {
        try {
            const result = await this.execGit([
                '-C', worktreePath, 'log', '-1', '--format=%s', baselineSha,
            ], worktreePath);
            const subject = result.stdout.trim();
            return subject ? { subject } : {};
        } catch (_error) {
            return {};
        }
    }
}

function parseCommitRow(row: string): CommitSummary | undefined {
    const fields = row.split('\0');
    if (fields.length < 4 || !FULL_SHA_PATTERN.test(fields[0])) {
        return undefined;
    }
    const authorTime = Number.parseInt(fields[3], 10);
    return {
        sha: fields[0],
        subject: fields[1].slice(0, MAX_SUBJECT_LENGTH),
        authorName: fields[2].slice(0, MAX_AUTHOR_LENGTH),
        authorTime: Number.isSafeInteger(authorTime) ? authorTime : 0,
    };
}

/**
 * Parses `diff-tree -z --name-status`: records are NUL-separated, and a
 * rename/copy record is `<status>\0<oldPath>\0<newPath>\0` — old first,
 * the reverse of porcelain status -z (PRD §14.3).
 */
export function parseNameStatusZ(input: string): CommitFile[] {
    const tokens = input.split('\0');
    const files: CommitFile[] = [];
    let index = 0;
    while (index < tokens.length) {
        const status = tokens[index];
        if (!status) {
            index += 1;
            continue;
        }
        const letter = status[0] as CommitFileStatus;
        if (letter === 'R' || letter === 'C') {
            const oldPath = tokens[index + 1];
            const newPath = tokens[index + 2];
            index += 3;
            if (!oldPath || !newPath
                || oldPath.length > MAX_PATH_LENGTH
                || newPath.length > MAX_PATH_LENGTH) {
                continue;
            }
            files.push({ path: newPath, oldPath, status: letter });
            continue;
        }
        const filePath = tokens[index + 1];
        index += 2;
        if (!filePath || filePath.length > MAX_PATH_LENGTH) {
            continue;
        }
        files.push({ path: filePath, status: letter });
    }
    return files;
}

/**
 * Parses `diff-tree -z --numstat`, keyed by the (new) path. Binary files
 * report '-' and keep additions/deletions undefined (PRD §14.3).
 */
export function parseNumstatZ(
    input: string
): Map<string, { additions?: number; deletions?: number }> {
    const tokens = input.split('\0');
    const stats = new Map<string, { additions?: number; deletions?: number }>();
    let index = 0;
    while (index < tokens.length) {
        const head = tokens[index];
        if (!head) {
            index += 1;
            continue;
        }
        const columns = head.split('\t');
        if (columns.length < 3) {
            index += 1;
            continue;
        }
        const additions = columns[0] === '-'
            ? undefined : Number.parseInt(columns[0], 10);
        const deletions = columns[1] === '-'
            ? undefined : Number.parseInt(columns[1], 10);
        // A rename numstat record carries an empty third column followed
        // by old and new paths (old first).
        if (columns[2] === '') {
            const newPath = tokens[index + 2];
            index += 3;
            if (newPath) {
                stats.set(newPath, { additions, deletions });
            }
            continue;
        }
        stats.set(columns.slice(2).join('\t'), { additions, deletions });
        index += 1;
    }
    return stats;
}
