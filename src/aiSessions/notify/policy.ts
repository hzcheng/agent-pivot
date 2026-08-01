'use strict';

import type { NotifyPayload, NotifyPolicy } from './types';

export type PolicyDecision =
    | { action: 'send' }
    | { action: 'skip'; reason: string }
    | { action: 'merge' };

export interface PolicyContext {
    alreadyNotified: boolean;
    acknowledged: boolean;
    sentWithinLastMinute: number;
}

export function evaluateNotifyPolicy(
    payload: NotifyPayload,
    policy: NotifyPolicy,
    context: PolicyContext
): PolicyDecision {
    if (context.acknowledged) {
        return { action: 'skip', reason: 'acknowledged' };
    }
    if (context.alreadyNotified) {
        return { action: 'skip', reason: 'already-notified' };
    }
    if (!policy.reasons.includes(payload.reason)) {
        return { action: 'skip', reason: 'reason-filtered' };
    }
    if (payload.occurredAtMs - payload.runStartedAtMs < policy.minRunDurationMs) {
        return { action: 'skip', reason: 'too-short' };
    }
    if (context.sentWithinLastMinute >= policy.rateLimitPerMin) {
        return { action: 'merge' };
    }
    return { action: 'send' };
}
