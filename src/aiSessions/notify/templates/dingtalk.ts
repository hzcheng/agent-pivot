'use strict';

import * as crypto from 'crypto';
import type { DingtalkSink } from '../types';
import type { NotifyRequest } from './types';

export function buildDingtalkRequest(
    sink: DingtalkSink, title: string, body: string, nowMs: number
): NotifyRequest {
    const sign = encodeURIComponent(
        crypto.createHmac('sha256', sink.secret).update(`${nowMs}\n${sink.secret}`).digest('base64'));
    const separator = sink.url.includes('?') ? '&' : '?';
    return {
        url: `${sink.url}${separator}timestamp=${nowMs}&sign=${sign}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text: `**${title}**\n\n${body}` } }),
    };
}
