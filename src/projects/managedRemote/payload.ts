'use strict';

import { ManagedCatalogEnvelopeV1 } from './types';

/**
 * Provisional product ceiling for the single synchronized setting. VS Code does
 * not publish a stable numeric Settings Sync resource limit, so M1 reserves 25%
 * below a 1 MiB working budget. Activation remains gated on the real-service
 * rehearsal in M4.
 */
export const MANAGED_REMOTE_PAYLOAD_CEILING_BYTES = 768 * 1024;

export function serializedManagedEnvelopeBytes(envelope: ManagedCatalogEnvelopeV1): number {
    return Buffer.byteLength(JSON.stringify(envelope), 'utf8');
}

export function assertManagedEnvelopePayload(envelope: ManagedCatalogEnvelopeV1): void {
    const bytes = serializedManagedEnvelopeBytes(envelope);
    if (bytes > MANAGED_REMOTE_PAYLOAD_CEILING_BYTES) {
        throw new Error(
            `Managed Remote catalog is ${bytes} bytes; the product ceiling is `
            + `${MANAGED_REMOTE_PAYLOAD_CEILING_BYTES} bytes.`,
        );
    }
}
