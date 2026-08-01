'use strict';

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_LIMIT = 1000;

interface NotifiedRecord {
    eventId: string;
    sentAtMs: number;
}

export class NotifiedEventStore {
    private readonly entries = new Map<string, number>();

    constructor(private readonly filePath: string, private readonly limit: number = DEFAULT_LIMIT) {}

    has(eventId: string): boolean {
        return this.entries.has(eventId);
    }

    sentAt(eventId: string): number | null {
        const value = this.entries.get(eventId);
        return value === undefined ? null : value;
    }

    record(eventId: string, sentAtMs: number): void {
        this.entries.delete(eventId);
        this.entries.set(eventId, sentAtMs);
        while (this.entries.size > this.limit) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            this.entries.delete(oldest);
        }
    }

    load(): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        } catch (_error) {
            return;
        }
        const record = parsed as { schemaVersion?: unknown; events?: unknown };
        if (!record || record.schemaVersion !== 1 || !Array.isArray(record.events)) {
            return;
        }
        this.entries.clear();
        for (const entry of record.events as NotifiedRecord[]) {
            if (entry && typeof entry.eventId === 'string' && typeof entry.sentAtMs === 'number') {
                this.record(entry.eventId, entry.sentAtMs);
            }
        }
    }

    save(): void {
        const events: NotifiedRecord[] = Array.from(this.entries, ([eventId, sentAtMs]) => ({ eventId, sentAtMs }));
        const payload = JSON.stringify({ schemaVersion: 1, events });
        const temporaryPath = path.join(
            path.dirname(this.filePath),
            `.${path.basename(this.filePath)}.tmp`
        );
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(temporaryPath, payload, { encoding: 'utf8', mode: 0o600 });
        fs.renameSync(temporaryPath, this.filePath);
    }
}
