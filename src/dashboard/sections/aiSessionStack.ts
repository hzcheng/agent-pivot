'use strict';

import * as vscode from 'vscode';

import CodexSessionService from '../../services/codexSessionService';
import KimiSessionService from '../../services/kimiSessionService';
import ClaudeSessionService from '../../services/claudeSessionService';
import AiSessionAliasStore from '../../aiSessions/aliasStore';
import AiSessionAliasController from '../../aiSessions/aliasController';
import AiSessionProfileStore from '../../aiSessions/sessionProfileStore';
import AiSessionProfileController from '../../aiSessions/sessionProfileController';
import {
    CodexProfileSupportProbe,
    codexProfileFileExists,
} from '../../aiSessions/codexProfiles';
import { AiSessionReadCoordinator } from '../../aiSessions/readCoordinator';
import { createAiSessionProviderRegistry } from '../../aiSessions/providers';
import { getAiSessionKey } from '../../aiSessions/sessionHelpers';
import { resolveAiProviderExecutable } from '../../aiSessions/providerDirectoryCapability';
import { isAiSessionProviderId } from '../../models';
import type { AiSessionProviderId } from '../../models';
import type { AiSessionService } from '../../aiSessions/types';

/**
 * Composition section (MOD-DASHBOARD-SHELL): the AI session provider
 * services, registry, read coordinator, and the alias/profile stores and
 * controllers. Extracted from the composition root; construction order is
 * unchanged.
 */
export interface AiSessionStackDeps {
    context: vscode.ExtensionContext;
    logError: (message: string, error: unknown) => void;
    logAiSessionDiagnostic: (event: Record<string, unknown>) => void;
}

export function createAiSessionStack(deps: AiSessionStackDeps) {
    const { context, logError, logAiSessionDiagnostic } = deps;
    const getSessionKey = (providerId: AiSessionProviderId, sessionId: string) =>
        getAiSessionKey(providerId, sessionId);

    const codexSessionService = new CodexSessionService();
    const kimiSessionService = new KimiSessionService();
    const claudeSessionService = new ClaudeSessionService();
    const aiSessionServices: Record<AiSessionProviderId, AiSessionService> = {
        codex: codexSessionService,
        kimi: kimiSessionService,
        claude: claudeSessionService,
    };
    const aiSessionProviderRegistry = createAiSessionProviderRegistry(aiSessionServices);
    const aiSessionProviders = aiSessionProviderRegistry.providers();
    const aiSessionReadCoordinator = new AiSessionReadCoordinator(
        aiSessionProviders,
        logAiSessionDiagnostic
    );
    const aiSessionAliasStore = new AiSessionAliasStore(context.globalStoragePath);
    const aiSessionAliasController = new AiSessionAliasController({
        store: aiSessionAliasStore,
        isProviderId: isAiSessionProviderId,
        getSessionKey,
        getProviderResult: (providerId, options) => aiSessionReadCoordinator.getProviderResult(providerId, options),
        logError,
        showSaveError: () => vscode.window.showErrorMessage("Could not save the chat name."),
    });
    const aiSessionProfileStore = new AiSessionProfileStore(context.globalStoragePath);
    const aiSessionProfileController = new AiSessionProfileController({
        store: aiSessionProfileStore,
        isProviderId: isAiSessionProviderId,
        getSessionKey,
        logError,
        showSaveError: () => vscode.window.showErrorMessage('Could not save the Codex session profile.'),
        lastUsedMemento: context.globalState,
        isProfileAvailable: name => codexProfileFileExists(name),
    });
    const codexProfileSupportProbe = new CodexProfileSupportProbe({
        executable: resolveAiProviderExecutable('codex') || 'codex',
        memento: context.globalState,
    });

    return {
        codexSessionService,
        kimiSessionService,
        claudeSessionService,
        aiSessionServices,
        aiSessionProviderRegistry,
        aiSessionProviders,
        aiSessionReadCoordinator,
        aiSessionAliasStore,
        aiSessionAliasController,
        aiSessionProfileStore,
        aiSessionProfileController,
        codexProfileSupportProbe,
    };
}
