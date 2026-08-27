'use strict';

import type { AiSessionProviderId } from '../models';

export interface InteractiveCliPromptGateOptions {
    /**
     * Returns whether the provider's CLI can seed an INTERACTIVE session with
     * a first-turn prompt (kimi-cli's `--prompt`). Kimi Code CLI (TypeScript)
     * cannot: its `--prompt` runs one headless turn and exits, so
     * prompt-carrying launches degrade to a clipboard hand-off instead.
     * Optional; absent means every provider supports it.
     */
    resolveInteractiveCliPromptSupport?: (
        providerId: AiSessionProviderId
    ) => Promise<boolean>;
    /** Copies text to the system clipboard (used by the prompt degrade path). */
    writeClipboard?: (value: string) => unknown;
    showWarningMessage: (message: string) => unknown;
    logRuntimeFailure?: (
        operation: string,
        error: unknown,
        backend: 'vscode' | 'tmux'
    ) => void;
}

/**
 * Drops the CLI `--prompt` seed when the provider's interactive dialect
 * cannot carry it (Kimi Code CLI), handing the text to the clipboard so the
 * user can paste it into the session manually. Probe failures keep the
 * prompt on the launch command (fail open, matching providers without a
 * gate).
 */
export async function resolveInteractiveLaunchPrompt(
    options: InteractiveCliPromptGateOptions,
    providerId: AiSessionProviderId,
    prompt: string | undefined,
    sessionKind: 'new' | 'resumed'
): Promise<string | undefined> {
    if (!prompt || !options.resolveInteractiveCliPromptSupport) {
        return prompt;
    }
    let supported = true;
    try {
        supported = await options.resolveInteractiveCliPromptSupport(providerId);
    } catch (error) {
        options.logRuntimeFailure?.('probe-cli-prompt-support', error, 'vscode');
        return prompt;
    }
    if (supported) {
        return prompt;
    }
    if (options.writeClipboard) {
        await options.writeClipboard(prompt);
        options.showWarningMessage(
            'The installed Kimi CLI (Kimi Code) cannot prefill a prompt into an interactive session. '
            + `The prompt was copied to the clipboard — paste it into the ${sessionKind} session.`
        );
    } else {
        options.showWarningMessage(
            'The installed Kimi CLI (Kimi Code) cannot prefill a prompt into an interactive session. '
            + 'Paste the prompt into the session manually after it starts.'
        );
    }
    return undefined;
}
