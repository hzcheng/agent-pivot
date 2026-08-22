'use strict';

import { ProjectRemoteType } from '../models';
import type { OpenWorkspaceEnvironment } from '../workspaces/types';
import * as Icons from '../webviewIcons';

export function getWorkspaceRemoteType(environment: OpenWorkspaceEnvironment): ProjectRemoteType {
    switch (environment) {
        case 'ssh': return ProjectRemoteType.SSH;
        case 'wsl': return ProjectRemoteType.WSL;
        case 'devContainer': return ProjectRemoteType.DevContainer;
        case 'remote': return ProjectRemoteType.Remote;
        case 'local':
        default: return ProjectRemoteType.None;
    }
}

export function getWorkspaceIcon(remoteType: ProjectRemoteType): string {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
        case ProjectRemoteType.WSL:
        case ProjectRemoteType.Remote:
            return Icons.terminal;
        case ProjectRemoteType.DevContainer:
            return Icons.container;
        default:
            return Icons.folder;
    }
}

export function getWorkspaceIconTitle(remoteType: ProjectRemoteType): string {
    switch (remoteType) {
        case ProjectRemoteType.SSH:
            return 'SSH Project';
        case ProjectRemoteType.DevContainer:
            return 'Dev Container Project';
        case ProjectRemoteType.WSL:
        case ProjectRemoteType.Remote:
            return 'Remote Project';
        default:
            return 'Local Project';
    }
}
