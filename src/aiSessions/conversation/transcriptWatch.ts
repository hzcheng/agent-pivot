'use strict';

import * as fs from 'fs';
import type { AiSessionDisposable } from '../types';

/** Watch only the visible transcript. Directory/session discovery keeps its
 * slower independent cadence; a token must not rescan every saved session. */
export function watchConversationTranscript(
    resolvePath: () => string | undefined,
    onChange: () => void
): AiSessionDisposable {
    let sourcePath: string | undefined;
    let stopped = false;
    const changed = (current: fs.Stats, previous: fs.Stats): void => {
        if (!stopped && (current.size !== previous.size
            || current.mtimeMs !== previous.mtimeMs
            || current.ino !== previous.ino)) {
            onChange();
        }
    };
    const resolve = (): void => {
        let next: string | undefined;
        try { next = resolvePath(); } catch (_error) { return; }
        if (next === sourcePath) { return; }
        if (sourcePath) { fs.unwatchFile(sourcePath, changed); }
        sourcePath = next;
        if (sourcePath) {
            fs.watchFile(sourcePath, { persistent: false, interval: 150 }, changed);
            onChange();
        }
    };
    resolve();
    const timer = setInterval(resolve, 3000);
    timer.unref?.();
    return { dispose: () => {
        stopped = true;
        clearInterval(timer);
        if (sourcePath) { fs.unwatchFile(sourcePath, changed); }
    } };
}
