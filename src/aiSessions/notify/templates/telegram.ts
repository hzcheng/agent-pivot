'use strict';

import type { TelegramSink } from '../types';
import type { NotifyRequest } from './types';

export function buildTelegramRequest(sink: TelegramSink, title: string, body: string): NotifyRequest {
    return {
        url: `https://api.telegram.org/bot${sink.botToken}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: sink.chatId, text: `${title}\n${body}` }),
    };
}
