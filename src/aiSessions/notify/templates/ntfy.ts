'use strict';

import type { NtfySink } from '../types';
import type { NotifyRequest } from './types';

function encodeHeaderValue(value: string): string {
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7E]*$/u.test(value)) {
        return value;
    }
    return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildNtfyRequest(
    sink: NtfySink, title: string, body: string, priority: number
): NotifyRequest {
    const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: encodeHeaderValue(title),
        Priority: String(priority),
    };
    if (sink.token) {
        headers.Authorization = `Bearer ${sink.token}`;
    }
    return {
        url: `${sink.baseUrl.replace(/\/+$/u, '')}/${sink.topic}`,
        method: 'POST',
        headers,
        body,
    };
}
