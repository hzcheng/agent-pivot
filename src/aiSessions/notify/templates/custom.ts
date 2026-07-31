'use strict';

import type { CustomSink, NotifyPayload } from '../types';
import type { NotifyRequest } from './types';

export function buildCustomRequest(
    sink: CustomSink, payload: NotifyPayload, title: string, body: string
): NotifyRequest {
    const values: Record<string, string> = {
        project: payload.projectLabel,
        session: payload.sessionLabel,
        provider: payload.providerId,
        reason: payload.reason,
        host: payload.hostLabel,
        correlationId: payload.correlationId,
        title,
        body,
    };
    const rendered = sink.bodyTemplate.replace(
        /\$\{([A-Za-z]+)\}/gu,
        (match, key: string) => (key in values ? values[key] : match)
    );
    return { url: sink.url, method: sink.method, headers: { ...sink.headers }, body: rendered };
}
