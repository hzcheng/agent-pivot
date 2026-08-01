'use strict';

import * as crypto from 'crypto';

export function createAttentionEventId(eventKey: string, reason: string, signalToken: string): string {
    return `${eventKey}:${reason}:${crypto.createHash('sha256').update(signalToken).digest('hex')}`;
}
