'use strict';

import type { BarkSink } from '../types';
import type { NotifyRequest } from './types';

export function buildBarkRequest(sink: BarkSink, title: string, body: string): NotifyRequest {
    return {
        url: `${sink.serverUrl.replace(/\/+$/u, '')}/${sink.deviceKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body }),
    };
}
