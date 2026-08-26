'use strict';

import type { AiSessionProviderId } from '../../models';
import type { AiSessionDisposable } from '../types';
import type {
    BaselineRow,
    CommitFile,
    CommitSummary,
    CommitsDegraded,
} from '../../worktrees';

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
    toolCallSummaryGraphemes: 160,
    toolCallDetailGraphemes: 4_000,
    maxQuestionsPerBlock: 8,
    maxQuestionOptions: 8,
    questionTextGraphemes: 2_000,
    questionHeaderGraphemes: 100,
    questionOptionLabelGraphemes: 500,
    questionOptionDescriptionGraphemes: 2_000,
    questionAnswerGraphemes: 2_000,
    questionSourceGraphemes: 100,
    planFilePathGraphemes: 1_000,
    maxDiffsPerToolCall: 8,
    maxDiffLinesPerFile: 400,
    diffLineGraphemes: 500,
    diffPathGraphemes: 1_000,
    diffSynthesizeMaxLines: 400,
    maxViewerInteractions: 100,
    maxViewerBytes: 4 * 1024 * 1024,
    // thread/read returns the complete normalized history in one JSONL frame.
    maxCodexResponseBytes: 64 * 1024 * 1024,
    codexRequestTimeoutMs: 10_000,
    // Bound a reused panel's wait for the incoming Webview page receipt.
    viewerPublicationAckTimeoutMs: 4_000,
    invalidationDebounceMs: 250,
    invalidationMinIntervalMs: 1_000,
    telemetryRefreshMs: 5_000,
    autoScrollThresholdPx: 8,
    minRequestId: 1,
    inactiveIndexLimitPerProvider: 8,
    inactiveIndexTtlMs: 10 * 60 * 1000,
});

export type ConversationResponseState =
    'complete' | 'inProgress' | 'interrupted' | 'unknown';

export interface ConversationToolCall {
    /** Assistant text chunks already emitted when the call arrived. */
    position: number;
    name: string;
    summary: string;
    detail?: string;
    diffs?: ConversationFileDiff[];
}

export interface ConversationDiffLine {
    type: 'add' | 'del' | 'context';
    text: string;
}

export interface ConversationDiffHunk {
    /** Present when parsed from a unified diff; absent for edit fragments. */
    oldStart?: number;
    newStart?: number;
    lines: ConversationDiffLine[];
    truncatedLines?: number;
}

export interface ConversationFileDiff {
    path: string;
    /** 'add' | 'update' | 'delete' or the provider's raw change kind. */
    kind?: string;
    additions: number;
    deletions: number;
    hunks: ConversationDiffHunk[];
}

export interface ConversationThinkingBlock {
    /** Assistant text chunks already emitted when the thinking arrived. */
    position: number;
    text: string;
}

export interface ConversationPlanBlock {
    /** Assistant text chunks already emitted when the plan arrived. */
    position: number;
    markdown: string;
    filePath?: string;
}

export interface ConversationQuestionOption {
    label: string;
    description?: string;
}

export interface ConversationQuestionItem {
    question: string;
    header?: string;
    options: ConversationQuestionOption[];
    multiSelect: boolean;
    /** Free-text affordance label when the prompt offered one. */
    otherLabel?: string;
    /** Option labels or free text the user settled on; read-only replay. */
    answers?: string[];
}

export const CONVERSATION_QUESTION_OUTCOMES = Object.freeze([
    'approved',
    'revised',
    'rejected',
    'answered',
    'dismissed',
    'pending',
] as const);

export type ConversationQuestionOutcome =
    typeof CONVERSATION_QUESTION_OUTCOMES[number];

export interface ConversationQuestionBlock {
    /** Assistant text chunks already emitted when the question arrived. */
    position: number;
    /** Originating tool/event name, e.g. 'ExitPlanMode' | 'AskUserQuestion'. */
    source: string;
    questions: ConversationQuestionItem[];
    outcome?: ConversationQuestionOutcome;
}

export type ConversationAssistantPhase = 'progress' | 'answer';

export interface ConversationInteraction {
    id: string;
    providerTurnId?: string;
    timestamp?: number;
    /** Last contributing provider event time; the turn's work end marker. */
    completedAt?: number;
    userMarkdown: string;
    userPreview: string;
    userGraphemeCount: number;
    assistantMarkdown: string[];
    assistantPhases?: ConversationAssistantPhase[];
    toolCalls?: ConversationToolCall[];
    thinking?: ConversationThinkingBlock[];
    plans?: ConversationPlanBlock[];
    questions?: ConversationQuestionBlock[];
    responseState: ConversationResponseState;
}

export interface ConversationOutline {
    provider: AiSessionProviderId;
    sessionId: string;
    sourceRevision: string;
    interactions: Array<Omit<ConversationInteraction,
        'userMarkdown' | 'assistantMarkdown' | 'assistantPhases'>>;
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
    role: 'user' | 'assistant' | 'progress' | 'tool' | 'thinking'
        | 'plan' | 'question';
    timestamp?: number;
    markdown: string;
    tool?: Omit<ConversationToolCall, 'position'>;
    thinking?: Omit<ConversationThinkingBlock, 'position'>;
    plan?: Omit<ConversationPlanBlock, 'position'>;
    question?: Omit<ConversationQuestionBlock, 'position'>;
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
        timestamp?: number;
        completedAt?: number;
    }>;
    previousCursor?: string;
    nextCursor?: string;
    isStart: boolean;
    isEnd: boolean;
}

export interface ConversationSnapshot {
    outline: ConversationOutline;
    page?: ConversationPage;
}

export interface ConversationTelemetryWorktree {
    branch: string;
    worktreeRoot: string;
    repoRoot: string;
    /** The worktree path no longer exists; branch comes from session logs. */
    missing?: boolean;
}

export interface ConversationTelemetry {
    provider: AiSessionProviderId;
    sessionId: string;
    model?: string;
    worktree?: ConversationTelemetryWorktree;
    context?: {
        usedTokens: number;
        maxTokens: number;
    };
    rateLimits: Array<{
        id: string;
        label: string;
        usedPercent: number;
        windowDurationMins?: number;
        resetsAt?: number;
    }>;
}

export interface ConversationPublicError {
    code: 'unavailable' | 'staleRevision' | 'unsupportedVersion'
        | 'tooLarge' | 'timeout';
    reason?: 'missingSource' | 'updateCodex' | 'unsupportedCodexProtocol'
        | 'reconnectingCodex' | 'codexRetryExhausted';
    retryAfterMs?: number;
}

// ── Worktree changes panel (changes-panel PRD) ──────────────────

export type ConversationChangesAvailability =
  | 'available'
  | 'baselineUnavailable'
  | 'historyRewritten'
  | 'unreadable';

/**
 * Tracking-branch state (changes-panel PRD §14.1): `none` = no upstream
 * configured (a stated fact), `unknown` = the fact query failed —
 * never rendered as zero.
 */
export type ConversationChangesUpstream =
  | {
        status: 'tracked';
        /** Upstream full ref; the webview strips 'refs/remotes/' to display. */
        fullRef: string;
        sha: string;
        ahead: number;
        behind: number;
    }
  | { status: 'none' }
  | { status: 'unknown' };

export interface ConversationChangesMemberView {
    memberId: string;
    repoLabel: string;
    branchName: string;
    worktreePath: string;
    availability: ConversationChangesAvailability;
    /** SCM resource-row count; a staged+unstaged file counts twice. */
    workingItemCount: number;
    aheadCount?: number;
    /** Task-result net file count (baseline → current worktree). */
    taskFileCount?: number;
    truncated: boolean;
    /** HEAD sha at collection time; absent for unreadable members. */
    headSha?: string;
    /** Tracking-branch state (PRD §14.1); absent for unreadable members. */
    upstream?: ConversationChangesUpstream;
    /** Repository outside the open workspace (detached member). */
    detached?: boolean;
}

export interface ConversationChangesFileItem {
    group: 'merge' | 'staged' | 'changes' | 'untracked';
    xy: string;
    path: string;
    originalPath?: string;
}

export interface ConversationChangesDetail {
    memberId: string;
    availability: ConversationChangesAvailability;
    baselineSha?: string;
    aheadCount?: number;
    taskFileCount?: number;
    items: ConversationChangesFileItem[];
    truncated: boolean;
}

export interface ConversationChangesAggregateView {
    completeness: 'complete' | 'partial' | 'unavailable';
    workingItemCount: number;
    workingPartial: boolean;
    aheadCount?: number;
    aheadPartial: boolean;
    allUnreadable: boolean;
}

export interface ConversationChangesState {
    kind: 'ready' | 'retired' | 'unavailable';
    aggregate: ConversationChangesAggregateView;
    members: ConversationChangesMemberView[];
    selectedMemberId?: string;
    detail?: ConversationChangesDetail;
    collectedAt: number;
}

/**
 * Commits-tab responses (changes-panel PRD §14.3): correlated by
 * requestId and stamped with the subscription generation, so the webview
 * drops stale or superseded responses. The payload types are the
 * collector's own (src/worktrees/commitsCollector.ts) — the wire shape
 * is the host data shape.
 */
export interface ConversationCommitsListMessage {
    type: 'conversation-viewer-commits';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    memberId: string;
    scope: 'since-start' | 'full';
    offset: number;
    historyHead: string;
    commits: CommitSummary[];
    hasMore: boolean;
    sectionComplete?: boolean;
    baselineRow?: BaselineRow;
    degraded?: CommitsDegraded;
}

export interface ConversationCommitDetailMessage {
    type: 'conversation-viewer-commit-detail';
    version: 1;
    requestId: string;
    subscriptionGeneration: number;
    memberId: string;
    sha: string;
    files: CommitFile[];
    totalFiles: number;
    filesTruncated: boolean;
    degraded?: CommitsDegraded;
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
        | 'codex-conversation-app-server' | 'conversation-follow';
    provider?: AiSessionProviderId;
    category: 'spawn' | 'timeout' | 'protocol' | 'oversized' | 'exit'
        | 'unavailable' | 'malformed' | 'partial'
        | 'empty' | 'unknownSession';
    count?: number;
    durationMs?: number;
    version?: string;
    /** First 12 hex chars of the sha256 of the clicked session id. */
    sessionIdHash?: string;
    /** Present only when a subagent effective id differs from sessionId. */
    effectiveSessionIdHash?: string;
    /** Whether the authoritative snapshot came from warmup or a fresh read. */
    snapshotSource?: 'warm' | 'fresh';
    /** An empty warm snapshot was discarded and confirmed by a fresh read. */
    discardedEmptyWarmSnapshot?: boolean;
    outlineInteractions?: number;
    sourceRevision?: string;
    sourceSize?: number;
    cachedNextOffset?: number;
    cachedInteractions?: number;
    continuation?: boolean;
    partial?: boolean;
}

/** Read-only cache introspection for diagnosing empty/stale follows. */
export interface ConversationCacheDiagnostics {
    sourceSize?: number;
    cachedNextOffset?: number;
    cachedInteractions?: number;
    continuation?: boolean;
    partial?: boolean;
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

export interface ConversationSubagentEntry {
    id: string;
    label: string;
    agentType?: string;
    status: 'running' | 'idle' | 'quiet' | 'failed' | 'killed';
    createdAt?: number;
    updatedAt?: number;
}

export interface ConversationProviderAdapter extends AiSessionDisposable {
    readSnapshot?(
        sessionId: string,
        preferredInteractionId?: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSnapshot>;
    readOutline(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationOutline>;
    readPage(
        request: ConversationPageRequest,
        signal?: ConversationAbortSignal
    ): Promise<ConversationPage>;
    readSubagents?(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationSubagentEntry[]>;
    readTelemetry?(
        sessionId: string,
        signal?: ConversationAbortSignal
    ): Promise<ConversationTelemetry | undefined>;
    getCacheDiagnostics?(
        sessionId: string
    ): ConversationCacheDiagnostics | undefined;
    watch(sessionId: string, onChange: () => void): AiSessionDisposable;
}
