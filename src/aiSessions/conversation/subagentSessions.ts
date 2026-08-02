'use strict';

/**
 * A subagent transcript is addressed as a virtual conversation session:
 * `<sessionId>#agent:<subagentId>`. The viewer encodes, the provider adapter
 * decodes; everything in between (coordinator revisions, cursors, watches)
 * treats the encoded id as an opaque session identifier.
 */

export const SUBAGENT_SESSION_SEPARATOR = '#agent:';

const SUBAGENT_ID_PATTERN = /^[0-9a-z][0-9a-z-]{0,63}$/i;

export function isSubagentId(value: unknown): value is string {
    return typeof value === 'string' && SUBAGENT_ID_PATTERN.test(value);
}

export function encodeSubagentSessionId(
    sessionId: string,
    subagentId: string
): string {
    return `${sessionId}${SUBAGENT_SESSION_SEPARATOR}${subagentId}`;
}

export function splitSubagentSessionId(
    sessionId: string
): { sessionId: string; subagentId?: string } {
    const index = sessionId.indexOf(SUBAGENT_SESSION_SEPARATOR);
    if (index < 0) {
        return { sessionId };
    }
    return {
        sessionId: sessionId.slice(0, index),
        subagentId: sessionId.slice(
            index + SUBAGENT_SESSION_SEPARATOR.length
        ),
    };
}
