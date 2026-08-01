'use strict';

import * as crypto from 'crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function createCorrelationId(eventId: string): string {
    const digest = crypto.createHash('sha256').update(eventId).digest();
    let result = '';
    for (let index = 0; index < 6; index += 1) {
        result += ALPHABET[digest[index] % ALPHABET.length];
    }
    return result;
}
