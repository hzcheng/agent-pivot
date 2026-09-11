'use strict';

import * as path from 'path';
import * as fs from 'fs/promises';
import { constants } from 'fs';
import { renderConversationMarkdown } from '../aiSessions/conversation/markdown';
import type { ConversationSessionOpenTarget, MarkdownReviewOpenResult } from '../aiSessions/conversation/composition';
import type { ConversationWorkspaceFileTarget } from '../aiSessions/conversation/markdown';

interface LocalFileReviewOptions {
    confirm(file: string, editable: boolean): Promise<boolean>;
    preview(file: string, markdown: string, line: number, column: number): Promise<void>;
    openNative(file: string, line: number, column: number): Promise<void>;
    inform(message: string): unknown;
    log(error: unknown): void;
}

/** Consent is scoped to one canonical pathname, never its directory.
 * Native editors own subsequent pathname resolution; Markdown uses a checked file handle. */
export class LocalFileReviewController {
    constructor(private readonly options: LocalFileReviewOptions) {}

    async openRelative(target: { relativePath: string; line: number; column: number }, roots: string[], current: () => boolean): Promise<void> {
        for (const root of roots) {
            if (!current()) { return; }
            try {
                const canonicalRoot = await fs.realpath(root);
                const file = await fs.realpath(path.resolve(canonicalRoot, target.relativePath));
                const relative = path.relative(canonicalRoot, file);
                if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { continue; }
                await this.open({ fsPath: file, line: target.line, column: target.column }, [canonicalRoot], current, false);
                return;
            } catch (_error) { /* Try the next compatibility root, without granting external access. */ }
        }
        if (current()) { this.options.inform('The linked file could not be found inside its workspace.'); }
    }

    async open(target: { fsPath: string; line: number; column: number }, roots: string[], current: () => boolean, allowExternal = true, nativeOnly = false): Promise<void> {
        try {
            const file = await fs.realpath(target.fsPath);
            const initial = await fs.stat(file);
            if (!initial.isFile()) { throw new Error('Not a regular file'); }
            let trusted = false;
            for (const root of roots) {
                try {
                    const relative = path.relative(await fs.realpath(root), file);
                    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) { trusted = true; }
                } catch (_error) { /* A removed workspace root grants no access. */ }
            }
            if (!current()) { return; }
            if (!trusted && !allowExternal) { throw new Error('Relative link leaves its workspace'); }
            if (!trusted && !await this.options.confirm(file, nativeOnly)) { return; }
            if (!current()) { return; }
            const latest = await fs.stat(file);
            if (await fs.realpath(target.fsPath) !== file || !latest.isFile()
                || latest.dev !== initial.dev || latest.ino !== initial.ino || latest.mtimeMs !== initial.mtimeMs || latest.size !== initial.size) {
                throw new Error('File changed while confirming access');
            }
            if (!trusted && !nativeOnly && file.toLowerCase().endsWith('.md')) {
                if (latest.size > 2 * 1024 * 1024) { throw new Error('Markdown file exceeds 2 MiB'); }
                const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
                let markdown: string;
                try {
                    const before = await handle.stat();
                    if (!before.isFile() || before.dev !== latest.dev || before.ino !== latest.ino
                        || await fs.realpath(file) !== file) { throw new Error('File changed before reading'); }
                    const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
                    let total = 0;
                    while (total < buffer.length) {
                        const read = await handle.read(buffer, total, buffer.length - total, total);
                        if (!read.bytesRead) { break; }
                        total += read.bytesRead;
                    }
                    const after = await handle.stat();
                    if (total > 2 * 1024 * 1024 || before.mtimeMs !== after.mtimeMs || before.size !== after.size
                        || before.mtimeMs !== latest.mtimeMs || before.size !== latest.size) { throw new Error('File changed or exceeds 2 MiB'); }
                    markdown = buffer.subarray(0, total).toString('utf8');
                } finally { await handle.close(); }
                if (current()) { await this.options.preview(file, markdown, target.line, target.column); }
            } else if (current()) {
                await this.options.openNative(file, target.line, target.column);
            }
        } catch (error) {
            this.options.log(error);
            if (current()) { this.options.inform('The linked file could not be opened. It may be missing, inaccessible, changed, or too large. See Agent Pivot output for details.'); }
        }
    }
}

/** Isolated rendered preview: no comment store, AI dispatch, or write messages. */
export function buildReadOnlyMarkdownPreview(file: string, markdown: string, assets: {
    nonce: string; csp: string; css: string; katex: string; purify: string; mermaidRuntime: string; mermaid: string;
}, line = 1, column = 1): string {
    const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
    const html = renderConversationMarkdown(markdown);
    if (Buffer.byteLength(html, 'utf8') > 8 * 1024 * 1024) { throw new Error('Rendered Markdown exceeds 8 MiB'); }
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(assets.csp)} 'unsafe-inline'; script-src 'nonce-${escape(assets.nonce)}'; img-src data: blob:; font-src ${escape(assets.csp)};">
<link rel="stylesheet" href="${escape(assets.css)}">
<link rel="stylesheet" href="${escape(assets.katex)}">
<style nonce="${escape(assets.nonce)}">body{display:block;overflow:auto;padding:16px;font-family:var(--vscode-font-family,sans-serif);line-height:1.6}header{margin-bottom:16px;overflow-wrap:anywhere}main{max-width:58rem;margin:auto}.conversation-markdown{overflow-wrap:anywhere}</style>
</head><body data-mermaid-source="${escape(assets.mermaid)}"><header><strong>${escape(path.basename(file))}</strong><div>Read-only · Outside workspace</div><details><summary>File location</summary>${escape(file)}</details><button type="button" data-open-source>Open editable source at line ${line}, column ${column}</button></header>
<main class="conversation-markdown">${html}</main>
<script nonce="${escape(assets.nonce)}">window.__agentPivotConversation={};</script>
<script nonce="${escape(assets.nonce)}" src="${escape(assets.purify)}"></script>
<script nonce="${escape(assets.nonce)}" src="${escape(assets.mermaidRuntime)}"></script>
<script nonce="${escape(assets.nonce)}">(function(){
var api=acquireVsCodeApi();
document.querySelectorAll('main button').forEach(function(button){button.remove();});
document.querySelector('[data-open-source]').addEventListener('click',function(){api.postMessage({type:'open-source'});});
document.addEventListener('click',function(e){var a=e.target.closest('a');if(a){e.preventDefault();api.postMessage({type:'open-link',href:a.getAttribute('href')});}});
var renderer=window.__agentPivotConversation.mermaid.create({messages:document.querySelector('main'),scroll:document.scrollingElement,source:document.body.dataset.mermaidSource,nonce:document.currentScript.nonce,maxDiagrams:20,captureAnchor:function(){return null;},restoreAnchor:function(){}});
renderer.render();
})();</script></body></html>`;
}

/** Canonical paths must share a root without crossing a nested repository. */
export async function isSameMarkdownReviewWorktree(
    root: string, file: string, hasGitBoundary: (directory: string) => Promise<boolean>
): Promise<boolean> {
    const relative = path.relative(root, file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { return false; }
    let directory = path.dirname(file);
    while (directory !== root) {
        if (await hasGitBoundary(directory)) { return false; }
        const parent = path.dirname(directory);
        if (parent === directory) { return false; }
        directory = parent;
    }
    return true;
}

export interface MarkdownReviewCandidate {
    target: ConversationSessionOpenTarget;
    file: ConversationWorkspaceFileTarget;
    label: string;
    description: string;
    preferred: boolean;
}

export interface MarkdownReviewDocument {
    fsPath: string;
    readonly isDirty: boolean;
    save(): PromiseLike<boolean>;
    position(): { line: number; column: number; selectionText?: string };
}

export interface MarkdownReviewCommandOptions {
    getDocument(resource?: unknown): Promise<MarkdownReviewDocument | undefined>;
    confirmSave(): Promise<boolean>;
    candidates(fsPath: string): Promise<MarkdownReviewCandidate[]>;
    choose(candidates: MarkdownReviewCandidate[]): Promise<MarkdownReviewCandidate | undefined>;
    open(candidate: MarkdownReviewCandidate, isCurrent: () => boolean): Promise<MarkdownReviewOpenResult>;
    reportFailure?(stage: string, error?: unknown): void;
    inform(message: string): unknown;
}

/** A command never creates a session, saves silently, or guesses another root. */
export class MarkdownReviewCommandController {
    private generation = 0;

    constructor(private readonly options: MarkdownReviewCommandOptions) {}

    async review(resource?: unknown): Promise<void> {
        const generation = ++this.generation;
        const current = () => this.generation === generation;
        const document = await this.options.getDocument(resource);
        if (!current()) { return; }
        if (!document || !document.fsPath.toLowerCase().endsWith('.md')) {
            this.options.inform('Open a saved Markdown (.md) file to review it in AI Conversation.');
            return;
        }
        if (document.isDirty) {
            const approved = await this.options.confirmSave();
            if (!current() || !approved) { return; }
            if (!await document.save() || document.isDirty) {
                this.options.inform('The document was not saved. Review was not opened with an older disk version.');
                return;
            }
        }
        if (!current()) { return; }
        const position = document.position();
        const candidates = await this.options.candidates(document.fsPath);
        if (!current()) { return; }
        if (!candidates.length) {
            this.options.inform('No AI session is associated with this file’s worktree. Open or start a session in that worktree, then review this document again.');
            return;
        }
        const preferred = candidates.filter(candidate => candidate.preferred);
        const selected = preferred.length === 1 ? preferred[0]
            : candidates.length === 1 ? candidates[0] : await this.options.choose(candidates);
        if (!current() || !selected) { return; }
        if (document.isDirty) {
            this.options.inform('The document changed while choosing a session. Save it and reopen review.');
            return;
        }
        let result: MarkdownReviewOpenResult;
        try {
            result = await this.options.open({ ...selected, file: { ...selected.file, ...position } }, current);
        } catch (error) {
            this.options.reportFailure?.('open-exception', error);
            if (current()) {
                this.options.inform('Document review could not be opened. See the Agent Pivot output for details.');
            }
            return;
        }
        if (!current() || result === true || result === 'cancelled') { return; }
        this.options.reportFailure?.(result);
        const messages = {
            'session-unavailable': 'The selected AI session is not available for document review. Refresh its conversation and try again.',
            'conversation-unavailable': 'The AI conversation could not be opened. See the Agent Pivot output for details.',
            'document-unavailable': 'The document could not be opened for review. Check that it still exists in the session worktree. See the Agent Pivot output for details.',
        };
        this.options.inform(messages[result]);
    }
}
