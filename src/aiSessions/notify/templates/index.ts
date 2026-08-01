'use strict';

import { notifyPriority, renderNotifyBody, renderNotifyTitle } from '../message';
import type { NotifyPayload, NotifySink } from '../types';
import { buildBarkRequest } from './bark';
import { buildCustomRequest } from './custom';
import { buildDingtalkRequest } from './dingtalk';
import { buildNtfyRequest } from './ntfy';
import { buildTelegramRequest } from './telegram';
import type { NotifyRequest } from './types';
import { buildWebhookJsonRequest } from './webhookJson';

export type { NotifyRequest } from './types';

export function buildNotifyRequestFromText(
    sink: NotifySink,
    payload: NotifyPayload,
    title: string,
    body: string,
    priority: number,
    nowMs: number
): NotifyRequest {
    switch (sink.channel) {
        case 'ntfy':
            return buildNtfyRequest(sink, title, body, priority);
        case 'telegram':
            return buildTelegramRequest(sink, title, body);
        case 'bark':
            return buildBarkRequest(sink, title, body);
        case 'dingtalk':
            return buildDingtalkRequest(sink, title, body, nowMs);
        case 'custom':
            return buildCustomRequest(sink, payload, title, body);
        default:
            return buildWebhookJsonRequest(sink, title, body);
    }
}

export function buildNotifyRequest(
    sink: NotifySink, payload: NotifyPayload, nowMs: number
): NotifyRequest {
    return buildNotifyRequestFromText(
        sink,
        payload,
        renderNotifyTitle(payload),
        renderNotifyBody(payload),
        notifyPriority(payload.reason),
        nowMs
    );
}
