# Active Session Conversation Outline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand one focused Active Session card into a Codex-style user-input outline and open a safe, read-only conversation viewer for Codex, Kimi, and Claude.

**Architecture:** Add an extension-host-scoped conversation coordinator above three provider-native adapters. Kimi and Claude use bounded incremental JSONL readers resolved by their existing services; Codex uses one private JSONL-over-stdio app-server child. The sidebar keeps ephemeral single-card expansion state and sends correlated requests, while a reusable editor-area WebviewPanel renders bounded, sanitized conversation pages.

**Tech Stack:** TypeScript 4.0, Node.js 22.12 CI, VS Code WebviewView/WebviewPanel APIs, plain Webview JavaScript, SCSS/CSS, `markdown-it@14.3.0`, `dompurify@3.4.12`, Node test runner, Playwright Chromium, Gulp, Webpack, VSIX packaging.

## Global Constraints

- Work only in `/home/hzcheng/projects/repos/vscode-dashboard/.worktree/active-session-conversation-outline` on `docs/active-session-conversation-outline-design`.
- The approved design is `docs/superpowers/specs/2026-07-25-active-session-conversation-outline-design.md`.
- Every Active Session card starts collapsed; a non-focused card first focuses its session, while an already focused card toggles expansion.
- At most one Active Session card is expanded, and a focus/session change closes the previous card.
- Render only the `Conversation` content surface; do not expose a disabled or empty Subagents tab.
- One marker represents one real human user input, not necessarily one provider-native turn.
- Never expose reasoning, system/developer/hook messages, tools, tool results, logs, subagent/sidechain traffic, encrypted content, or local attachment paths.
- Codex content comes only from a Project Steward-owned `codex app-server --listen stdio://` child; do not parse Codex transcript JSONL as a content fallback.
- Kimi and Claude source paths come only from their existing provider services and must pass canonical provider-home validation.
- Use protocol version `1`, correlated positive integer request IDs, subscription generations, provider/session validation, and opaque coordinator-issued revisions/cursors.
- Clamp pages to 1–20 interactions and 512 KiB; cap one outline at the newest 2,000 interactions.
- Cap JSONL scans at the newest 64 MiB and five seconds, chunks at 256 KiB,
  event-loop yields at 4 MiB, physical lines at 1 MiB, visible messages at
  64,000 grapheme clusters, viewer retention at 100 interactions or 4 MiB, and
  Codex responses at 16 MiB/10 seconds.
- Coalesce invalidations for 250 ms, publish no more than once per session per second, and reuse each provider service's existing three-second poller.
- Keep the eight-inactive-index/ten-minute cache independently per provider;
  no provider can evict or retain another provider's indexes.
- Truncate previews to 160 grapheme clusters before escaping; use `Intl.Segmenter` when present and code-point iteration otherwise.
- Treat a marker rail or viewer message list as at-bottom only within 8 CSS
  pixels; both Webviews receive this value from the Host-owned limits.
- Render Markdown with `markdown-it` configured with `html: false` and `linkify: false`, then sanitize in the viewer with DOMPurify and an HTTPS-only URL policy.
- Clear card subscriptions on collapse/hide/destroy, viewer subscriptions and snapshots on panel disposal/session change, and all adapters/app-server state on extension deactivation.
- SCSS and `src/webview/*.js` are source files; regenerate `media/*.css` and copied Webview scripts through Gulp.
- Every production change follows a failing-test-first cycle and ends in an intentional commit.

---

## File Structure

- Create `src/aiSessions/conversation/types.ts`: normalized interactions, page/envelope types, public errors, and exact limits.
- Create `src/aiSessions/conversation/text.ts`: grapheme-safe normalization, preview, attachment labels, and truncation.
- Create `src/aiSessions/conversation/source.ts`: canonical provider-home validation, read-only file opening, and portable signatures.
- Create `src/aiSessions/conversation/jsonlReader.ts`: bounded incremental JSONL planning and chunked reads.
- Create `src/aiSessions/conversation/model.ts`: immutable outlines, page slicing, response-state projection, and cache bounds.
- Create `src/aiSessions/conversation/kimiAdapter.ts`: Kimi `wire.jsonl` normalization.
- Create `src/aiSessions/conversation/claudeAdapter.ts`: Claude top-level JSONL normalization.
- Create `src/aiSessions/conversation/codexAppServerClient.ts`: private stdio JSON-RPC lifecycle, bounds, and restart budget.
- Create `src/aiSessions/conversation/codexAdapter.ts`: app-server thread/item normalization.
- Create `src/aiSessions/conversation/coordinator.ts`: authority, adapter isolation, public revisions, cursors, subscriptions, and stale-result rejection.
- Create `src/aiSessions/conversation/conversationHostController.ts`:
  versioned sidebar request validation and publication without colliding with
  the existing `src/aiSessions/dashboardController.ts`.
- Create `src/aiSessions/conversation/composition.ts`: construct the three
  adapters, coordinator, controller, and viewer behind injectable production
  dependencies.
- Create `src/aiSessions/conversation/markdown.ts`: safe Markdown rendering before DOMPurify.
- Create `src/aiSessions/conversation/viewer.ts`: the reusable `AI Conversation` WebviewPanel.
- Create `src/webview/conversationViewerScripts.js`: DOMPurify, page navigation, new-content, link, scroll, and focus behavior.
- Create `media/conversationViewer.scss`: editor viewer styling; Gulp produces `media/conversationViewer.css`.
- Modify `src/services/{codex,kimi,claude}SessionService.ts`: expose read-only conversation source candidates without duplicating discovery.
- Modify `src/aiSessions/types.ts`: optional provider-service source-resolution contract.
- Modify `src/webview/webviewContent.ts`: render focused-card expansion shells and accessible marker containers.
- Modify `src/webview/webviewProjectScripts.js`: single expansion state, request correlation, marker navigation, dynamic height, and refresh restoration.
- Modify `media/styles.scss`: Active Session outline/card layout; Gulp regenerates `media/styles.css`.
- Modify `src/dashboard.ts`, `src/dashboard/viewProvider.ts`, and `src/dashboard/messageRouter.ts`: compose and dispose the conversation capability.
- Modify `gulpfile.js`, `.vscodeignore`, and release checks: package the viewer script, CSS, and pinned DOMPurify asset.

---

## Execution Order

Execute Tasks 1–11 sequentially. Task 2 consumes Task 1 contracts; Task 3
consumes Tasks 1–2; Tasks 4–5 consume the normalized reader/model; Task 6
consumes all three adapters; Tasks 7–9 consume the coordinator protocol; Task
10 composes them; Task 11 audits the resulting real commit hashes. Fresh
subagents may implement individual tasks, but two implementation tasks must not
run concurrently against this shared worktree.

Before Task 1 and again before Task 11, compare `origin/main..HEAD` and
`HEAD..origin/main`. If upstream changed any listed shared file, stop and
review/reconcile that overlap in this worktree before continuing; never resolve
it by overwriting the primary checkout or the user's `.vscode/settings.json`.

---

### Task 1: Conversation contracts, limits, grapheme handling, and dependencies

**Files:**
- Create: `src/aiSessions/conversation/types.ts`
- Create: `src/aiSessions/conversation/text.ts`
- Create: `tests/unit/aiSessions/conversationText.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `ConversationInteraction`, `ConversationOutline`,
  `ConversationPageRequest`, `ConversationPage`,
  `ConversationRequestEnvelope<T>`, `ConversationResponseEnvelope<T>`,
  `ConversationPublicError`, `ConversationError`,
  `ConversationAbortError`, `ConversationAbortSignal`,
  `ConversationAbortController`, `SanitizedConversationDiagnostic`,
  and `ConversationProviderAdapter`.
- Produces `CONVERSATION_LIMITS`, `countGraphemes`,
  `truncateGraphemes`, `normalizeVisibleText`, `buildVisibleUserInput`,
  `buildUserPreview`, and `attachmentLabel`.
- Every later task imports these exact names.

- [ ] **Step 1: Write the failing grapheme and public-contract test**

Create `tests/unit/aiSessions/conversationText.test.js`:

```js
'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const text = require('../../../out/aiSessions/conversation/text');
const types = require('../../../out/aiSessions/conversation/types');

test('SESSION-AI-SESSION-CONVERSATION-TEXT-001 counts and truncates visible input without splitting graphemes', () => {
    assert.equal(text.countGraphemes('A👨‍👩‍👧‍👦e\u0301中'), 4);
    assert.equal(text.truncateGraphemes('A👨‍👩‍👧‍👦e\u0301中', 3), 'A👨‍👩‍👧‍👦e\u0301…');
    assert.equal(text.normalizeVisibleText('  hello\r\n\tworld  '), 'hello\nworld');
    assert.equal(text.normalizeVisibleText('safe\u0000\u0007 text\ufffe'), 'safe text');
    assert.equal(text.attachmentLabel(1), '[Attachment]');
    assert.equal(text.attachmentLabel(3), '[3 Attachments]');
    assert.equal(text.buildVisibleUserInput([
        { kind: 'text', text: 'Review' },
        { kind: 'attachment' },
        { kind: 'attachment' },
        { kind: 'text', text: 'then explain' },
    ]), 'Review [2 Attachments] then explain');
    assert.equal(types.CONVERSATION_LIMITS.previewGraphemes, 160);
    assert.equal(types.CONVERSATION_LIMITS.maxPageInteractions, 20);
    assert.equal(types.CONVERSATION_LIMITS.maxOutlineInteractions, 2000);
    assert.equal(types.CONVERSATION_LIMITS.autoScrollThresholdPx, 8);
    assert.equal(types.CONVERSATION_LIMITS.minRequestId, 1);
    assert.equal(types.CONVERSATION_LIMITS.inactiveIndexLimitPerProvider, 8);
    let cancelled = 0;
    const controller = new types.ConversationAbortController();
    controller.signal.onAbort(() => { cancelled += 1; });
    controller.abort();
    controller.abort();
    assert.equal(cancelled, 1);
});
```

- [ ] **Step 2: Run the test and observe RED**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/conversationText.test.js
```

Expected: `Cannot find module '../../../out/aiSessions/conversation/text'`.

- [ ] **Step 3: Install and pin the two production dependencies and Markdown types**

Run:

```bash
npm install --save-exact markdown-it@14.3.0 dompurify@3.4.12
npm install --save-dev --save-exact @types/markdown-it@14.1.2
```

Expected: `package.json` contains exact versions without `^` or `~`, and
`package-lock.json` records the same resolved packages. `dompurify` remains a
production dependency because Gulp copies its browser distribution into the
VSIX; no extension-host TypeScript file imports or executes it, so no DOM shim
or `@types/dompurify` dependency is added.

- [ ] **Step 4: Add the normalized types and exact limits**

Create `src/aiSessions/conversation/types.ts` with these public contracts:

```ts
'use strict';

import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';

export const CONVERSATION_LIMITS = Object.freeze({
    previewGraphemes: 160,
    maxOutlineInteractions: 2_000,
    maxPageInteractions: 20,
    maxPageBytes: 512 * 1024,
    maxSourceBytes: 64 * 1024 * 1024,
    readChunkBytes: 256 * 1024,
    yieldEveryBytes: 4 * 1024 * 1024,
    maxLineBytes: 1024 * 1024,
    jsonlScanTimeoutMs: 5_000,
    maxMessageGraphemes: 64_000,
    maxViewerInteractions: 100,
    maxViewerBytes: 4 * 1024 * 1024,
    maxCodexResponseBytes: 16 * 1024 * 1024,
    codexRequestTimeoutMs: 10_000,
    invalidationDebounceMs: 250,
    invalidationMinIntervalMs: 1_000,
    autoScrollThresholdPx: 8,
    minRequestId: 1,
    inactiveIndexLimitPerProvider: 8,
    inactiveIndexTtlMs: 10 * 60 * 1000,
});

export type ConversationResponseState =
    'complete' | 'inProgress' | 'interrupted' | 'unknown';

export interface ConversationInteraction {
    id: string;
    providerTurnId?: string;
    timestamp?: number;
    userMarkdown: string;
    userPreview: string;
    userGraphemeCount: number;
    assistantMarkdown: string[];
    responseState: ConversationResponseState;
}

export interface ConversationOutline {
    provider: AiSessionProviderId;
    sessionId: string;
    sourceRevision: string;
    interactions: Array<Omit<ConversationInteraction,
        'userMarkdown' | 'assistantMarkdown'>>;
    totalInteractions: number;
    partial: boolean;
}

export interface ConversationPageRequest {
    provider: AiSessionProviderId;
    sessionId: string;
    anchorInteractionId: string;
    direction: 'around' | 'before' | 'after';
    cursor?: string;
    limit?: number;
    expectedRevision?: string;
}

export interface ConversationMessage {
    id: string;
    interactionId: string;
    role: 'user' | 'assistant';
    timestamp?: number;
    markdown: string;
}

export interface ConversationPage {
    provider: AiSessionProviderId;
    sessionId: string;
    sourceRevision: string;
    anchorInteractionId: string;
    messages: ConversationMessage[];
    interactionStates: Array<{
        interactionId: string;
        responseState: ConversationResponseState;
    }>;
    previousCursor?: string;
    nextCursor?: string;
    isStart: boolean;
    isEnd: boolean;
}

export interface ConversationPublicError {
    code: 'unavailable' | 'staleRevision' | 'unsupportedVersion'
        | 'tooLarge' | 'timeout';
    reason?: 'missingSource' | 'updateCodex' | 'unsupportedCodexProtocol'
        | 'reconnectingCodex' | 'codexRetryExhausted';
    retryAfterMs?: number;
}

export class ConversationError extends Error {
    constructor(
        readonly code: ConversationPublicError['code'],
        readonly reason?: ConversationPublicError['reason'],
        readonly retryAfterMs?: number
    ) {
        super(code);
        this.name = 'ConversationError';
    }

    toPublicError(): ConversationPublicError {
        return {
            code: this.code,
            reason: this.reason,
            retryAfterMs: this.retryAfterMs,
        };
    }
}

export class ConversationAbortError extends Error {
    constructor() {
        super('aborted');
        this.name = 'AbortError';
    }
}

export interface ConversationRequestEnvelope<T> {
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    payload: T;
}

export interface ConversationResponseEnvelope<T> {
    version: 1;
    requestId: number;
    subscriptionGeneration: number;
    payload?: T;
    error?: ConversationPublicError;
}

export interface SanitizedConversationDiagnostic {
    event: 'conversation-source' | 'conversation-read'
        | 'codex-conversation-app-server';
    provider?: AiSessionProviderId;
    category: 'spawn' | 'timeout' | 'protocol' | 'oversized' | 'exit'
        | 'unavailable' | 'malformed' | 'partial';
    count?: number;
    durationMs?: number;
    version?: string;
}

export interface ConversationAbortSignal {
    readonly aborted: boolean;
    onAbort(listener: () => void): AiSessionDisposable;
}

export class ConversationAbortController {
    private abortedValue = false;
    private readonly listeners = new Set<() => void>();
    readonly signal: ConversationAbortSignal;

    constructor() {
        const controller = this;
        this.signal = {
            get aborted(): boolean {
                return controller.abortedValue;
            },
            onAbort(listener: () => void): AiSessionDisposable {
                return controller.subscribe(listener);
            },
        };
    }

    abort(): void {
        if (this.abortedValue) {
            return;
        }
        this.abortedValue = true;
        const listeners = Array.from(this.listeners);
        this.listeners.clear();
        listeners.forEach(listener => listener());
    }

    private subscribe(listener: () => void): AiSessionDisposable {
        if (this.abortedValue) {
            listener();
            return { dispose() {} };
        }
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }
}

export interface ConversationProviderAdapter extends AiSessionDisposable {
    readOutline(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationOutline>;
    readPage(
        request: ConversationPageRequest,
        signal?: ConversationAbortSignal
    ): Promise<ConversationPage>;
    watch(sessionId: string, onChange: () => void): AiSessionDisposable;
}
```

This repository-owned controller avoids depending on the global
`AbortController`, which is absent from the project's TypeScript 4.0/Node 14
type surface and cannot be assumed in the oldest supported VS Code runtime.

- [ ] **Step 5: Implement grapheme-safe text helpers**

Create `src/aiSessions/conversation/text.ts`. Access `Intl.Segmenter`
dynamically because the repository's ES6 TypeScript lib predates its type:

```ts
'use strict';

type Segmenter = { segment(value: string): Iterable<{ segment: string }> };

function graphemes(value: string): string[] {
    const SegmenterCtor = (Intl as unknown as {
        Segmenter?: new (
            locale?: string,
            options?: { granularity: string }
        ) => Segmenter;
    }).Segmenter;
    if (SegmenterCtor) {
        return Array.from(
            new SegmenterCtor(undefined, { granularity: 'grapheme' }).segment(value),
            item => item.segment
        );
    }
    return Array.from(value);
}

export function countGraphemes(value: string): number {
    return graphemes(String(value || '')).length;
}

export function truncateGraphemes(value: string, limit: number): string {
    const parts = graphemes(String(value || ''));
    const safeLimit = Math.max(0, Math.floor(limit));
    return parts.length <= safeLimit ? parts.join('') : `${parts.slice(0, safeLimit).join('')}…`;
}

export function normalizeVisibleText(value: string): string {
    return String(value || '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '')
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map(line => line.replace(/[\t ]+/g, ' ').trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function buildUserPreview(value: string): string {
    return truncateGraphemes(normalizeVisibleText(value), 160);
}

export function attachmentLabel(count: number): string {
    const safeCount = Math.max(1, Math.floor(count));
    return safeCount === 1 ? '[Attachment]' : `[${safeCount} Attachments]`;
}

export type VisibleUserInputPart =
    { kind: 'text'; text: string } | { kind: 'attachment' };

export function buildVisibleUserInput(
    parts: readonly VisibleUserInputPart[]
): string {
    const visible: string[] = [];
    let attachments = 0;
    const flushAttachments = (): void => {
        if (attachments > 0) {
            visible.push(attachmentLabel(attachments));
            attachments = 0;
        }
    };
    parts.forEach(part => {
        if (part.kind === 'attachment') {
            attachments += 1;
            return;
        }
        flushAttachments();
        const text = normalizeVisibleText(part.text);
        if (text) {
            visible.push(text);
        }
    });
    flushAttachments();
    return normalizeVisibleText(visible.join(' '));
}
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/conversationText.test.js
git diff --check
```

Expected: the focused test passes and TypeScript compiles.

```bash
git add package.json package-lock.json \
  src/aiSessions/conversation/types.ts \
  src/aiSessions/conversation/text.ts \
  tests/unit/aiSessions/conversationText.test.js
git commit -m "feat: add conversation history contracts"
```

---

### Task 2: Canonical provider source resolution

**Files:**
- Create: `src/aiSessions/conversation/source.ts`
- Create: `tests/contract/aiSessions/conversationSources.test.js`
- Modify: `src/aiSessions/types.ts`
- Modify: `src/services/codexSessionService.ts`
- Modify: `src/services/kimiSessionService.ts`
- Modify: `src/services/claudeSessionService.ts`
- Modify: `tests/helpers/providerContract.js`

**Interfaces:**
- Produces `AiSessionConversationSourceCandidate` on the optional
  `AiSessionService.resolveConversationSource(sessionId, candidatePaths)`.
- Produces `openValidatedConversationSource(candidate)` returning canonical
  provider home/path, a read-only `FileHandle`, size, full signature fields,
  and portable edge hashes.
- Produces `isConversationSourceContinuation(previous, current)` so append
  validation is distinct from the signature that changes on every append.
- Kimi, Claude, and Codex adapters consume the exact provider-service result;
  no adapter reconstructs provider paths.

- [ ] **Step 1: Write failing provider source and escape tests**

Create `tests/contract/aiSessions/conversationSources.test.js` and use the
existing provider fixtures. Create the escape and ambiguity fixtures
explicitly before asserting:

```js
test('SECURITY-AI-SESSION-CONVERSATION-SOURCE-001 resolves known sources and rejects escaped or ambiguous files', async t => {
    const sandbox = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'steward-conversation-source-'));
    t.after(() => fs.promises.rm(sandbox, { recursive: true, force: true }));
    const safeHome = path.join(sandbox, 'provider-home');
    const outside = path.join(sandbox, 'outside.jsonl');
    const escapedSymlink = path.join(safeHome, 'escaped.jsonl');
    await fs.promises.mkdir(safeHome, { recursive: true });
    await fs.promises.writeFile(outside, '{"outside":true}\n');
    await fs.promises.symlink(outside, escapedSymlink);

    const kimi = new KimiSessionService();
    const kimiSource = kimi.resolveConversationSource(
        '11111111-1111-4111-8111-111111111111',
        ['/fixtures/project']
    );
    assert.match(kimiSource.sourcePath, /wire\.jsonl$/);

    const opened = await openValidatedConversationSource(kimiSource);
    assert.equal(opened.canonicalPath.startsWith(opened.canonicalProviderHome), true);
    await opened.handle.close();

    const escaped = await openValidatedConversationSource({
        providerHome: safeHome,
        sourcePath: escapedSymlink,
    });
    assert.equal(escaped, null);

    const duplicateId = '22222222-2222-4222-8222-222222222222';
    await createClaudeDuplicateFixture(duplicateId, [
        '/fixtures/project-a',
        '/fixtures/project-b',
    ]);
    assert.equal(
        claude.resolveConversationSource(duplicateId, ['/unmatched/workspace']),
        null
    );
});
```

Extend `tests/helpers/providerContract.js` to assert each fixture's known
session resolves beneath its configured provider home and malformed UUIDs
return `null`.

- [ ] **Step 2: Run the focused contracts and observe RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/conversationSources.test.js
node --test tests/contract/aiSessions/providers.test.js
```

Expected: missing `resolveConversationSource` and `source` module failures.

- [ ] **Step 3: Add the provider-service source candidate contract**

In `src/aiSessions/types.ts`, add the candidate interface and add the shown
member to the existing `AiSessionService` declaration:

```ts
export interface AiSessionConversationSourceCandidate {
    providerHome: string;
    sourcePath: string;
}

export interface AiSessionService {
    resolveConversationSource?(
        sessionId: string,
        candidatePaths?: readonly string[]
    ): AiSessionConversationSourceCandidate | null;
}
```

Implement service methods:

```ts
// CodexSessionService: content remains app-server-owned; this path is only
// an invalidation signal.
class CodexSessionService {
    resolveConversationSource(sessionId: string): AiSessionConversationSourceCandidate | null {
        const codexHome = this.getCodexHome();
        const sourcePath = codexHome && this.getSessionFiles(codexHome).get(sessionId);
        return sourcePath ? { providerHome: codexHome, sourcePath } : null;
    }
}

// KimiSessionService
class KimiSessionService {
    resolveConversationSource(sessionId: string): AiSessionConversationSourceCandidate | null {
        const kimiHome = this.getKimiHome();
        const sessionDir = kimiHome && this.findSessionDir(kimiHome, sessionId);
        const sourcePath = sessionDir && path.join(sessionDir, 'wire.jsonl');
        return sourcePath && fs.existsSync(sourcePath)
            ? { providerHome: kimiHome, sourcePath }
            : null;
    }
}
```

For Claude, enumerate every exact `<uuid>.jsonl` filename, parse cwd with the
existing reader, filter with `candidatePaths`, and return only one canonical
candidate. Zero or multiple matches returns `null`; do not reuse the current
last-write-wins `sessionFilesById` map for this decision.

- [ ] **Step 4: Implement canonical opening and portable signatures**

Create `src/aiSessions/conversation/source.ts` with:

```ts
'use strict';

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiSessionConversationSourceCandidate } from '../types';

const NO_FOLLOW_FLAG =
    (fs.constants as Record<string, number>).O_NOFOLLOW || 0;

export interface OpenConversationSource {
    canonicalProviderHome: string;
    canonicalPath: string;
    handle: fs.promises.FileHandle;
    size: number;
    mtimeMs: number;
    device?: number;
    inode?: number;
    birthtimeMs?: number;
    portableFirstHash?: string;
    portableLastHash?: string;
    identity: string;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== '' && !relative.startsWith(`..${path.sep}`)
        && relative !== '..' && !path.isAbsolute(relative);
}

async function hashRange(
    handle: fs.promises.FileHandle,
    position: number,
    length: number
): Promise<string> {
    const buffer = Buffer.alloc(Math.max(0, length));
    const result = await handle.read(buffer, 0, buffer.length, position);
    return createHash('sha256')
        .update(buffer.subarray(0, result.bytesRead))
        .digest('hex');
}

export async function openValidatedConversationSource(
    candidate: AiSessionConversationSourceCandidate,
    options: {
        forcePortableIdentity?: boolean;
        noFollowFlag?: number;
        openFile?: (
            sourcePath: string,
            flags: number
        ) => Promise<fs.promises.FileHandle>;
    } = {}
): Promise<OpenConversationSource | null> {
    let canonicalProviderHome: string;
    let canonicalPath: string;
    try {
        canonicalProviderHome = await fs.promises.realpath(candidate.providerHome);
        canonicalPath = await fs.promises.realpath(candidate.sourcePath);
    } catch (_error) {
        return null;
    }
    if (!isInside(canonicalProviderHome, canonicalPath)) {
        return null;
    }
    let handle: fs.promises.FileHandle;
    try {
        const noFollowFlag = options.noFollowFlag === undefined
            ? NO_FOLLOW_FLAG
            : options.noFollowFlag;
        const openFile = options.openFile || fs.promises.open;
        handle = await openFile(
            canonicalPath,
            fs.constants.O_RDONLY | noFollowFlag
        );
        const pathAfterOpen = await fs.promises.realpath(canonicalPath);
        if (pathAfterOpen !== canonicalPath
            || !isInside(canonicalProviderHome, pathAfterOpen)) {
            await handle.close();
            return null;
        }
        const stat = await handle.stat();
        const pathStat = await fs.promises.stat(pathAfterOpen);
        if (!stat.isFile()) {
            await handle.close();
            return null;
        }
        if (noFollowFlag === 0
            && Number.isFinite(stat.dev) && stat.dev > 0
            && Number.isFinite(stat.ino) && stat.ino > 0
            && (stat.dev !== pathStat.dev
                || stat.ino !== pathStat.ino
                || stat.birthtimeMs !== pathStat.birthtimeMs)) {
            await handle.close();
            return null;
        }
        const hasStableInode = !options.forcePortableIdentity
            && Number.isFinite(stat.dev) && stat.dev > 0
            && Number.isFinite(stat.ino) && stat.ino > 0;
        const edgeBytes = Math.min(64 * 1024, stat.size);
        const firstHash = hasStableInode
            ? ''
            : await hashRange(handle, 0, edgeBytes);
        const lastHash = hasStableInode
            ? ''
            : await hashRange(handle, Math.max(0, stat.size - edgeBytes), edgeBytes);
        const identity = hasStableInode
            ? `inode:${canonicalPath}:${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.size}:${stat.mtimeMs}`
            : `portable:${canonicalPath}:${stat.size}:${stat.mtimeMs}:${firstHash}:${lastHash}`;
        return {
            canonicalProviderHome,
            canonicalPath,
            handle,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            device: hasStableInode ? stat.dev : undefined,
            inode: hasStableInode ? stat.ino : undefined,
            birthtimeMs: hasStableInode ? stat.birthtimeMs : undefined,
            portableFirstHash: hasStableInode ? undefined : firstHash,
            portableLastHash: hasStableInode ? undefined : lastHash,
            identity,
        };
    } catch (_error) {
        await handle?.close().catch(() => undefined);
        return null;
    }
}

export async function isConversationSourceContinuation(
    previous: OpenConversationSource,
    current: OpenConversationSource
): Promise<boolean> {
    if (previous.canonicalPath !== current.canonicalPath
        || current.size < previous.size) {
        return false;
    }
    if (previous.device !== undefined && previous.inode !== undefined
        && previous.birthtimeMs !== undefined
        && current.device !== undefined && current.inode !== undefined
        && current.birthtimeMs !== undefined) {
        return previous.device === current.device
            && previous.inode === current.inode
            && previous.birthtimeMs === current.birthtimeMs;
    }
    if (previous.portableFirstHash === undefined
        || previous.portableLastHash === undefined
        || current.portableFirstHash === undefined) {
        return false;
    }
    const edgeBytes = Math.min(64 * 1024, previous.size);
    const currentOldFirstHash = await hashRange(current.handle, 0, edgeBytes);
    const currentOldLastHash = await hashRange(
        current.handle,
        Math.max(0, previous.size - edgeBytes),
        edgeBytes
    );
    return currentOldFirstHash === previous.portableFirstHash
        && currentOldLastHash === previous.portableLastHash;
}
```

In the contract, open the same-size replacement with
`{ forcePortableIdentity: true }`, preserve its `mtimeMs` with `fs.utimes`, and
assert the portable identity changes and
`isConversationSourceContinuation` returns false. Append another same-source
record and assert the helper returns true for both forced-portable and native
inode modes; a native snapshot with the same device/inode but a changed
`birthtimeMs` must return false. Use the injected `openFile` once to replace
the resolved target
with an outside-home symlink immediately before delegating to
`fs.promises.open`; assert the no-follow/revalidation path returns `null`.
Run that case once with `{ noFollowFlag: 0 }` so Windows proves the
realpath plus handle/path-stat fallback rather than silently relying on the
POSIX flag.
Add a second test in which the injected extension-host home
differs from a UI-side home string; only the extension-host provider home may
resolve. This covers Remote SSH, WSL, and Dev Container ownership without
importing UI-machine paths.

- [ ] **Step 5: Run focused contracts and commit**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/conversationSources.test.js
node --test tests/contract/aiSessions/providers.test.js
git diff --check
```

Expected: all source-resolution contracts pass for Codex, Kimi, and Claude.

```bash
git add src/aiSessions/types.ts \
  src/aiSessions/conversation/source.ts \
  src/services/codexSessionService.ts \
  src/services/kimiSessionService.ts \
  src/services/claudeSessionService.ts \
  tests/helpers/providerContract.js \
  tests/contract/aiSessions/conversationSources.test.js
git commit -m "feat: resolve conversation sources safely"
```

---

### Task 3: Bounded incremental JSONL and normalized page model

**Files:**
- Create: `src/aiSessions/conversation/jsonlReader.ts`
- Create: `src/aiSessions/conversation/model.ts`
- Create: `tests/unit/aiSessions/conversationJsonlReader.test.js`
- Create: `tests/unit/aiSessions/conversationModel.test.js`

**Interfaces:**
- Produces `readConversationJsonl`, `getConversationReadStart`,
  `ConversationJsonlReadOptions`, `ConversationJsonlRecord`, and
  `ConversationJsonlReadResult`.
- Produces `buildConversationOutline`, `buildConversationPage`, and
  `applyStoppedLifecycleToResponseState`.
- Provider adapters consume parsed records with original byte offsets and use
  the shared page/outline limits.

- [ ] **Step 1: Write failing incremental, malformed, abort, and page tests**

Cover these exact cases:

```js
test('SESSION-AI-SESSION-CONVERSATION-JSONL-001 bounds, resumes, and resets JSONL reads', async t => {
    const fixture = await createJsonlFixture(t, [
        '{"kind":"one"}\n',
        'malformed\n',
        '{"kind":"two"}\n',
    ]);
    const opened = await fixture.open();
    const activeController = new ConversationAbortController();
    const first = await readConversationJsonl(opened, {
        startOffset: 0,
        signal: activeController.signal,
    });
    assert.deepEqual(first.records.map(record => record.value.kind), ['one', 'two']);
    assert.equal(first.malformedLines, 1);
    assert.equal(first.nextOffset, opened.size);
    await opened.handle.close();

    await fixture.append('{"kind":"three"}\n');
    const reopened = await fixture.open();
    const appended = await readConversationJsonl(reopened, {
        startOffset: first.nextOffset,
    });
    assert.deepEqual(appended.records.map(record => record.value.kind), ['three']);

    const abortedController = new ConversationAbortController();
    abortedController.abort();
    await assert.rejects(
        readConversationJsonl(reopened, { signal: abortedController.signal }),
        error => error.name === 'AbortError'
    );
    await reopened.handle.close();
});

test('SESSION-AI-SESSION-CONVERSATION-PAGE-001 clamps pages and rejects stale revisions', () => {
    const interactions = makeInteractions(30);
    const request = {
        provider: 'kimi',
        sessionId: 'session',
        anchorInteractionId: 'i-25',
        direction: 'around',
        limit: 99,
        expectedRevision: 'r1',
    };
    const page = buildConversationPage(interactions, request, 'r1');
    assert.equal(new Set(page.messages.map(message => message.interactionId)).size, 20);
    assert.throws(
        () => buildConversationPage(interactions, { ...request, expectedRevision: 'r1' }, 'r2'),
        /staleRevision/
    );
});
```

The fixture helpers are local to the test file: `createJsonlFixture` creates a
temporary source with `open()` and `append()` methods and registers cleanup on
`t`; `makeInteractions(30)` returns IDs `i-1` through `i-30` with one user and
one assistant message each. Add a delayed fake `FileHandle.read` case that
advances an injected clock beyond 5,000 ms and expects the typed `timeout`
failure. Add exact boundary fixtures: a file of exactly
`CONVERSATION_LIMITS.maxSourceBytes` starts at offset `0`, while one additional
byte starts at offset `1` and discards the first partial physical line.

- [ ] **Step 2: Run the focused tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/conversationJsonlReader.test.js
node --test tests/unit/aiSessions/conversationModel.test.js
```

Expected: both new modules are missing.

- [ ] **Step 3: Implement bounded JSONL reads**

`readConversationJsonl` must:

- cold-start at `max(0, size - 64 MiB)` and discard the first partial line;
- resume exactly from a prior `nextOffset` only when
  `isConversationSourceContinuation(previous, current)` confirms the prior
  bytes are intact;
- read 256 KiB chunks and await `setImmediate` after each 4 MiB;
- reject one physical line above 1 MiB, skip malformed JSON, and count both;
- check `ConversationAbortSignal` before every read and yield;
- compare an injected monotonic clock with a deadline of
  `CONVERSATION_LIMITS.jsonlScanTimeoutMs` before every read and yield, then
  throw the typed public `timeout` failure;
- return original absolute byte offsets and `partial: startOffset > 0`.

Use this record shape:

```ts
export interface ConversationJsonlReadOptions {
    startOffset?: number;
    signal?: ConversationAbortSignal;
    now?: () => number;
}

export interface ConversationJsonlRecord {
    offset: number;
    value: unknown;
}

export interface ConversationJsonlReadResult {
    records: ConversationJsonlRecord[];
    nextOffset: number;
    malformedLines: number;
    oversizedLines: number;
    partial: boolean;
}

export function readConversationJsonl(
    source: OpenConversationSource,
    options?: ConversationJsonlReadOptions
): Promise<ConversationJsonlReadResult>;
```

At function entry use:

```ts
const normalizedOptions = options || {};
const now = normalizedOptions.now || Date.now;
const deadline = now() + CONVERSATION_LIMITS.jsonlScanTimeoutMs;
const checkDeadline = (): void => {
    if (now() >= deadline) {
        throw new ConversationError('timeout');
    }
};
```

Call `checkDeadline()` before each `handle.read` and immediately after each
event-loop yield; do not schedule a real timeout timer for JSONL scanning.

- [ ] **Step 4: Implement immutable outline and page projection**

`buildConversationOutline` keeps the newest 2,000 summaries, reports the
uncapped `totalInteractions`, and strips message bodies. `buildConversationPage`
clamps `limit` to 1–20, enforces 512 KiB after UTF-8 serialization, creates
opaque cursor payloads only through injected `encodeCursor`, and throws a typed
`staleRevision` error before slicing.

`applyStoppedLifecycleToResponseState('inProgress', true)` returns `interrupted`;
other states remain unchanged.

Use these exact exported signatures and state projection:

```ts
export type EncodeConversationCursor = (
    anchorInteractionId: string,
    direction: 'before' | 'after'
) => string;

export function buildConversationOutline(
    provider: AiSessionProviderId,
    sessionId: string,
    sourceRevision: string,
    interactions: readonly ConversationInteraction[],
    partial: boolean
): ConversationOutline {
    const summaries = interactions.map(interaction => ({
        id: interaction.id,
        providerTurnId: interaction.providerTurnId,
        timestamp: interaction.timestamp,
        userPreview: interaction.userPreview,
        userGraphemeCount: interaction.userGraphemeCount,
        responseState: interaction.responseState,
    }));
    return {
        provider,
        sessionId,
        sourceRevision,
        interactions: summaries.slice(-CONVERSATION_LIMITS.maxOutlineInteractions),
        totalInteractions: summaries.length,
        partial,
    };
}

export function applyStoppedLifecycleToResponseState(
    state: ConversationResponseState,
    stopped: boolean
): ConversationResponseState {
    return stopped && state === 'inProgress' ? 'interrupted' : state;
}
```

Implement `buildConversationPage` with the exact public signature below. It
centers the clamped interaction window, removes the farthest complete
interaction until the serialized payload fits, and never splits an
interaction. Adapters have already applied the 64,000-grapheme per-message cap;
an anchor that still cannot fit alone throws `tooLarge`.

```ts
export function buildConversationPage(
    interactions: readonly ConversationInteraction[],
    request: ConversationPageRequest,
    sourceRevision: string,
    encodeCursor: EncodeConversationCursor = () => ''
): ConversationPage {
    if (request.expectedRevision
        && request.expectedRevision !== sourceRevision) {
        throw new ConversationError('staleRevision');
    }
    const anchorIndex = interactions.findIndex(
        interaction => interaction.id === request.anchorInteractionId
    );
    if (anchorIndex < 0) {
        throw new ConversationError('staleRevision');
    }
    const limit = Math.max(1, Math.min(
        CONVERSATION_LIMITS.maxPageInteractions,
        Math.floor(request.limit || CONVERSATION_LIMITS.maxPageInteractions)
    ));
    let start: number;
    let end: number;
    if (request.direction === 'before') {
        end = anchorIndex;
        start = Math.max(0, end - limit);
    } else if (request.direction === 'after') {
        start = anchorIndex + 1;
        end = Math.min(interactions.length, start + limit);
    } else {
        start = Math.max(0, anchorIndex - Math.floor((limit - 1) / 2));
        end = Math.min(interactions.length, start + limit);
        start = Math.max(0, end - limit);
    }
    if (start >= end) {
        throw new ConversationError('staleRevision');
    }
    const pageAnchorInteractionId = request.direction === 'before'
        ? interactions[end - 1].id
        : interactions[start].id;

    const messagesForRange = (): ConversationMessage[] =>
        interactions.slice(start, end).reduce(
            (messages: ConversationMessage[], interaction) => {
                messages.push({
                    id: `${interaction.id}:user`,
                    interactionId: interaction.id,
                    role: 'user',
                    timestamp: interaction.timestamp,
                    markdown: interaction.userMarkdown,
                });
                interaction.assistantMarkdown.forEach((markdown, index) => {
                    messages.push({
                        id: `${interaction.id}:assistant:${index}`,
                        interactionId: interaction.id,
                        role: 'assistant',
                        timestamp: interaction.timestamp,
                        markdown,
                    });
                });
                return messages;
            },
            []
        );
    const makePage = (): ConversationPage => ({
        provider: request.provider,
        sessionId: request.sessionId,
        sourceRevision,
        anchorInteractionId: request.direction === 'around'
            ? request.anchorInteractionId
            : pageAnchorInteractionId,
        messages: messagesForRange(),
        interactionStates: interactions.slice(start, end).map(interaction => ({
            interactionId: interaction.id,
            responseState: interaction.responseState,
        })),
        previousCursor: start > 0
            ? encodeCursor(interactions[start].id, 'before')
            : undefined,
        nextCursor: end < interactions.length
            ? encodeCursor(interactions[end - 1].id, 'after')
            : undefined,
        isStart: start === 0,
        isEnd: end === interactions.length,
    });

    let page = makePage();
    while (Buffer.byteLength(JSON.stringify(page), 'utf8')
        > CONVERSATION_LIMITS.maxPageBytes && end - start > 1) {
        if (request.direction === 'before') {
            start += 1;
        } else if (request.direction === 'after') {
            end -= 1;
        } else if (anchorIndex - start > end - 1 - anchorIndex) {
            start += 1;
        } else {
            end -= 1;
        }
        page = makePage();
    }
    if (Buffer.byteLength(JSON.stringify(page), 'utf8')
        > CONVERSATION_LIMITS.maxPageBytes) {
        throw new ConversationError('tooLarge');
    }
    return page;
}
```

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/conversationJsonlReader.test.js
node --test tests/unit/aiSessions/conversationModel.test.js
git diff --check
```

```bash
git add src/aiSessions/conversation/jsonlReader.ts \
  src/aiSessions/conversation/model.ts \
  tests/unit/aiSessions/conversationJsonlReader.test.js \
  tests/unit/aiSessions/conversationModel.test.js
git commit -m "feat: index bounded conversation JSONL"
```

---

### Task 4: Kimi and Claude conversation adapters

**Files:**
- Create: `src/aiSessions/conversation/kimiAdapter.ts`
- Create: `src/aiSessions/conversation/claudeAdapter.ts`
- Create: `tests/contract/aiSessions/kimiConversationAdapter.test.js`
- Create: `tests/contract/aiSessions/claudeConversationAdapter.test.js`
- Modify: `tests/fixtures/providers/kimi/home/sessions/7bbd38310db600bd89c814e224a73d44/33333333-3333-4333-8333-333333333333/wire.jsonl`
- Create: `tests/fixtures/conversations/claude/session.jsonl`

**Interfaces:**
- Produces `KimiConversationAdapter` and `ClaudeConversationAdapter`, both
  implementing `ConversationProviderAdapter`.
- Constructors consume `resolveSource`, the provider service's shared
  `watchSessionChanges`, `now`, and timers through explicit options.
- Later coordinator tests use both adapters through the common interface only.

- [ ] **Step 1: Add sanitized fixtures and failing adapter contracts**

The Kimi fixture must use canonical
`{ timestamp, message: { type, payload } }` envelopes and include string and
typed-array `TurnBegin.user_input`, visible `ContentPart`, `think`,
`encrypted`, tool, `SubagentEvent`, malformed, interrupt, and `TurnEnd`
messages. The Claude fixture must include visible
`user`/`assistant` text, `sourceToolAssistantUUID`, `toolUseResult`,
`tool_result`, `tool_use`, sidechain, queue, attachment-only, mixed attachment,
and malformed records. Assert separately that assistant `tool_use` blocks
produce no visible assistant message and synthetic user-role `tool_result`
records produce no interaction; do not call either shape a "`tool_use` user
message."

Assert exact normalized output:

```js
assert.deepEqual(outline.interactions.map(item => item.userPreview), [
    'Explain the parser',
    'Review [Attachment]',
    '[2 Attachments]',
]);
assert.equal(
    page.messages.some(message => /tool_result|secret-thought|local\/path/.test(message.markdown)),
    false
);
```

Also append one fixture record, reread, and assert prior interaction IDs do not
change and only the suffix is parsed. For Kimi, duplicate the same
session/TurnBegin offset/timestamp and assert one interaction; reset the source
at the same byte offset with a different timestamp and assert the rebuilt
interaction ID differs.

- [ ] **Step 2: Run the adapter contracts and observe RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/kimiConversationAdapter.test.js
node --test tests/contract/aiSessions/claudeConversationAdapter.test.js
```

Expected: adapter modules are missing.

- [ ] **Step 3: Implement Kimi qualification**

Use only:

```ts
const event = asRecord(envelope.message);
if (event.type === 'TurnBegin') {
    const userInput = event.payload?.user_input;
    const visibleInput = typeof userInput === 'string'
        ? userInput
        : Array.isArray(userInput)
            ? buildVisibleUserInput(userInput.reduce((parts, part) => {
                if (part && part.type === 'text'
                    && typeof part.text === 'string') {
                    parts.push({ kind: 'text', text: part.text });
                } else if (part && (part.type === 'image'
                    || part.type === 'file'
                    || part.type === 'attachment')) {
                    parts.push({ kind: 'attachment' });
                }
                return parts;
            }, []))
            : '';
    if (visibleInput) {
        beginInteraction(visibleInput, record.offset, envelope.timestamp);
    }
} else if (event.type === 'ContentPart'
    && event.payload?.type === 'text'
    && typeof event.payload.text === 'string') {
    appendAssistantText(event.payload.text);
} else if (event.type === 'TurnEnd') {
    finishInteraction('complete');
}
```

Never pass `think`, `encrypted`, tool, result, or `SubagentEvent` records to the
normalized model. Build IDs from `sessionId + TurnBegin offset + timestamp`.
An interrupt finishes the open interaction as `interrupted`. Never copy fields
from a non-text part; it contributes only the neutral attachment marker.
Normalize finite numeric envelope timestamps below `10_000_000_000` from epoch
seconds to milliseconds; preserve millisecond values.

- [ ] **Step 4: Implement Claude qualification**

Create an interaction only when:

```ts
event.type === 'user'
&& event.message?.role === 'user'
&& !event.sourceToolAssistantUUID
&& !event.toolUseResult
&& !containsBlock(event.message.content, 'tool_result')
&& !event.isSidechain
```

Accept only assistant `text` blocks. Ignore `tool_use`, queue, system, internal,
and sidechain records. Use the qualifying user UUID as the interaction ID;
finish an interaction when the next qualifying user input arrives or the file
ends. For qualifying user content, map `text` blocks to visible text and
provider-documented image/document/attachment blocks to `{ kind:
'attachment' }`, then call `buildVisibleUserInput` in original source order.
Unknown blocks are discarded and no block metadata or path is copied.
Before creating a user interaction, recognize exact trimmed
`[Request interrupted by user]` string content or array text content as a
lifecycle sentinel: create no marker/message and mark only the current open
interaction `interrupted`.

- [ ] **Step 5: Implement bounded caches and watches**

Each adapter keeps at most eight inactive indexes for ten minutes, closes every
source handle in `finally`, shares the provider-service poller, and returns a
logical disposable per viewed session. Do not start an additional OS watcher.
If the five-second JSONL deadline fires after complete interactions were
normalized, return those interactions with `partial: true`; if none were
complete, surface the public `timeout` error. Add one adapter test for each
branch.

Use one shared bounded cache helper in `jsonlReader.ts`; both adapters own an
instance and call `touch` on read, `retain`/returned `dispose` on watch, and
`clear` on adapter disposal:

```ts
export class ConversationIndexCache<T extends { dispose(): void }> {
    private readonly entries = new Map<string, {
        value: T;
        lastUsedAt: number;
        retainCount: number;
    }>();

    constructor(private readonly now: () => number) {}

    set(key: string, value: T): void {
        this.delete(key);
        this.entries.set(key, { value, lastUsedAt: this.now(), retainCount: 0 });
        this.evict();
    }

    get(key: string): T | undefined {
        const entry = this.entries.get(key);
        if (entry) {
            entry.lastUsedAt = this.now();
        }
        return entry?.value;
    }

    retain(key: string): AiSessionDisposable {
        const entry = this.entries.get(key);
        if (entry) {
            entry.retainCount += 1;
        }
        return {
            dispose: () => {
                const current = this.entries.get(key);
                if (current) {
                    current.retainCount = Math.max(0, current.retainCount - 1);
                    current.lastUsedAt = this.now();
                    this.evict();
                }
            },
        };
    }

    clear(): void {
        Array.from(this.entries.values()).forEach(entry => entry.value.dispose());
        this.entries.clear();
    }

    private delete(key: string): void {
        this.entries.get(key)?.value.dispose();
        this.entries.delete(key);
    }

    private evict(): void {
        const inactive = Array.from(this.entries.entries())
            .filter(([, entry]) => entry.retainCount === 0)
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        inactive
            .filter(([, entry], index) =>
                this.now() - entry.lastUsedAt > CONVERSATION_LIMITS.inactiveIndexTtlMs
                || index < inactive.length
                    - CONVERSATION_LIMITS.inactiveIndexLimitPerProvider
            )
            .forEach(([key]) => this.delete(key));
    }
}
```

- [ ] **Step 6: Run focused contracts and commit**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/kimiConversationAdapter.test.js
node --test tests/contract/aiSessions/claudeConversationAdapter.test.js
git diff --check
```

```bash
git add src/aiSessions/conversation/kimiAdapter.ts \
  src/aiSessions/conversation/claudeAdapter.ts \
  tests/contract/aiSessions/kimiConversationAdapter.test.js \
  tests/contract/aiSessions/claudeConversationAdapter.test.js \
  tests/fixtures/providers/kimi/home/sessions/7bbd38310db600bd89c814e224a73d44/33333333-3333-4333-8333-333333333333/wire.jsonl \
  tests/fixtures/conversations/claude/session.jsonl
git commit -m "feat: read Kimi and Claude conversations"
```

---

### Task 5: Private Codex app-server client and adapter

**Files:**
- Create: `src/aiSessions/conversation/codexAppServerClient.ts`
- Create: `src/aiSessions/conversation/codexAdapter.ts`
- Create: `tests/contract/aiSessions/codexAppServerClient.test.js`
- Create: `tests/contract/aiSessions/codexConversationAdapter.test.js`
- Create: `tests/fixtures/conversations/codex/thread-read.json`

**Interfaces:**
- Produces `CodexAppServerClient.request(method, params, signal)` and
  `CodexConversationAdapter`.
- The client constructor consumes an injected `spawn`, clock, timers,
  executable resolver, and sanitized diagnostic callback.
- The adapter consumes only `thread/read` structured results plus the Codex
  service watcher; it never opens transcript content.

- [ ] **Step 1: Write failing transport lifecycle tests**

Use a fake child with writable stdin and readable stdout. Assert the first
request writes:

```js
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

[
  {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'project_steward',
        title: 'Project Steward',
        version: '2.1.6',
      },
    },
  },
  { method: 'initialized', params: {} },
  {
    method: 'thread/read',
    id: 2,
    params: { threadId: SESSION_ID, includeTurns: true },
  },
]
```

Also assert out-of-order responses correlate by ID, a response over 16 MiB
terminates the child, ten seconds rejects with `timeout`, stderr text never
reaches diagnostics, and only two restarts occur in a rolling 60-second window
with one-/four-second delays. A separate capability-mapping test asserts a
missing `thread/read` method becomes `unavailable` with reason
`updateCodex`, while handshake or response-schema mismatch becomes
`unsupportedVersion` with reason `unsupportedCodexProtocol`; neither error may
include raw protocol text. Add transport cases proving:

- stdout objects split across arbitrary Buffer chunks and terminated by either
  `\n` or `\r\n` are framed once;
- an unterminated line is rejected as soon as its retained Buffer exceeds
  16 MiB, before `JSON.parse`;
- every write ends with exactly one `\n`, and a `false` return from
  `stdin.write` pauses the serialized write queue until `drain`;
- stderr is continuously drained as bytes but never decoded, retained, or sent
  to diagnostics, so a noisy child cannot block on a full pipe;
- executable resolution calls the existing extension-host
  `resolveAiProviderExecutable('codex')`; `null` does not guess a home-relative
  executable;
- the third restart request inside 60 seconds returns `unavailable` with
  `codexRetryExhausted` and a positive `retryAfterMs`, never `updateCodex`.

- [ ] **Step 2: Write the failing Codex normalization test**

The fixture must contain two native turns, two `userMessage` items in the first
turn, visible `agentMessage`, `reasoning`, command, file change, tool,
collab/subagent, plan, hook, mixed text/image, and local-image items. Assert:

```js
assert.deepEqual(outline.interactions.map(item => item.id), [
    'user-item-1',
    'user-item-2',
    'user-item-3',
]);
assert.deepEqual(outline.interactions.map(item => item.providerTurnId), [
    'turn-1',
    'turn-1',
    'turn-2',
]);
assert.equal(JSON.stringify(page).includes('reasoning-secret'), false);
assert.equal(JSON.stringify(page).includes('command-output'), false);
assert.equal(JSON.stringify(page).includes('/private/local-image.png'), false);
assert.match(page.messages[0].markdown, /\[Attachment\]/);
```

Document the consumed stable app-server shape directly in
`tests/fixtures/conversations/codex/thread-read.json`; add ignored item
variants to this skeleton rather than inventing transcript fields:

```json
{
  "thread": {
    "id": "33333333-3333-4333-8333-333333333333",
    "turns": [
      {
        "id": "turn-1",
        "status": "completed",
        "items": [
          {
            "id": "user-item-1",
            "type": "userMessage",
            "content": [{"type": "text", "text": "Visible request"}]
          },
          {
            "id": "agent-item-1",
            "type": "agentMessage",
            "text": "Visible response"
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Run the contracts and observe RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/codexAppServerClient.test.js
node --test tests/contract/aiSessions/codexConversationAdapter.test.js
```

Expected: client and adapter modules are missing.

- [ ] **Step 4: Implement the private stdio client**

Spawn without a shell:

```ts
const executable = resolveExecutable('codex');
if (!executable) {
    throw new ConversationError('unavailable', 'updateCodex');
}
spawn(executable, ['app-server', '--listen', 'stdio://'], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
});
```

Do not call `setEncoding` or use `readline`, because both hide the byte count
needed for the 16 MiB boundary. Keep a Buffer remainder and frame it directly:

```ts
class CodexAppServerClient {
private acceptStdoutChunk(chunk: Buffer): void {
    this.stdoutRemainder = Buffer.concat([this.stdoutRemainder, chunk]);
    let newline = this.stdoutRemainder.indexOf(0x0a);
    while (newline >= 0) {
        if (newline > CONVERSATION_LIMITS.maxCodexResponseBytes) {
            this.failChild(new ConversationError('tooLarge'));
            return;
        }
        let line = this.stdoutRemainder.subarray(0, newline);
        this.stdoutRemainder = this.stdoutRemainder.subarray(newline + 1);
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
            line = line.subarray(0, line.length - 1);
        }
        try {
            this.acceptResponse(JSON.parse(line.toString('utf8')));
        } catch (_error) {
            this.failChild(
                new ConversationError('unsupportedVersion',
                    'unsupportedCodexProtocol')
            );
            return;
        }
        newline = this.stdoutRemainder.indexOf(0x0a);
    }
    if (this.stdoutRemainder.length
        > CONVERSATION_LIMITS.maxCodexResponseBytes) {
        this.failChild(new ConversationError('tooLarge'));
    }
}

private enqueueWrite(message: unknown): Promise<void> {
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8');
    this.writeTail = this.writeTail.then(() => new Promise<void>(
        (resolve, reject) => {
            const stdin = this.child?.stdin;
            if (!stdin?.writable) {
                reject(new ConversationError('unavailable'));
                return;
            }
            if (stdin.write(bytes)) {
                resolve();
                return;
            }
            const onDrain = (): void => {
                cleanup();
                resolve();
            };
            const onError = (error: Error): void => {
                cleanup();
                reject(error);
            };
            const cleanup = (): void => {
                stdin.removeListener('drain', onDrain);
                stdin.removeListener('error', onError);
            };
            stdin.once('drain', onDrain);
            stdin.once('error', onError);
        }
    ));
    return this.writeTail;
}
}
```

Send one JSON object per line, perform exactly one stable
`initialize`/`initialized` handshake per child, omit `experimentalApi`, enforce
the response/time limits, reject every pending request on exit, and log only:

```ts
function report(
    category: 'spawn' | 'timeout' | 'protocol' | 'oversized' | 'exit',
    sanitizedMajorMinor?: string
): void {
    onDiagnostic({
        event: 'codex-conversation-app-server',
        provider: 'codex',
        category,
        version: sanitizedMajorMinor,
    });
}
```

Do not copy raw stderr, response bodies, paths, or full session IDs.
Attach `child.stderr.on('data', () => undefined)` immediately after spawn and
remove all owned stream listeners when the child exits or the client disposes.

- [ ] **Step 5: Implement Codex interaction normalization**

Call:

```ts
client.request('thread/read', {
    threadId: sessionId,
    includeTurns: true,
}, signal);
```

Validate `thread.id`, `turn.id`, `turn.items`, item IDs, and supported
`userMessage`/`agentMessage` shapes. Every `userMessage` begins a new
interaction even within one native turn. Agent messages attach to the most
recent qualifying input. Map an active turn to `inProgress`, failed/cancelled
to `interrupted`, and completed to `complete`. The public controller maps
`updateCodex` to `Update Codex to view conversation history`, maps
`unsupportedVersion` to `Installed Codex protocol is not supported`, and
never sends app-server error data to a Webview. Within `userMessage.content`,
map stable `text` inputs to visible text and stable `image`, `localImage`,
`audio`, and `localAudio` inputs to neutral attachment parts in source order;
discard unknown input variants and never copy URL/path fields.

- [ ] **Step 6: Run focused contracts and commit**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/codexAppServerClient.test.js
node --test tests/contract/aiSessions/codexConversationAdapter.test.js
git diff --check
```

```bash
git add src/aiSessions/conversation/codexAppServerClient.ts \
  src/aiSessions/conversation/codexAdapter.ts \
  tests/contract/aiSessions/codexAppServerClient.test.js \
  tests/contract/aiSessions/codexConversationAdapter.test.js \
  tests/fixtures/conversations/codex/thread-read.json
git commit -m "feat: read Codex conversations through app server"
```

---

### Task 6: Host conversation coordinator and sidebar protocol

**Files:**
- Create: `src/aiSessions/conversation/coordinator.ts`
- Create: `src/aiSessions/conversation/conversationHostController.ts`
- Create: `tests/contract/aiSessions/conversationCoordinator.test.js`
- Create: `tests/integration/dashboard/conversationRouting.test.js`
- Modify: `src/dashboard/messageRouter.ts`

**Interfaces:**
- Produces `ConversationCoordinator.readOutline`, `readPage`, `watch`,
  `releaseSubscription`, `setSessionStopped`, and `dispose`.
- Produces `ConversationHostController.handleOutline`,
  `handleOpen`, `cancel`, `reconcile`, `setVisible`, and `dispose`.
- Produces `AiSessionConversationOutlineRequestMessage` and
  `AiSessionConversationOutlineResultMessage`; both carry `projectId`,
  provider, and session identity outside the payload as commit guards.
- Consumes authoritative
  `resolveTarget(projectId, provider, sessionId)`; DOM labels and paths never
  enter adapters.

- [ ] **Step 1: Write failing authority, stale, isolation, and watch tests**

Assert:

- request IDs `0`, `-1`, `1.5`, and `Number.MAX_SAFE_INTEGER + 1` fail closed
  before target resolution;
- unsupported provider/session/project returns no adapter call;
- outline requires the active session to remain focused;
- request `9` cannot publish after request `10`;
- generation `3` cannot publish after generation `4`;
- a throwing Kimi adapter does not block Codex or Claude;
- revision tokens look like `r1`, contain no path/offset/hash, and are scoped to
  provider/session;
- forged or stale cursors return `staleRevision`;
- ten invalidations in 250 ms schedule one read, and publication is never more
  frequent than once per second;
- after a publish at `t=250`, an invalidation at `t=1,050` publishes at
  `t=1,300`—the later of its debounce deadline and the one-second rate floor;
- collapse/release during the 250 ms debounce cancels the scheduled read and
  publishes nothing;
- `setVisible(false)` and `dispose()` cancel subscriptions and publications.

Write the race and isolation assertions in
`tests/contract/aiSessions/conversationCoordinator.test.js` with deferred
adapter promises:

```js
const first = deferred();
const second = deferred();
const published = [];
const controller = createControllerHarness({
    outlineResults: [first.promise, second.promise],
    publish: message => published.push(message),
});

const request9 = controller.handleOutline(makeOutlineRequest({
    requestId: 9,
    subscriptionGeneration: 3,
}));
const request10 = controller.handleOutline(makeOutlineRequest({
    requestId: 10,
    subscriptionGeneration: 4,
}));
second.resolve(makeOutline('codex', 'session-a', 'native-b'));
await request10;
first.resolve(makeOutline('codex', 'session-a', 'native-a'));
await request9;
assert.deepEqual(published.map(message => [
    message.requestId,
    message.subscriptionGeneration,
]), [[10, 4]]);

const calls = { codex: 0, kimi: 0, claude: 0 };
const coordinator = createCoordinatorHarness({
    codex: adapterReturning(calls, 'codex'),
    kimi: adapterThrowing(calls, 'kimi', new Error('private provider detail')),
    claude: adapterReturning(calls, 'claude'),
});
await assert.rejects(
    coordinator.readOutline('kimi', 'kimi-session'),
    error => error.code === 'unavailable'
        && !JSON.stringify(error).includes('private provider detail')
);
await coordinator.readOutline('codex', 'codex-session');
await coordinator.readOutline('claude', 'claude-session');
assert.deepEqual(calls, { codex: 1, kimi: 1, claude: 1 });
```

Define `deferred`, `makeOutlineRequest`, `makeOutline`,
`createControllerHarness`, `createCoordinatorHarness`, `adapterReturning`, and
`adapterThrowing` as local test helpers in the same file. Each harness injects
fake timers, `resolveTarget`, adapters, and `publish`; it must expose timer
advancement so the same file can assert 250 ms coalescing and the one-second
publication floor without wall-clock sleeps:

```js
harness.invalidate();
harness.clock.advanceTo(250);
assert.equal(harness.publications.length, 1);
harness.clock.advanceTo(1050);
harness.invalidate();
harness.clock.advanceTo(1249);
assert.equal(harness.publications.length, 1);
harness.clock.advanceTo(1299);
assert.equal(harness.publications.length, 1);
harness.clock.advanceTo(1300);
assert.equal(harness.publications.length, 2);

const releaseHarness = createControllerHarness();
releaseHarness.invalidate();
releaseHarness.releaseSubscription();
releaseHarness.clock.advanceBy(250);
assert.equal(releaseHarness.adapterReadsAfterRelease, 0);
```

- [ ] **Step 2: Run focused tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/conversationCoordinator.test.js
node --test tests/integration/dashboard/conversationRouting.test.js
```

Expected: coordinator/controller modules and router handlers are missing.

- [ ] **Step 3: Implement scoped revisions, cursors, and adapter isolation**

Use keys from `getAiSessionKey(provider, sessionId)`. Maintain an integer public
revision per key and encode cursors as random coordinator-local map keys:

```ts
interface StoredCursor {
    key: string;
    revision: string;
    anchorInteractionId: string;
    direction: 'before' | 'after';
}
```

Never serialize provider paths, byte offsets, or native revisions into public
tokens. Convert adapter exceptions only to the five `ConversationPublicError`
codes and sanitized diagnostics.

- [ ] **Step 4: Implement versioned dashboard handlers**

Accept only:

```ts
export interface AiSessionConversationOutlineRequestMessage {
    type: 'request-ai-session-conversation-outline',
    version: 1,
    requestId: number,
    subscriptionGeneration: number,
    projectId: string,
    provider: 'codex' | 'kimi' | 'claude',
    sessionId: string,
}
```

Enforce `Number.isSafeInteger`,
`requestId >= CONVERSATION_LIMITS.minRequestId`,
non-negative `subscriptionGeneration`, and trimmed non-empty strings in the
runtime parser before constructing this interface.

Publish `ai-session-conversation-outline-result` with the same request ID and
generation, plus the authoritative `projectId`, provider, and session ID.
Its optional payload is a complete `ConversationOutline`, including the same
provider/session fields; mismatches fail closed. Define:

```ts
export interface AiSessionConversationOutlineResultMessage
    extends ConversationResponseEnvelope<ConversationOutline> {
    type: 'ai-session-conversation-outline-result';
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
}
```

`open-ai-session-conversation` validates the same identity plus a
known interaction ID, then delegates to the viewer callback injected into the
controller. `cancel-ai-session-conversation` increments the generation and
disposes the exact subscription.

Register these message types as ordinary exact handlers in
`createDashboardMessageRouter`; do not add provider-specific legacy aliases.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
npm run test-compile
node --test tests/contract/aiSessions/conversationCoordinator.test.js
node --test tests/integration/dashboard/conversationRouting.test.js
git diff --check
```

```bash
git add src/aiSessions/conversation/coordinator.ts \
  src/aiSessions/conversation/conversationHostController.ts \
  src/dashboard/messageRouter.ts \
  tests/contract/aiSessions/conversationCoordinator.test.js \
  tests/integration/dashboard/conversationRouting.test.js
git commit -m "feat: coordinate conversation history requests"
```

---

### Task 7: Safe reusable AI Conversation viewer

**Files:**
- Create: `src/aiSessions/conversation/markdown.ts`
- Create: `src/aiSessions/conversation/viewer.ts`
- Create: `src/webview/conversationViewerScripts.js`
- Create: `media/conversationViewer.scss`
- Create: `tests/unit/aiSessions/conversationMarkdown.test.js`
- Create: `tests/integration/dashboard/conversationViewer.test.js`
- Create: `tests/browser/conversationViewer.test.js`
- Modify: `gulpfile.js`
- Modify: `.vscodeignore`

**Interfaces:**
- Produces `renderConversationMarkdown(markdown): string`.
- Produces singleton `ConversationViewer.open(target)`, `refresh()`, and
  `dispose()`.
- Viewer navigation consumes `ConversationCoordinator.readPage/watch` directly;
  it does not route panel messages through the sidebar Webview.

Use these viewer contracts; production binds `readPage` and `watch` to the
coordinator, while integration tests inject fakes:

```ts
export interface ConversationViewerTarget {
    projectId: string;
    provider: AiSessionProviderId;
    sessionId: string;
    interactionId: string;
    expectedRevision: string;
    displayName: string;
    duplicateDisplayName: boolean;
}

export interface ConversationViewerOptions {
    createPanel: typeof vscode.window.createWebviewPanel;
    readPage: (
        request: ConversationPageRequest,
        signal: ConversationAbortSignal
    ) => Promise<ConversationPage>;
    watch: (
        provider: AiSessionProviderId,
        sessionId: string,
        onChange: () => void
    ) => AiSessionDisposable;
    restoreFocus: (target: ConversationViewerTarget) => void;
    openExternal: (uri: vscode.Uri) => Thenable<boolean>;
    mediaUri: (fileName: string) => vscode.Uri;
}

export interface ConversationViewerApi extends AiSessionDisposable {
    open(target: ConversationViewerTarget): Promise<void>;
    refresh(): Promise<void>;
}
```

The concrete exported `ConversationViewer` class implements
`ConversationViewerApi` and accepts `ConversationViewerOptions` in its
constructor.

- [ ] **Step 1: Write failing Markdown and viewer ownership tests**

Assert `renderConversationMarkdown` preserves headings, lists, fenced code, and
text while `markdown-it` with `html: false` escapes raw `<script>` as text and
its link validator removes non-HTTPS hrefs. This unit test does not import
DOMPurify or create a Node-side DOM; hostile post-render HTML is tested in the
Playwright Webview test below.
Create a fake `createWebviewPanel` and assert two `open()` calls reuse one panel,
the second session replaces and clears the first snapshot, and panel disposal
disposes its watch and calls the injected focus fallback. Hold the first
session's page promise, open the second session, then resolve the first; its
generation must not replace the second session's HTML or snapshot. Repeat with
navigation request `4` resolving after request `5`. Feed six bounded pages
whose union exceeds 100 interactions and 4 MiB; assert eviction removes the
farthest page, keeps the selected anchor, and leaves a cursor for the evicted
direction.

The ownership assertion is:

```js
const panel = fakePanel();
const pages = new Map([
    ['session-a', deferred()],
    ['session-b', deferred()],
]);
let restored = 0;
const viewer = new ConversationViewer({
    createPanel: () => panel,
    readPage: request => pages.get(request.sessionId).promise,
    watch: () => ({ dispose() {} }),
    restoreFocus: () => { restored += 1; },
    openExternal: async () => true,
    mediaUri: fileName => fakeUri(`media/${fileName}`),
});
const openA = viewer.open(target('session-a', 'input-a'));
const openB = viewer.open(target('session-b', 'input-b'));
pages.get('session-b').resolve(page('session-b', 'input-b', 'visible-b'));
await openB;
pages.get('session-a').resolve(page('session-a', 'input-a', 'visible-a'));
await openA;
assert.equal(panel.webview.html.includes('visible-b'), true);
assert.equal(panel.webview.html.includes('visible-a'), false);
assert.equal(panel.createCount, 1);
panel.dispose();
assert.equal(restored, 1);
assert.equal(viewer.snapshotSize, 0);
```

Keep the local `fakePanel`, `deferred`, `target`, and `page` helpers in this
test file; `fakePanel` records HTML, posted messages, disposal callbacks, and
the number of panel creations.

- [ ] **Step 2: Write the failing browser security/navigation test**

Load `node_modules/dompurify/dist/purify.min.js` and
`src/webview/conversationViewerScripts.js` in Playwright. Send a page containing
`<script>`, `onclick`, and `javascript:`, `data:`, `file:`, `command:`, and
`https:` links. Assert only the HTTPS link remains actionable. Also assert:

- Previous/Next/Latest post exact version-1 messages;
- `Input 4 of 12` updates to `Input 4 of 13`;
- historical scroll remains fixed on appended content;
- `New response content` focuses the first appended message;
- a latest viewer auto-follows at exactly the Host-rendered 8 px threshold but
  not at 9 px;
- Escape/close posts `conversation-viewer-closed`.

Use Playwright assertions against the rendered DOM, not implementation
classes:

```js
await page.evaluate(payload => window.dispatchEvent(
    new MessageEvent('message', { data: payload })
), hostileConversationPage);
await expect(page.locator('script')).toHaveCount(0);
await expect(page.locator('[onclick]')).toHaveCount(0);
await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
await expect(page.locator('a[href^="data:"]')).toHaveCount(0);
await expect(page.locator('a[href^="file:"]')).toHaveCount(0);
await expect(page.locator('a[href^="command:"]')).toHaveCount(0);
await expect(page.locator('a[href="https://example.test/safe"]')).toHaveCount(1);
await page.getByRole('button', { name: 'Next' }).click();
assert.deepEqual((await postedMessages(page)).at(-1), {
    type: 'conversation-viewer-next',
    version: 1,
});
```

`hostileConversationPage` is a literal version-1 page object declared in the
test and `postedMessages` reads the array captured by the fake VS Code API.

- [ ] **Step 3: Run focused tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/unit/aiSessions/conversationMarkdown.test.js
node --test tests/integration/dashboard/conversationViewer.test.js
node --test --test-concurrency=1 tests/browser/conversationViewer.test.js
```

Expected: Markdown, viewer, and viewer script modules are missing.

- [ ] **Step 4: Implement Markdown rendering and DOMPurify policy**

Create one `markdown-it` instance:

```ts
const markdown = new MarkdownIt({
    html: false,
    linkify: false,
    breaks: false,
});
```

Override `validateLink` to return true only for `https:`. In the client, call:

```js
var clean = DOMPurify.sanitize(message.html, {
    ALLOWED_TAGS: [
        'p', 'br', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li',
        'strong', 'em', 'del', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'a', 'span', 'section', 'article',
    ],
    ALLOWED_ATTR: ['href', 'class', 'data-message-id', 'data-interaction-id'],
});
```

Add an `afterSanitizeAttributes` hook that removes every `href` whose parsed
URL protocol is not exactly `https:`. Intercept retained links and post their
href to the Host; the Host revalidates `https:` before `vscode.env.openExternal`.

- [ ] **Step 5: Implement the reusable panel and CSP**

Create one `vscode.WebviewPanel` with `ViewColumn.Beside`,
`enableScripts: true`, and local roots limited to `media`. Its HTML CSP is:

```html
default-src 'none';
style-src {{cspSource}};
script-src 'nonce-{{nonce}}';
```

This CSP belongs to the standalone viewer panel; do not reuse the sidebar
Webview CSP and do not add `'unsafe-inline'` to either `script-src` or
`style-src`.

Render the shared scroll threshold from the Host contract:

```html
<body data-auto-scroll-threshold="{{CONVERSATION_LIMITS.autoScrollThresholdPx}}">
```

Load nonce-bearing `purify.min.js` before
`conversationViewerScripts.js`. Render provider/display name, shortened ID only
for a duplicate display name, `Input X of Y`, navigation buttons, bounded
message container, stale/error state, and `New response content`.

- [ ] **Step 6: Package viewer assets**

Add to `gulpfile.js` `copyNodeAssets`:

```js
const browserNodeAssets = [
    'node_modules/dompurify/dist/purify.min.js',
];
```

Gulp already copies `src/webview/*.js`. Add explicit VSIX allowlist lines:

```text
!media/conversationViewerScripts.js
!media/conversationViewer.css
!media/purify.min.js
```

- [ ] **Step 7: Run focused tests, build assets, and commit**

Run:

```bash
npm run test-compile
npx gulp --production
node --test tests/unit/aiSessions/conversationMarkdown.test.js
node --test tests/integration/dashboard/conversationViewer.test.js
node --test --test-concurrency=1 tests/browser/conversationViewer.test.js
git diff --check
```

```bash
git add src/aiSessions/conversation/markdown.ts \
  src/aiSessions/conversation/viewer.ts \
  src/webview/conversationViewerScripts.js \
  media/conversationViewer.scss media/conversationViewer.css \
  media/conversationViewerScripts.js media/purify.min.js \
  gulpfile.js .vscodeignore \
  tests/unit/aiSessions/conversationMarkdown.test.js \
  tests/integration/dashboard/conversationViewer.test.js \
  tests/browser/conversationViewer.test.js
git commit -m "feat: add safe AI conversation viewer"
```

---

### Task 8: Focused-card expansion shell and dynamic layout

**Files:**
- Modify: `src/webview/webviewContent.ts`
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Modify: `tests/integration/dashboard/sessionCardInteraction.test.js`
- Create: `tests/integration/dashboard/sessionConversationContent.test.js`
- Create: `tests/browser/activeSessionConversationOutline.test.js`

**Interfaces:**
- Produces `toggleActiveAiSessionConversation`, `applyActiveAiSessionConversationState`,
  `syncActiveAiSessionConversationListHeight`, and expanded state capture/restore.
- The shell exposes `data-ai-session-conversation-panel`,
  `data-ai-session-conversation-rail`, and one focused header with
  `aria-expanded`/`aria-controls`.
- Task 9 fills the shell with correlated outline results.

- [ ] **Step 1: Change the card-activation contract first**

Extend `sessionCardInteraction.test.js` so a non-focused active row still posts
`focus-ai-session-terminal`, while a focused active row returns:

```js
const focusedActivation = {
    handled: true,
    sessionRow: focusedRow,
    message: null,
    toggleConversation: true,
};
```

Nested pin/close/marker controls remain consumed with no activation or toggle.
Pending rows never expose `toggleConversation`.

- [ ] **Step 2: Write failing markup and Playwright layout tests**

Assert only a focused, non-pending Active Session row renders a chevron,
`aria-expanded="false"`, and a hidden Conversation shell. In Playwright assert:

- every row starts closed;
- clicking non-focused posts focus only;
- clicking focused opens/closes;
- opening B closes A;
- action buttons do not toggle;
- Enter/Space toggle and Escape closes/focuses the header;
- recreating the Webview document starts collapsed even when the prior
  document had an expanded card;
- the list height equals its base height plus exactly one measured row delta;
- a 900 px viewport shows the whole expansion;
- a 260 px viewport keeps the header visible and scrolls only the marker rail.

Drive the click contract and short-viewport assertions as follows:

```js
await page.setViewportSize({ width: 360, height: 900 });
await focusedCard.click();
await expect(focusedCard).toHaveAttribute('data-conversation-expanded', '');
await expect(focusedHeader).toHaveAttribute('aria-expanded', 'true');
await expect(conversationPanel).toBeVisible();
assert.equal(await isFullyInsideViewport(page, conversationPanel), true);

await page.setViewportSize({ width: 360, height: 260 });
await expect(focusedHeader).toBeVisible();
await expect(conversationPanel.locator('header')).toBeVisible();
assert.equal(await conversationRail.evaluate(node =>
    node.scrollHeight > node.clientHeight
    && getComputedStyle(node).overflowY === 'auto'
), true);
assert.equal(await conversationPanel.evaluate(node =>
    getComputedStyle(node).overflowY !== 'auto'
), true);

await nonFocusedCard.click();
assert.deepEqual((await postedMessages(page)).at(-1), {
    type: 'focus-ai-session-terminal',
    provider: 'kimi',
    sessionId: 'session-b',
});
await expect(nonFocusedCard).not.toHaveAttribute('data-conversation-expanded');
await expect(focusedCard).not.toHaveAttribute('data-conversation-expanded');
```

The test's `isFullyInsideViewport` compares `getBoundingClientRect()` with
`window.innerHeight`; its fake VS Code API stores posted messages in document
order.

- [ ] **Step 3: Run focused tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/sessionCardInteraction.test.js
node --test tests/integration/dashboard/sessionConversationContent.test.js
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js
```

Expected: focused rows still post terminal focus, and no expansion shell exists.

- [ ] **Step 4: Render the focused-card shell**

In `getActiveAiSessionRow`, render the shell only when
`model.focused && !model.pending`. Use:

```html
<span class="ai-session-conversation-chevron" aria-hidden="true">›</span>
<section class="ai-session-conversation-panel"
  data-ai-session-conversation-panel
  aria-label="Conversation"
  hidden>
  <header><span>Conversation</span><span data-ai-session-conversation-count>0</span></header>
  <div class="ai-session-conversation-loading" role="status">Loading conversation…</div>
  <div class="ai-session-conversation-rail"
    data-ai-session-conversation-rail
    data-auto-scroll-threshold="${CONVERSATION_LIMITS.autoScrollThresholdPx}"
    role="listbox"
    aria-label="User inputs"
    hidden></div>
</section>
```

The primary button owns `aria-expanded="false"` and `aria-controls`.
Non-focused rows render neither chevron nor shell.

- [ ] **Step 5: Implement one synchronous expansion state function**

`applyActiveAiSessionConversationState` must set, in one call:

- row `data-conversation-expanded`;
- panel `hidden`;
- header `aria-expanded`;
- chevron state;
- the single expanded key;
- outer list expansion delta;
- `scrollIntoView({ block: 'nearest' })`.

Use a `ResizeObserver` when available and a resize-event fallback. Compute:

```js
var naturalExpandedHeight = collapsedRowHeight + panel.scrollHeight;
var expansionDelta = Math.max(0, naturalExpandedHeight - collapsedRowHeight);
var availableListHeight = Math.max(
    collapsedRowHeight + conversationHeaderHeight + 72,
    window.innerHeight - list.getBoundingClientRect().top - 8
);
var renderedListHeight = Math.min(
    collapsedListHeight + expansionDelta,
    availableListHeight
);
var railHeight = Math.max(
    72,
    renderedListHeight
        - collapsedRowHeight
        - conversationHeaderHeight
        - panelVerticalChrome
);
```

Set `--steward-ai-session-expanded-extra-height` to
`renderedListHeight - collapsedListHeight` on the outer list and
`--steward-ai-session-conversation-rail-height` to `railHeight` on the row.
Keep the outer list scrollable so following cards remain reachable; only the
marker rail scrolls within the expanded card. Recalculate both variables after
row, list, or viewport resize.

`applyActiveAiSessionConversationState` must call
`syncActiveAiSessionConversationListHeight` synchronously immediately after it
unhides the panel; `ResizeObserver` handles only subsequent size changes. The
initial layout therefore does not wait for an observer callback or introduce a
one-frame unconstrained expansion.

- [ ] **Step 6: Capture and restore across authoritative replacements**

Before `replaceWith` in `applyWorkspaceUpdate`, capture provider/session,
expanded state, rail scrollTop, and focused marker. After replacement, restore
only if the same row still has `data-session-focused`; otherwise clear and post
`cancel-ai-session-conversation`. Apply visual class, panel hidden state,
chevron, height, and `aria-expanded` synchronously before requesting fresh
outline content. Keep this state only in the live document; do not write it
through `vscode.setState`, workspace state, or global state, so a full Webview
reload always starts closed.

Extend the existing state objects with exact optional fields:

```js
function captureExpandedConversationState(projectDiv) {
    var row = projectDiv.querySelector(
        '.active-ai-session-row[data-conversation-expanded]'
    );
    var rail = row?.querySelector('[data-ai-session-conversation-rail]');
    var marker = rail?.querySelector('[data-ai-session-conversation-marker]:focus');
    return row ? {
        provider: row.getAttribute('data-session-provider') || '',
        sessionId: row.getAttribute('data-session-id') || '',
        expanded: true,
        railScrollTop: rail?.scrollTop || 0,
        focusedInteractionId: marker?.getAttribute('data-interaction-id') || '',
    } : null;
}

function canRestoreExpandedConversation(projectDiv, state) {
    if (!state?.expanded) return null;
    return Array.from(projectDiv.querySelectorAll(
        '.active-ai-session-row[data-session-focused]'
    )).find(row =>
        row.getAttribute('data-session-provider') === state.provider
        && row.getAttribute('data-session-id') === state.sessionId
    ) || null;
}
```

Call the capture helper before `replaceWith`. After replacement, pass the
matched row once to `applyActiveAiSessionConversationState`, restore rail
scroll/focus, and then issue the fresh correlated outline request. If no row
matches, increment the local generation and post the exact cancel message.

- [ ] **Step 7: Add SCSS and run focused tests**

Use outer height:

```scss
height: calc(
  var(--steward-ai-session-list-max-height)
  + var(--steward-ai-session-expanded-extra-height, 0px)
);
```

Give the panel a bounded grid row, keep its header fixed, and make only
`.ai-session-conversation-rail` internally scrollable in constrained space
with `max-height:
var(--steward-ai-session-conversation-rail-height)`. Preserve the existing
outer list's `overflow-y: auto` so cards after the expanded row are reachable.

Run:

```bash
npm run test-compile
npx gulp --production
node --test tests/integration/dashboard/sessionCardInteraction.test.js
node --test tests/integration/dashboard/sessionConversationContent.test.js
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js
git diff --check
```

- [ ] **Step 8: Commit the expansion behavior**

```bash
git add src/webview/webviewContent.ts \
  src/webview/webviewProjectScripts.js \
  media/webviewProjectScripts.js \
  media/styles.scss media/styles.css \
  tests/integration/dashboard/sessionCardInteraction.test.js \
  tests/integration/dashboard/sessionConversationContent.test.js \
  tests/browser/activeSessionConversationOutline.test.js
git commit -m "feat: expand focused Active Session cards"
```

---

### Task 9: Sidebar outline rendering and marker navigation

**Files:**
- Modify: `src/webview/webviewProjectScripts.js`
- Modify: `media/styles.scss`
- Modify: `tests/integration/dashboard/webviewState.test.js`
- Modify: `tests/browser/activeSessionConversationOutline.test.js`

**Interfaces:**
- Consumes Task 6's outline response envelope and Task 8's expansion shell.
- Produces `renderActiveAiSessionConversationOutline`,
  `applyAiSessionConversationOutlineResult`, marker keyboard navigation, and
  `open-ai-session-conversation` messages.

- [ ] **Step 1: Write failing correlated outline tests**

Assert expanding posts:

```js
const expectedOutlineRequest = {
    type: 'request-ai-session-conversation-outline',
    version: 1,
    requestId: 1,
    subscriptionGeneration: 1,
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
};
```

Then assert an older request, older generation, wrong provider/session, closed
row, or no-longer-focused row cannot render. Loading, empty, unavailable,
stale, and `2,000+` states must be distinct. Assert the exact Codex states:

- `Reconnecting to Codex…` during a permitted one-/four-second restart;
- `Codex conversation history unavailable` with Retry disabled until
  `retryAfterMs` expires after the restart budget is exhausted;
- `Update Codex to view conversation history` for `updateCodex`;
- `Installed Codex protocol is not supported` plus a version-comparison hint
  for `unsupportedCodexProtocol`;
- `No user inputs yet` for valid empty history.

- [ ] **Step 2: Write failing marker behavior tests**

Given three summaries, assert oldest-to-newest ordering, grapheme counts mapped
to bounded CSS widths, latest emphasis, current low-noise state, 24 px hit
targets, 160-grapheme preview/title, and:

- ArrowUp/ArrowDown/Home/End move roving focus;
- with one marker, Home/End keep that marker focused and post nothing;
- Enter posts `open-ai-session-conversation`;
- a new live marker auto-reveals only when the rail was already at the end;
- first expansion scrolls only enough to reveal the latest marker and leaves
  `scrollTop` unchanged when all markers already fit;
- historical scroll and marker focus survive a matching HTML replacement.
- a preview containing `);background:url(javascript:...)` remains text/title
  only, while `--ai-input-ratio` is still a numeric string in `[0.18, 1]`.

Use a literal correlated result and assert the DOM/API surface:

```js
await postHostMessage(page, {
    type: 'ai-session-conversation-outline-result',
    version: 1,
    requestId: 1,
    subscriptionGeneration: 1,
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
    payload: {
        provider: 'codex',
        sessionId: 'session-a',
        sourceRevision: 'r1',
        totalInteractions: 3,
        partial: false,
        interactions: [
            summary('input-1', 10, 'First input'),
            summary('input-2', 40, 'Second input'),
            summary('input-3', 20, 'Latest input'),
        ],
    },
});
const markers = page.locator('[data-ai-session-conversation-marker]');
await expect(markers).toHaveCount(3);
await expect(markers.nth(0)).toHaveAttribute('data-interaction-id', 'input-1');
await expect(markers.nth(2)).toHaveAttribute('data-interaction-id', 'input-3');
await markers.nth(0).focus();
await page.keyboard.press('End');
await expect(markers.nth(2)).toBeFocused();
await page.keyboard.press('Enter');
assert.deepEqual((await postedMessages(page)).at(-1), {
    type: 'open-ai-session-conversation',
    version: 1,
    requestId: 2,
    subscriptionGeneration: 1,
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
    interactionId: 'input-3',
    expectedRevision: 'r1',
});
```

`summary`, `postHostMessage`, and `postedMessages` are local browser-test
helpers; previews are literal strings and no helper derives IDs or content
from DOM attributes.

- [ ] **Step 3: Run focused tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js
```

Expected: no outline response handler or markers exist.

- [ ] **Step 4: Render text safely without `innerHTML`**

Build marker elements with `document.createElement`, assign previews through
`textContent`, and set only numeric width custom properties:

```js
marker.style.setProperty(
    '--ai-input-ratio',
    String(Math.max(0.18, Math.min(1, summary.userGraphemeCount / longest)))
);
```

Do not insert provider text with `innerHTML`. Marker IDs, provider, session,
request, and revision are validated against the current expansion state before
render.

- [ ] **Step 5: Implement keyboard/open behavior and live-update scroll rules**

Use roving `tabindex`, `role="option"`, `aria-label` containing timestamp plus
preview, and `aria-selected`. Marker activation posts only the opaque
interaction ID and current public revision; no prompt text goes back to Host.
Parse the rail's numeric `data-auto-scroll-threshold` and preserve `scrollTop`
unless it was within that distance of its end. The Host always renders the
value from `CONVERSATION_LIMITS.autoScrollThresholdPx`; invalid/missing values
fail closed to no auto-scroll.
Retry posts a new correlated request only when enabled; keep it disabled until
the Host-provided `retryAfterMs` has elapsed.

Use this roving-focus core and route both click and Enter through the same
opaque activation function:

```js
function focusConversationMarker(markers, index) {
    var bounded = Math.max(0, Math.min(markers.length - 1, index));
    markers.forEach((marker, markerIndex) => {
        marker.tabIndex = markerIndex === bounded ? 0 : -1;
    });
    markers[bounded]?.focus();
}

function activateConversationMarker(marker, state, vscode) {
    if (!marker || !state.expanded || !state.sourceRevision) return;
    vscode.postMessage({
        type: 'open-ai-session-conversation',
        version: 1,
        requestId: ++state.requestId,
        subscriptionGeneration: state.subscriptionGeneration,
        projectId: state.projectId,
        provider: state.provider,
        sessionId: state.sessionId,
        interactionId: marker.getAttribute('data-interaction-id') || '',
        expectedRevision: state.sourceRevision,
    });
}
```

- [ ] **Step 6: Run focused tests, regenerate assets, and commit**

Run:

```bash
npm run test-compile
npx gulp --production
node --test tests/integration/dashboard/webviewState.test.js
node --test --test-concurrency=1 tests/browser/activeSessionConversationOutline.test.js
git diff --check
```

```bash
git add src/webview/webviewProjectScripts.js \
  media/webviewProjectScripts.js \
  media/styles.scss media/styles.css \
  tests/integration/dashboard/webviewState.test.js \
  tests/browser/activeSessionConversationOutline.test.js
git commit -m "feat: render Active Session conversation outlines"
```

---

### Task 10: Production composition, lifecycle, and end-to-end flow

**Files:**
- Create: `src/aiSessions/conversation/composition.ts`
- Modify: `src/dashboard.ts`
- Modify: `src/dashboard/viewProvider.ts`
- Modify: `src/aiSessions/conversation/conversationHostController.ts`
- Modify: `tests/integration/dashboard/conversationRouting.test.js`
- Modify: `tests/integration/dashboard/errorRecovery.test.js`
- Modify: `scripts/run-ai-session-safety-checks.js`

**Interfaces:**
- Consumes all adapters, coordinator, viewer, provider services, current
  workspace authority, sidebar `postMessage`, and VS Code panel APIs.
- Produces one extension-host conversation capability with deterministic
  visibility/disposal behavior and no content dependency on Codex JSONL.
- Produces `createConversationCapability(options)` so production construction
  is testable without importing the VS Code extension entrypoint.

Use this composition surface:

```ts
export interface ConversationCapability {
    controller: ConversationHostController;
    viewer: ConversationViewerApi;
    availability: 'available' | 'unavailable';
    dispose(): void;
}

export interface ConversationCapabilityOptions {
    services: Record<AiSessionProviderId, AiSessionService>;
    resolveTarget: (
        projectId: string,
        provider: AiSessionProviderId,
        sessionId: string
    ) => ActiveAiSessionViewModel | null;
    publish: (message: unknown) => Thenable<boolean>;
    createPanel: typeof vscode.window.createWebviewPanel;
    openExternal: typeof vscode.env.openExternal;
    spawnCodex: typeof childProcess.spawn;
    now: () => number;
    setTimer: typeof setTimeout;
    clearTimer: typeof clearTimeout;
    onDiagnostic: (event: SanitizedConversationDiagnostic) => void;
}

export function createConversationCapability(
    options: ConversationCapabilityOptions
): ConversationCapability;
```

- [ ] **Step 1: Write failing production-wiring and disposal tests**

Assert production composition:

- creates one adapter per provider and one coordinator;
- resolves the exact active focused row from
  `getCurrentWorkspaceActionTarget(projectId)`;
- creates at most one Codex app-server child per extension host;
- routes both outline and open messages;
- calls `reconcile()` after authoritative AI-session refresh;
- sidebar hide/dispose releases card subscriptions;
- viewer remains independent when the sidebar hides;
- extension disposal closes viewer, coordinator, adapters, and app-server;
- diagnostics contain provider/category/count/duration but no prompt, response,
  absolute path, or full UUID.
- a constructor dependency that throws produces one sanitized diagnostic and
  an `availability: 'unavailable'` capability whose handlers return public
  `unavailable`; extension activation and unrelated Dashboard routes continue.

The production test stubs constructors through
`createConversationCapability(options)` and asserts lifecycle counts:

```js
const events = [];
const harness = createDashboardConversationHarness({
    onCreateAdapter: provider => events.push(`adapter:${provider}`),
    onCreateCoordinator: () => events.push('coordinator'),
    onSpawnCodex: () => events.push('codex-child'),
    onDispose: name => events.push(`dispose:${name}`),
});
await harness.activate();
await harness.route(makeOutlineRequest({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
}));
await harness.route(makeOpenRequest({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
    interactionId: 'input-a',
}));
await harness.route(makeOpenRequest({
    projectId: 'project-a',
    provider: 'codex',
    sessionId: 'session-a',
    interactionId: 'input-b',
}));
assert.deepEqual(events.filter(event => event.startsWith('adapter:')), [
    'adapter:codex',
    'adapter:kimi',
    'adapter:claude',
]);
assert.equal(events.filter(event => event === 'coordinator').length, 1);
assert.equal(events.filter(event => event === 'codex-child').length, 1);
await harness.dispose();
assert.deepEqual(new Set(events.filter(event => event.startsWith('dispose:'))),
    new Set([
        'dispose:viewer',
        'dispose:coordinator',
        'dispose:codex',
        'dispose:kimi',
        'dispose:claude',
    ]));
```

Keep `createDashboardConversationHarness`, `makeOutlineRequest`, and
`makeOpenRequest` local to `conversationRouting.test.js`; the harness calls
`createConversationCapability` with fake constructor functions, provider
services, target resolution, publication, panel creation, clocks, and timers.

- [ ] **Step 2: Run focused integration tests and observe RED**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/conversationRouting.test.js
node --test tests/integration/dashboard/errorRecovery.test.js
node scripts/run-ai-session-safety-checks.js
```

Expected: production dashboard has no conversation imports or handlers.

- [ ] **Step 3: Compose adapters and authoritative target resolution**

In `composition.ts`, instantiate concrete adapters with the existing provider
services; `dashboard.ts` calls this factory once. Keep optional capability
failure inside the factory:

```ts
export function createConversationCapability(
    options: ConversationCapabilityOptions
): ConversationCapability {
    try {
        return createAvailableConversationCapability(options);
    } catch (_error) {
        options.onDiagnostic({
            event: 'conversation-read',
            category: 'unavailable',
        });
        return createUnavailableConversationCapability(options);
    }
}
```

The unavailable capability registers the same three exact message handlers,
publishes only `ConversationError('unavailable').toPublicError()`, never starts
an adapter or panel, and has an idempotent `dispose()`. It does not include the
caught error text.

Resolve a target only when:

```ts
const target = getCurrentWorkspaceActionTarget(projectId);
const active = target?.sessions.activeSessions.find(session =>
    session.provider === provider
    && session.sessionId === sessionId
);
```

Outline requests additionally require `active.focused === true`. Viewer page
requests may continue for the same stopped active session while its source
exists. Pass `active.executionState === 'stopped'` to response-state projection.

- [ ] **Step 4: Wire Host messages, visibility, refresh, and disposal**

Add exact router handlers:

```ts
const conversationHandlers = {
'request-ai-session-conversation-outline': message =>
    conversationHostController.handleOutline(message),
'open-ai-session-conversation': message =>
    conversationHostController.handleOpen(message),
'cancel-ai-session-conversation': message =>
    conversationHostController.cancel(message),
};
```

Place these keys in the existing `DashboardMessageHandlers.handlers` record;
do not add new provider-specialized optional fields or a parallel router branch.

Extend `SidebarStewardViewProviderOptions` with `onDisposed`, register
`webviewView.onDidDispose`, and make `onVisibleChanged(false)` call
`conversationHostController.setVisible(false)`. Add the coordinator and
viewer to `context.subscriptions`. Reconcile after AI-session refresh and after
active-terminal focus changes.

- [ ] **Step 5: Add one composition-level end-to-end flow**

Exercise the public sidebar message path with an injected Kimi source: request
the focused session outline, open one returned interaction, assert one
`AI Conversation` panel is created, close it, and assert no prompt text reaches
the injected diagnostic sink.

Add this scenario to
`tests/integration/dashboard/conversationRouting.test.js`:

```js
test('opens one read-only AI Conversation panel through the composed Kimi flow', async t => {
    const fixture = await createKimiConversationFixture(t, [
        { user: 'extension-host-private-prompt', assistant: 'visible response' },
    ]);
    const harness = createDashboardConversationHarness({
        providerHomes: { kimi: fixture.providerHome },
        focusedSession: fixture.session,
    });
    const outline = await harness.requestOutline(fixture.session);
    assert.equal(outline.payload.interactions.length, 1);
    await harness.openInteraction(
        fixture.session,
        outline.payload.interactions[0].id,
        outline.payload.sourceRevision
    );
    assert.equal(harness.panels.filter(panel =>
        panel.title === 'AI Conversation'
    ).length, 1);
    harness.panels[0].dispose();
    assert.equal(
        JSON.stringify(harness.diagnostics)
            .includes('extension-host-private-prompt'),
        false
    );
});
```

`createKimiConversationFixture` writes only inside a temporary Kimi provider
home registered with `t.after`, using the committed
canonical Kimi provider fixture under `tests/fixtures/providers/kimi/home`.
The performance and composition harnesses reuse that same
`{ timestamp, message: { type, payload } }` schema so lifecycle discovery and
conversation normalization cannot drift. The composition harness uses the
concrete Kimi adapter and fake panel/publication dependencies.

- [ ] **Step 6: Run focused integration and safety tests**

Run:

```bash
npm run test-compile
node --test tests/integration/dashboard/conversationRouting.test.js
node --test tests/integration/dashboard/errorRecovery.test.js
node scripts/run-ai-session-safety-checks.js
git diff --check
```

Expected: all focused tests pass; the safety script proves app-server-only
Codex content and sanitized diagnostics.

- [ ] **Step 7: Commit production composition**

```bash
git add src/dashboard.ts \
  src/aiSessions/conversation/composition.ts \
  src/dashboard/viewProvider.ts \
  src/aiSessions/conversation/conversationHostController.ts \
  tests/integration/dashboard/conversationRouting.test.js \
  tests/integration/dashboard/errorRecovery.test.js \
  scripts/run-ai-session-safety-checks.js
git commit -m "feat: wire Active Session conversation history"
```

---

### Task 11: Performance, platform, security, packaging, and audit gates

**Files:**
- Create: `scripts/run-conversation-performance-checks.js`
- Create: `tests/platform/windows/conversationSources.test.js`
- Create: `tests/platform/macos/conversationSources.test.js`
- Create: `tests/platform/remote/conversationSources.test.js`
- Modify: `package.json`
- Modify: `.github/workflows/scheduled-verification.yml`
- Modify: `scripts/run-architecture-guards.js`
- Modify: `tests/unit/tooling/architectureGuards.test.js`
- Modify: `tests/integration/dashboard/styles.test.js`
- Modify: `scripts/run-release-packaging-checks.js`
- Modify: `docs/testing/behavior-contracts.json`
- Modify: `docs/testing/main-capability-coverage.json`

**Interfaces:**
- Produces deterministic P0 behavior ownership, architecture boundary guards,
  Linux performance evidence, Windows/macOS signature evidence, and a complete
  packaged VSIX containing every viewer asset.

- [ ] **Step 1: Add failing release, style, architecture, and platform checks**

Require these VSIX entries:

```js
const requiredConversationViewerEntries = [
    'extension/media/conversationViewer.css',
    'extension/media/conversationViewerScripts.js',
    'extension/media/purify.min.js',
];
```

Add `ARCH-AI-SESSION-CONVERSATION-BOUNDARY-001` to reject:

- `fs`, `node:fs` subpaths, or transcript `source`/`jsonlReader` modules
  anywhere in the transitive local relative-import graph reachable from the
  Codex adapter, while allowing the structured app-server client path;
- extension-host TypeScript imports of `dompurify` or `purify.min.js`;
- missing 64 MiB/5 s/1 MiB/20/512 KiB/16 MiB/10 s/8 px/minimum
  request ID/per-provider cache constants;
- Webview marker rendering through prompt-bearing `innerHTML`;
- raw app-server stderr or response logging;
- unbounded provider watchers.

Add controlled-mutation unit tests for each guard. Windows tests force the
portable hash signature and `noFollowFlag: 0` realpath/stat fallback; macOS
tests assert device/inode/birth-time identity. The remote
test runs the same provider service three times with environment labels
`ssh-remote`, `wsl`, and `dev-container`, injecting distinct UI-side and
extension-host homes; every case must resolve only the file beneath the
extension-host provider home.

- [ ] **Step 2: Add the Linux performance harness**

Generate deterministic synthetic fixtures in a temporary directory, outside
the repository. Measure with `process.hrtime.bigint()` and assert:

```js
assert.ok(coldMs <= 1500, `cold outline ${coldMs}ms exceeds 1500ms`);
assert.ok(appendMs <= 250, `append ${appendMs}ms exceeds 250ms`);
assert.ok(cachedOutlineReadMs <= 100,
    `cached adapter outline read ${cachedOutlineReadMs}ms exceeds 100ms`);
assert.ok(outline.interactions.length <= 2000);
assert.ok(serializedPageBytes <= 512 * 1024);
assert.ok(retainedInteractions <= 100);
assert.ok(retainedBytes <= 4 * 1024 * 1024);
```

The fixture contains 10 MiB/1,000 interactions for cold/cached checks, a 1 MiB
append, a 64 MiB boundary, and 2,001 interactions. Add
`test:conversation-performance` and invoke it from `test:ci:linux` after
deterministic tests. Add `test:conversation-sources:remote` for the three
extension-host-home cases and invoke it from `test:ci:linux` as well.

- [ ] **Step 3: Wire Windows and scheduled macOS checks**

Append `tests/platform/windows/conversationSources.test.js` to
`test:ci:windows`. Add a scheduled macOS step:

```yaml
- name: Verify conversation source identity
  run: npm run test-compile && node --test tests/platform/macos/conversationSources.test.js
```

Insert it before the existing stable Extension Host smoke. Update
`scripts/run-release-packaging-checks.js` so the scheduled-macOS contract
requires exactly five steps, requires this exact command at index 3 and the
stable Extension Host smoke at index 4, and retains the controlled mutations
that reject added/removed/reordered steps.

- [ ] **Step 4: Register behavior contracts**

Add these entries to `docs/testing/behavior-contracts.json` with the listed
owners and production evidence:

```json
{
  "id": "SESSION-AI-SESSION-CONVERSATION-ADAPTER-001",
  "domain": "session",
  "title": "Codex, Kimi, and Claude normalize only visible user and assistant conversation content",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/contract/aiSessions/codexConversationAdapter.test.js",
    "tests/contract/aiSessions/kimiConversationAdapter.test.js",
    "tests/contract/aiSessions/claudeConversationAdapter.test.js"
  ],
  "evidence": [
    "src/aiSessions/conversation/codexAdapter.ts",
    "src/aiSessions/conversation/kimiAdapter.ts",
    "src/aiSessions/conversation/claudeAdapter.ts"
  ]
}
```

```json
{
  "id": "WEBVIEW-AI-SESSION-CONVERSATION-OUTLINE-001",
  "domain": "webview",
  "title": "One focused Active Session expands into a correlated user-input outline",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/integration/dashboard/sessionCardInteraction.test.js",
    "tests/browser/activeSessionConversationOutline.test.js"
  ],
  "evidence": [
    "src/webview/webviewContent.ts",
    "src/webview/webviewProjectScripts.js",
    "media/styles.scss"
  ]
}
```

```json
{
  "id": "WEBVIEW-AI-SESSION-CONVERSATION-VIEWER-001",
  "domain": "webview",
  "title": "Conversation markers open one bounded sanitized read-only viewer",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/integration/dashboard/conversationViewer.test.js",
    "tests/browser/conversationViewer.test.js"
  ],
  "evidence": [
    "src/aiSessions/conversation/viewer.ts",
    "src/aiSessions/conversation/markdown.ts",
    "src/webview/conversationViewerScripts.js"
  ]
}
```

```json
{
  "id": "SECURITY-AI-SESSION-CONVERSATION-SOURCE-001",
  "domain": "session",
  "title": "Conversation history enforces canonical sources, opaque protocol tokens, and bounded private content",
  "priority": "P0",
  "status": "automated",
  "owners": [
    "tests/contract/aiSessions/conversationSources.test.js",
    "tests/contract/aiSessions/conversationCoordinator.test.js",
    "tests/unit/tooling/architectureGuards.test.js"
  ],
  "evidence": [
    "src/aiSessions/conversation/source.ts",
    "src/aiSessions/conversation/coordinator.ts",
    "scripts/run-architecture-guards.js"
  ]
}
```

- [ ] **Step 5: Run focused gates and commit gate infrastructure**

Run:

```bash
npm run test-compile
node --test tests/unit/tooling/architectureGuards.test.js
node --test tests/platform/windows/conversationSources.test.js
node --test tests/platform/macos/conversationSources.test.js
node --test tests/platform/remote/conversationSources.test.js
npm run test:conversation-performance
npm run test:release-packaging
npm run test:dashboard
git diff --check
```

Expected: all commands exit 0; the VSIX contains all three viewer assets; four
new P0 behavior IDs are present in the catalog.

```bash
git add scripts/run-conversation-performance-checks.js \
  tests/platform/windows/conversationSources.test.js \
  tests/platform/macos/conversationSources.test.js \
  tests/platform/remote/conversationSources.test.js \
  package.json package-lock.json \
  .github/workflows/scheduled-verification.yml \
  scripts/run-architecture-guards.js \
  tests/unit/tooling/architectureGuards.test.js \
  tests/integration/dashboard/styles.test.js \
  scripts/run-release-packaging-checks.js \
  docs/testing/behavior-contracts.json
git commit -m "test: gate conversation outline behavior"
```

- [ ] **Step 6: Update the main-capability audit with real hashes**

Run:

```bash
git log --reverse --format='%H %s' origin/main..HEAD
```

Add `MAIN-AI-SESSION-CONVERSATION-OUTLINE` with:

- every implementation commit from Tasks 1–10 plus the Task 11 gate commit;
- the four behavior IDs above;
- `prGates: ["test:ci:linux"]`;
- `scheduledJobs: ["scheduled-macos"]`;
- `realEnvironmentRequired: false`.

Set `audit.head` to the full Task 11 gate commit hash. Add the two design
commits and this plan commit to `ignoredDocumentationCommits`, using their full
hashes from the log. Do not add the forthcoming audit-only commit: it is
allowed after `audit.head` because it changes only `docs/`.

Run and commit:

```bash
npm run test:behavior-contracts
git diff --check
git add docs/testing/main-capability-coverage.json
git commit -m "docs: audit conversation outline coverage"
```

Expected: behavior and capability coverage pass with no unaudited
implementation commit.

- [ ] **Step 7: Run complete verification from the final audit commit**

Run:

```bash
npm run test:ci:linux
git status --short
git log --oneline origin/main..HEAD
```

Expected:

- complete Linux CI exits 0;
- unit, contract, integration, browser, safety, Dashboard, architecture,
  performance, release packaging, Extension build, and coverage gates pass;
- the feature worktree is clean;
- ten feature commits, one gate commit, and one documentation-only audit commit
  follow the two design commits and this plan commit;
- the primary checkout still contains only the user's pre-existing
  `.vscode/settings.json` change.
