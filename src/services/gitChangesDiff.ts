'use strict';

import { execFile } from 'child_process';
import { existsSync, realpathSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { WorkingChangeItem } from '../worktrees';

/**
 * Read-only git object content for diff editors (changes-panel PRD §5.3).
 * The scheme encodes {cwd, ref, path}; content is `git show <ref>:<path>`
 * (`:path` reads the index). Unknown objects resolve to empty content so
 * added/deleted files still render a one-sided diff.
 */
export const GIT_DIFF_CONTENT_SCHEME = 'agent-pivot-git-diff';

const GIT_SHOW_TIMEOUT_MS = 10_000;
const GIT_SHOW_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_FILES = 400;

interface GitContentQuery {
    cwd: string;
    ref: string;
    path: string;
}

function parseQuery(uri: vscode.Uri): GitContentQuery | undefined {
    try {
        const parsed = JSON.parse(uri.query) as GitContentQuery;
        if (typeof parsed.cwd !== 'string' || !parsed.cwd
            || typeof parsed.ref !== 'string'
            || typeof parsed.path !== 'string' || !parsed.path) {
            return undefined;
        }
        return parsed;
    } catch (_error) {
        return undefined;
    }
}

function gitShow(query: GitContentQuery): Promise<string> {
    if (query.ref === EMPTY_REF) {
        return Promise.resolve('');
    }
    const spec = query.ref ? `${query.ref}:${query.path}` : `:${query.path}`;
    return new Promise(resolve => {
        execFile('git', ['-C', query.cwd, 'show', spec], {
            cwd: query.cwd,
            timeout: GIT_SHOW_TIMEOUT_MS,
            maxBuffer: GIT_SHOW_MAX_OUTPUT_BYTES,
            encoding: 'utf8',
        }, (error, stdout) => {
            // Missing objects (added file absent from HEAD/index) resolve
            // to empty content so the diff opens one-sided.
            resolve(error ? '' : stdout);
        });
    });
}

/** Sentinel ref rendering an empty side for added/deleted one-sided diffs. */
const EMPTY_REF = '~empty~';

export class GitDiffContentProvider implements vscode.TextDocumentContentProvider {
    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const query = parseQuery(uri);
        if (!query) {
            return '';
        }
        return gitShow(query);
    }
}

export function registerGitDiffContentProvider(): vscode.Disposable {
    return vscode.workspace.registerTextDocumentContentProvider(
        GIT_DIFF_CONTENT_SCHEME, new GitDiffContentProvider());
}

function gitContentUri(cwd: string, ref: string, relativePath: string): vscode.Uri {
    return vscode.Uri.file(path.join(cwd, relativePath)).with({
        scheme: GIT_DIFF_CONTENT_SCHEME,
        query: JSON.stringify({ cwd, ref, path: relativePath }),
    });
}

function displayName(item: WorkingChangeItem): string {
    return item.originalPath
        ? `${item.originalPath} → ${item.path}`
        : item.path;
}

/**
 * Opens one working-change diff in the current window (changes-panel PRD
 * §5.3 点击行为矩阵), aligned with Source Control:
 * - unstaged: index ↔ working tree
 * - staged: HEAD ↔ index
 * - untracked: open the file itself
 * - conflict: open the file (merge editor is the SCM's own entry)
 */
export async function openWorkingChangeDiff(
    worktreePath: string,
    item: WorkingChangeItem
): Promise<void> {
    const fileUri = vscode.Uri.file(path.join(worktreePath, item.path));
    const pathIsMissingOrInsideWorktree = () => {
        if (!existsSync(fileUri.fsPath)) {
            return true;
        }
        const root = realpathSync(worktreePath);
        const candidate = realpathSync(fileUri.fsPath);
        const relative = path.relative(root, candidate);
        return relative === '' || (!relative.startsWith('..')
            && !path.isAbsolute(relative))
            ? true
            : false;
    };
    if (item.group === 'untracked' || item.group === 'merge') {
        if (!pathIsMissingOrInsideWorktree()) {
            return;
        }
        await vscode.commands.executeCommand('vscode.open', fileUri);
        return;
    }
    const isDeleted = item.group === 'changes'
        ? item.xy[1] === 'D'
        : item.xy[0] === 'D' && item.xy[1] !== 'D';
    const left = item.group === 'staged'
        ? gitContentUri(worktreePath, 'HEAD', item.originalPath || item.path)
        : gitContentUri(worktreePath, '', item.originalPath || item.path);
    const right = item.group === 'staged'
        ? gitContentUri(worktreePath, '', item.path)
        : fileUri;
    if (item.group !== 'staged' && !pathIsMissingOrInsideWorktree()) {
        return;
    }
    const rightSide = isDeleted
        ? gitContentUri(worktreePath, EMPTY_REF, item.path)
        : right;
    await vscode.commands.executeCommand(
        'vscode.diff', left, rightSide, displayName(item));
}

/**
 * "Review this repository" (changes-panel PRD §5.3): one multi-diff of
 * baseline → current worktree for the selected member. Capability
 * detection: workbenches without `vscode.changes` fall back to a per-file
 * list; the failure is logged, never swallowed silently.
 *
 * `vscode.changes` takes [label, original, modified] triples — the label
 * URI names the entry, original is the baseline side, modified the
 * worktree side. Anything else fails argument validation.
 */
export async function openTaskResultReview(
    worktreePath: string,
    baselineSha: string,
    title: string,
    onError?: (message: string, error: unknown) => void
): Promise<void> {
    const workingSideInsideWorktree = (file: string) => {
        const filePath = path.join(worktreePath, file);
        if (!existsSync(filePath)) {
            return gitContentUri(worktreePath, EMPTY_REF, file);
        }
        const root = realpathSync(worktreePath);
        const candidate = realpathSync(filePath);
        const relative = path.relative(root, candidate);
        const inside = relative === '' || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
        return inside
            ? vscode.Uri.file(filePath)
            : gitContentUri(worktreePath, EMPTY_REF, file);
    };
    const listFiles = (args: string[]) => new Promise<string[]>(
        (resolve, reject) => {
        execFile('git', ['-C', worktreePath, ...args], {
            cwd: worktreePath,
            timeout: GIT_SHOW_TIMEOUT_MS,
            maxBuffer: GIT_SHOW_MAX_OUTPUT_BYTES,
            encoding: 'utf8',
        }, (error, stdout) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(stdout.split('\0').filter(token => token));
        });
    });
    // Task result ⊃ Working changes (PRD §4.3): untracked files join the
    // tracked diff, otherwise files visible in Working changes would be
    // missing from the review.
    let tracked: string[];
    let untracked: string[];
    try {
        tracked = await listFiles(
            ['diff', '--name-only', '-z', baselineSha]);
        untracked = await listFiles(
            ['ls-files', '--others', '--exclude-standard', '-z']);
    } catch (error) {
        onError?.(
            'Task result review failed because Git could not list all files.',
            error);
        return;
    }
    const untrackedSet = new Set(untracked);
    const files = [...new Set([...tracked, ...untracked])]
        .slice(0, MAX_DIFF_FILES);
    if (!files.length) {
        return;
    }
    const resources: [vscode.Uri, vscode.Uri, vscode.Uri][] = files.map(file => {
        const fileUri = vscode.Uri.file(path.join(worktreePath, file));
        return [
            fileUri,
            // An untracked file has no baseline side: render it as an
            // empty original, like an added file.
            untrackedSet.has(file)
                ? gitContentUri(worktreePath, EMPTY_REF, file)
                : gitContentUri(worktreePath, baselineSha, file),
            // A deleted file has no working-tree document: render the
            // modified side as empty content instead of a missing file.
            workingSideInsideWorktree(file),
        ];
    });
    try {
        await vscode.commands.executeCommand('vscode.changes', title, resources);
    } catch (error) {
        onError?.(
            'vscode.changes failed; falling back to a per-file diff list.',
            error);
        // Per-file diff list (changes-panel PRD §5.3 capability fallback):
        // pick one file at a time, baseline → worktree.
        const picked = await vscode.window.showQuickPick(
            files.map((file, index) => ({ label: file, index })),
            { placeHolder: title }
        );
        if (!picked) {
            return;
        }
        const [, original, modified] = resources[picked.index];
        await vscode.commands.executeCommand(
            'vscode.diff', original, modified, picked.label);
    }
}
