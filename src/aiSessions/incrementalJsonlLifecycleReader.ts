'use strict';

import * as fs from 'fs';
import { StringDecoder } from 'string_decoder';
import { AiSessionLifecycleAccumulator, AiSessionLifecycleSignal } from './lifecycle';

const DEFAULT_CHUNK_BYTES = 512 * 1024;

interface Cursor {
    filePath: string;
    runStartedAtMs: number;
    dev: number;
    ino: number;
    birthtimeMs: number;
    offset: number;
    decoder: StringDecoder;
    partialLine: string;
    accumulator: AiSessionLifecycleAccumulator;
}

export default class IncrementalJsonlLifecycleReader {
    private readonly chunkBytes: number;
    private readonly cursors = new Map<string, Cursor>();

    constructor(chunkBytes = DEFAULT_CHUNK_BYTES) {
        this.chunkBytes = Number.isFinite(chunkBytes) && chunkBytes >= 1
            ? Math.floor(chunkBytes)
            : DEFAULT_CHUNK_BYTES;
    }

    read(
        key: string,
        filePath: string,
        runStartedAtMs: number,
        createAccumulator: () => AiSessionLifecycleAccumulator,
        validateOpen?: (stat: fs.Stats) => boolean
    ): AiSessionLifecycleSignal | null {
        let previousCursor = this.cursors.get(key);
        let fd: number = null;

        try {
            const noFollow = (fs.constants as any).O_NOFOLLOW || 0;
            fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
            let stat = fs.fstatSync(fd);
            if (!stat.isFile()) {
                return null;
            }
            if (validateOpen && !validateOpen(stat)) {
                return null;
            }

            let cursor = previousCursor;
            if (!cursor
                || cursor.filePath !== filePath
                || cursor.runStartedAtMs !== runStartedAtMs
                || cursor.dev !== stat.dev
                || cursor.ino !== stat.ino
                || cursor.birthtimeMs !== stat.birthtimeMs
                || stat.size < cursor.offset) {
                cursor = {
                    filePath,
                    runStartedAtMs,
                    dev: stat.dev,
                    ino: stat.ino,
                    birthtimeMs: stat.birthtimeMs,
                    offset: 0,
                    decoder: new StringDecoder('utf8'),
                    partialLine: '',
                    accumulator: createAccumulator(),
                };
                this.cursors.set(key, cursor);
            }

            if (cursor.offset >= stat.size) {
                return cursor.accumulator.getSignal();
            }

            while (cursor.offset < stat.size) {
                let remaining = stat.size - cursor.offset;
                let buffer = Buffer.alloc(Math.min(this.chunkBytes, remaining));
                let bytesRead = fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
                if (bytesRead <= 0) {
                    break;
                }

                cursor.offset += bytesRead;
                let decoded = cursor.partialLine + cursor.decoder.write(buffer.slice(0, bytesRead));
                let lines = decoded.split('\n');
                cursor.partialLine = lines.pop() || '';
                if (lines.length) {
                    cursor.accumulator.addLines(lines);
                }
            }

            return cursor.accumulator.getSignal();
        } catch (e) {
            // Keep the cursor for a later recovery, but do not expose its
            // cached signal as a successful lifecycle observation. Callers
            // can retain their current state while availability times out.
            return null;
        } finally {
            if (fd !== null) {
                try {
                    fs.closeSync(fd);
                } catch (e) {
                    // Best effort only.
                }
            }
        }
    }

    retain(keys: ReadonlySet<string>): void {
        for (let key of this.cursors.keys()) {
            if (!keys.has(key)) {
                this.cursors.delete(key);
            }
        }
    }

    delete(key: string): void {
        this.cursors.delete(key);
    }
}
