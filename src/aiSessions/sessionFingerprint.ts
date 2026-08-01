'use strict';

import * as crypto from 'crypto';

/**
 * Incremental change fingerprint for the provider watchers. watchSessionChanges
 * recomputes a fingerprint every few seconds per provider only to answer "did
 * anything change"; feeding each observed entry into one running digest avoids
 * allocating, sorting, and joining a store-sized string on every poll.
 *
 * Callers must feed entries in a deterministic order (discovery already orders
 * by recency, or sorts session ids), so an unchanged store always produces the
 * same digest. The NUL separator keeps concatenation unambiguous.
 */
export default class SessionFingerprint {
    private readonly hash = crypto.createHash('sha256');

    addEntry(value: string): void {
        this.hash.update(value);
        this.hash.update('\0');
    }

    digest(): string {
        return this.hash.digest('hex');
    }
}
