'use strict';

import * as crypto from 'crypto';

const PROJECT_CATALOG_NAMESPACE = '9cb57f0f-0b6e-4e5f-8c24-3d9f29a33445';

function uuidBytes(uuid: string): Buffer {
    return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function deterministicProjectCatalogV2Id(name: string): string {
    if (typeof name !== 'string' || !name) throw new Error('project catalog identity name is required');
    const hash = crypto.createHash('sha1')
        .update(uuidBytes(PROJECT_CATALOG_NAMESPACE))
        .update(Buffer.from(name, 'utf8'))
        .digest();
    hash[6] = (hash[6] & 0x0f) | 0x50;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function projectCatalogMigrationActorId(canonicalInput: string): string {
    return crypto.createHash('sha256').update(canonicalInput).digest('hex').slice(0, 32);
}
