'use strict';

/**
 * Builds the first-turn prompt for a handoff chat: a fresh session that
 * takes over an in-progress task from an earlier chat. The new chat is told
 * which provider/session it succeeds and where to read the prior transcript,
 * then continues the work on its own.
 */

const MAX_FRAGMENT_LENGTH = 160;

function sanitizeFragment(value: string | undefined): string {
    if (!value) {
        return '';
    }
    return value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_FRAGMENT_LENGTH);
}

export interface AiSessionHandoffPromptInput {
    sourceProviderLabel: string;
    sourceSessionId: string;
    sourceSessionName?: string;
    sourceCwd?: string;
    /** Absolute path of the source session transcript, when resolvable. */
    transcriptPath?: string | null;
}

export function buildAiSessionHandoffPrompt(input: AiSessionHandoffPromptInput): string {
    const providerLabel = sanitizeFragment(input.sourceProviderLabel) || 'AI';
    const sessionId = sanitizeFragment(input.sourceSessionId);
    const sessionName = sanitizeFragment(input.sourceSessionName);
    const cwd = sanitizeFragment(input.sourceCwd);
    const transcriptPath = sanitizeFragment(input.transcriptPath || '');

    const lines = [
        `You are taking over an in-progress task from a previous ${providerLabel} chat`
            + `${sessionName ? ` ("${sessionName}")` : ''} (session ${sessionId}).`,
    ];
    if (transcriptPath) {
        lines.push(
            `Its full transcript is stored at: ${transcriptPath}`,
            'Read that transcript first to learn the goal, the decisions already made, '
                + 'and the current progress.',
        );
    } else {
        lines.push(
            `Locate the transcript of that ${providerLabel} session (session ${sessionId}) `
                + 'in the provider\'s session storage and read it first to learn the goal, '
                + 'the decisions already made, and the current progress. '
                + 'If you cannot find it, ask me for a summary before proceeding.',
        );
    }
    if (cwd) {
        lines.push(`The previous chat worked in: ${cwd}`);
    }
    lines.push(
        'Then continue the task from where it stopped. Briefly confirm your understanding '
            + 'of the current state before making changes.',
    );
    return lines.join('\n');
}
