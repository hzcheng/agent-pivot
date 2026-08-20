'use strict';

/**
 * Attention session identity codecs (MOD-SHARED-KERNEL): the canonical
 * encodings every module may depend on without importing the attention
 * pipeline itself. Moved out of aiSessions/attentionProject.ts so runtime
 * settlement and workspace projections do not edge back into
 * MOD-AI-SESSION-ATTENTION (Stage 5 attention wave).
 *
 * The logical session-key encoding is a persisted/surface contract:
 * byte-stable, never change without a migration.
 */

import type { AiSessionProviderId } from './models';
import type { AiSessionRuntimeBackendId } from './aiSessions/runtimeTypes';

export function getAttentionRuntimeSessionKey(input: {
    workspaceScopeIdentity: string;
    provider: AiSessionProviderId;
    sessionId: string;
    runStartedAtMs: number;
    backend: AiSessionRuntimeBackendId;
}): string {
    return `${input.workspaceScopeIdentity}:${input.provider}:${input.sessionId}:${input.runStartedAtMs}:${input.backend}`;
}

export function getLogicalAttentionSessionKey(sessionKey: string): string {
    const match = /^(?:[a-f0-9]{64}:)?(codex|kimi|claude):(.+):\d+:(?:vscode|tmux)$/.exec(sessionKey || '');
    return match ? `${match[1]}:${match[2]}` : sessionKey;
}
