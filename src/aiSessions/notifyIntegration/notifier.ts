'use strict';

import * as path from 'path';
import type { AiSessionAttentionEvent } from '../attentionMonitor';
import { createCorrelationId } from '../notify/correlation';
import type { NotifyPayload, NotifyReason } from '../notify/types';

export interface NotifyPayloadContext {
    providerId: string;
    projectLabel: string;
    sessionLabel: string;
    hostLabel: string;
    runStartedAtMs: number;
    projectPathMode?: 'basename' | 'full';
    includeSessionLabel?: boolean;
}

export function buildNotifyPayload(
    event: AiSessionAttentionEvent,
    context: NotifyPayloadContext
): NotifyPayload {
    const correlationId = createCorrelationId(event.eventId);
    const projectLabel = context.projectPathMode === 'full'
        ? context.projectLabel
        : path.basename(context.projectLabel) || context.projectLabel;
    return {
        eventId: event.eventId,
        correlationId,
        providerId: context.providerId,
        reason: event.reason as NotifyReason,
        projectLabel,
        sessionLabel: context.includeSessionLabel === false
            ? `#${correlationId}`
            : context.sessionLabel,
        hostLabel: context.hostLabel,
        runStartedAtMs: context.runStartedAtMs,
        occurredAtMs: event.detectedAt,
    };
}
