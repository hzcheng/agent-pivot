'use strict';

import type { WebhookSink } from '../types';
import type { NotifyRequest } from './types';

export function buildWebhookJsonRequest(sink: WebhookSink, title: string, body: string): NotifyRequest {
    const text = `${title}\n${body}`;
    let payload: unknown;
    switch (sink.channel) {
        case 'feishu':
            payload = { msg_type: 'text', content: { text } };
            break;
        case 'wecom':
            payload = { msgtype: 'markdown', markdown: { content: `**${title}**\n${body}` } };
            break;
        case 'slack':
            payload = { text };
            break;
        case 'discord':
            payload = { content: text };
            break;
        default:
            throw new Error('webhook json sink channel is unsupported');
    }
    return {
        url: sink.url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    };
}
