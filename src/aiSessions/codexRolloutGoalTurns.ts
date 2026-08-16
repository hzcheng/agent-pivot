'use strict';

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';

const DEFAULT_CHUNK_BYTES = 512 * 1024;
// Defensive bound for one objective; real objectives are a line or two.
const MAX_OBJECTIVE_CHARS = 4096;
const GOAL_CONTEXT_MARKER = '<codex_internal_context source="goal">';
const OBJECTIVE_PATTERN = /<objective>\s*([\s\S]*?)\s*<\/objective>/;

/**
 * Incremental reader mapping Codex goal-continuation turn ids to their
 * `/goal` objective.
 *
 * Why this exists: the app-server strips the internal
 * `<codex_internal_context source="goal">` user message from turn items, so
 * `thread/read` exposes goal-continuation turns with NO userMessage. The
 * objective itself only survives in the rollout transcript — both in the
 * `thread_goal_updated` event and, more usefully, embedded in the injected
 * user message whose enclosing `task_started` names the turn. Anchoring on
 * the message keeps the turn→objective mapping exact even when one thread
 * replaces its goal mid-session.
 */
export default class CodexRolloutGoalTurnsReader {
    private readonly chunkBytes: number;
    private readonly cursors = new Map<string, Cursor>();

    constructor(chunkBytes = DEFAULT_CHUNK_BYTES) {
        this.chunkBytes = Number.isFinite(chunkBytes) && chunkBytes >= 1
            ? Math.floor(chunkBytes)
            : DEFAULT_CHUNK_BYTES;
    }

    /**
     * Returns turn id → objective for every goal-continuation turn seen so
     * far, or undefined when the rollout is unreadable. Repeat calls only
     * parse bytes appended since the previous read; a replaced or truncated
     * file restarts the scan from offset zero.
     */
    read(filePath: string): ReadonlyMap<string, string> | undefined {
        if (!filePath) {
            return undefined;
        }
        let fd: number = null;
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                return undefined;
            }
            let cursor = this.cursors.get(filePath);
            if (!cursor
                || cursor.dev !== stat.dev
                || cursor.ino !== stat.ino
                || cursor.birthtimeMs !== stat.birthtimeMs
                || stat.size < cursor.offset) {
                cursor = {
                    dev: stat.dev,
                    ino: stat.ino,
                    birthtimeMs: stat.birthtimeMs,
                    offset: 0,
                    decoder: new StringDecoder('utf8'),
                    partialLine: '',
                    currentTurnId: undefined,
                    turnObjectives: new Map<string, string>(),
                };
                this.cursors.set(filePath, cursor);
            }
            if (cursor.offset >= stat.size) {
                return cursor.turnObjectives;
            }
            fd = fs.openSync(filePath, 'r');
            while (cursor.offset < stat.size) {
                const remaining = stat.size - cursor.offset;
                const buffer = Buffer.alloc(
                    Math.min(this.chunkBytes, remaining)
                );
                const bytesRead = fs.readSync(
                    fd,
                    buffer,
                    0,
                    buffer.length,
                    cursor.offset
                );
                if (bytesRead <= 0) {
                    break;
                }
                cursor.offset += bytesRead;
                const text = cursor.partialLine
                    + cursor.decoder.write(buffer.subarray(0, bytesRead));
                const lines = text.split('\n');
                cursor.partialLine = lines.pop() || '';
                for (const line of lines) {
                    this.consumeLine(cursor, line);
                }
            }
            return cursor.turnObjectives;
        } catch (_error) {
            // Best effort like every other rollout probe: the conversation
            // must remain readable (minus goal labels) when the transcript
            // disappears mid-refresh.
            return undefined;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (_error) {
                    // Ignore close failures; the read result stands.
                }
            }
        }
    }

    private consumeLine(cursor: Cursor, line: string): void {
        // Cheap pre-filter: goal-relevant records are rare inside huge
        // rollouts, so full JSON parsing runs only on candidate lines.
        if (!line.includes('task_started')
            && !line.includes('codex_internal_context')) {
            return;
        }
        let record: Record<string, any> | undefined;
        try {
            const parsed: unknown = JSON.parse(line);
            record = parsed && typeof parsed === 'object'
                && !Array.isArray(parsed)
                ? parsed as Record<string, any>
                : undefined;
        } catch (_error) {
            return;
        }
        const payload = record?.payload;
        if (!payload || typeof payload !== 'object') {
            return;
        }
        if (record?.type === 'event_msg' && payload.type === 'task_started') {
            cursor.currentTurnId = typeof payload.turn_id === 'string'
                && payload.turn_id
                ? payload.turn_id
                : undefined;
            return;
        }
        if (record?.type !== 'response_item'
            || payload.type !== 'message'
            || payload.role !== 'user'
            || !cursor.currentTurnId
            || !Array.isArray(payload.content)) {
            return;
        }
        for (const rawPart of payload.content) {
            const text = rawPart && typeof rawPart === 'object'
                && typeof rawPart.text === 'string'
                ? rawPart.text
                : '';
            if (!text.startsWith(GOAL_CONTEXT_MARKER)) {
                continue;
            }
            const objective = extractGoalObjective(text);
            if (objective) {
                cursor.turnObjectives.set(cursor.currentTurnId, objective);
            }
            return;
        }
    }
}

function extractGoalObjective(text: string): string | undefined {
    const match = OBJECTIVE_PATTERN.exec(text);
    const objective = match?.[1]?.trim();
    if (!objective) {
        return undefined;
    }
    return objective.length <= MAX_OBJECTIVE_CHARS
        ? objective
        : objective.slice(0, MAX_OBJECTIVE_CHARS);
}

interface Cursor {
    dev: number;
    ino: number;
    birthtimeMs: number;
    offset: number;
    decoder: StringDecoder;
    partialLine: string;
    currentTurnId: string | undefined;
    turnObjectives: Map<string, string>;
}
