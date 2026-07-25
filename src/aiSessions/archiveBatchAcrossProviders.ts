'use strict';

import { isAiSessionProviderId } from '../models';
import type { AiSessionProviderId, CodexSession } from '../models';
import {
    MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES,
    MAX_BATCH_AI_SESSION_ID_LENGTH,
    MAX_RETAINED_BATCH_AI_SESSION_REJECTED_IDS,
} from './archiveBatch';

export interface AiSessionArchiveItem {
    provider: AiSessionProviderId;
    sessionId: string;
}

export interface AggregateAiSessionArchiveResult {
    archived: AiSessionArchiveItem[];
    running: AiSessionArchiveItem[];
    missing: AiSessionArchiveItem[];
    rejected: AiSessionArchiveItem[];
    rejectedCount: number;
    failed: AiSessionArchiveItem[];
    malformedCount: number;
}

export interface ResolvedAiSessionArchiveItem extends AiSessionArchiveItem {
    session: CodexSession;
}

export interface AggregateAiSessionArchiveSelection {
    eligible: ResolvedAiSessionArchiveItem[];
    rejected: AiSessionArchiveItem[];
    rejectedCount: number;
    malformedCount: number;
}

export interface ResolveAggregateAiSessionArchiveSelectionScope {
    selectedProviders: readonly AiSessionProviderId[];
    sessionsByProvider: Partial<Record<AiSessionProviderId, readonly CodexSession[]>>;
}

export function getAiSessionArchiveItemKey(item: AiSessionArchiveItem): string {
    return JSON.stringify([item.provider, item.sessionId]);
}

export function resolveAggregateAiSessionArchiveSelection(
    items: unknown,
    scope: ResolveAggregateAiSessionArchiveSelectionScope
): AggregateAiSessionArchiveSelection {
    const allValues = Array.isArray(items) ? items : [];
    const values = allValues.slice(0, MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES);
    const selectedProviders = new Set(scope.selectedProviders.filter(isAiSessionProviderId));
    const seen = new Set<string>();
    const eligible: ResolvedAiSessionArchiveItem[] = [];
    const rejected: AiSessionArchiveItem[] = [];
    let rejectedCount = 0;
    let malformedCount = Array.isArray(items)
        ? Math.max(0, allValues.length - MAX_BATCH_AI_SESSION_ARCHIVE_REQUEST_ENTRIES)
        : 1;

    for (const value of values) {
        if (!isArchiveItemRecord(value)
            || typeof value.provider !== 'string'
            || typeof value.sessionId !== 'string'
            || value.sessionId.length > MAX_BATCH_AI_SESSION_ID_LENGTH
            || !value.sessionId.trim()) {
            malformedCount++;
            continue;
        }

        const provider = value.provider;
        const sessionId = value.sessionId.trim();
        if (!isAiSessionProviderId(provider)) {
            rejectedCount++;
            continue;
        }

        const item = { provider, sessionId };
        const key = getAiSessionArchiveItemKey(item);
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        const session = (scope.sessionsByProvider[provider] || [])
            .find(candidate => candidate.id === sessionId);
        if (!selectedProviders.has(provider) || !session || session.active) {
            rejectedCount++;
            if (rejected.length < MAX_RETAINED_BATCH_AI_SESSION_REJECTED_IDS) {
                rejected.push(item);
            }
            continue;
        }
        eligible.push({ ...item, session });
    }

    const providerOrder = new Map(
        scope.selectedProviders
            .filter(isAiSessionProviderId)
            .map((provider, index) => [provider, index])
    );
    eligible.sort((left, right) =>
        (providerOrder.get(left.provider) ?? Number.MAX_SAFE_INTEGER)
        - (providerOrder.get(right.provider) ?? Number.MAX_SAFE_INTEGER)
    );

    return { eligible, rejected, rejectedCount, malformedCount };
}

export function hasAggregateAiSessionArchiveIssues(
    result: AggregateAiSessionArchiveResult
): boolean {
    return Boolean(
        result.running.length
        || result.missing.length
        || result.rejectedCount
        || result.failed.length
        || result.malformedCount
    );
}

export function formatAggregateAiSessionArchiveSummary(
    result: AggregateAiSessionArchiveResult
): string {
    const parts = [formatCount('Archived', result.archived.length, 'session')];
    if (result.running.length) {
        parts.push(formatCount('skipped', result.running.length, 'running session'));
    }
    if (result.missing.length) {
        parts.push(`${formatCount('', result.missing.length, 'session', 'was', 'were')} no longer available`);
    }
    const rejectedCount = result.rejectedCount + result.malformedCount;
    if (rejectedCount) {
        parts.push(formatCount('rejected', rejectedCount, 'invalid or out-of-scope selection'));
    }
    if (result.failed.length) {
        parts.push(`${formatCount('', result.failed.length, 'session')} failed`);
    }
    return `${parts.join('; ')}.`;
}

function isArchiveItemRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function formatCount(
    prefix: string,
    count: number,
    noun: string,
    singularVerb?: string,
    pluralVerb?: string
): string {
    const words = [prefix, String(count), count === 1 ? noun : `${noun}s`].filter(Boolean);
    if (singularVerb) {
        words.push(count === 1 ? singularVerb : pluralVerb);
    }
    return words.join(' ');
}
