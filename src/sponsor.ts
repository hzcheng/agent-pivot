'use strict';

import * as vscode from 'vscode';

export interface SponsorLink {
    id: string;
    label: string;
    description: string;
    url: string;
}

export const SPONSOR_COMMAND_ID = 'agentPivot.sponsor';

// Keep in sync with package.json repository.url; the sponsor unit test asserts it.
export const GITHUB_REPOSITORY_URL = 'https://github.com/hzcheng/agent-pivot';

// Keep in sync with .github/FUNDING.yml; the sponsor unit test asserts it.
export const SPONSOR_LINKS: readonly SponsorLink[] = [
    {
        id: 'ko-fi',
        label: '$(coffee) Ko-fi',
        description: 'Buy me a coffee — PayPal / card',
        url: 'https://ko-fi.com/hongzecheng',
    },
    {
        id: 'afdian',
        label: '$(zap) 爱发电 Afdian',
        description: '微信 / 支付宝 — 请作者喝杯咖啡',
        url: 'https://afdian.com/a/YOUR_AFDIAN_ID',
    },
];

const GITHUB_STAR_LINK: SponsorLink = {
    id: 'github',
    label: '$(star-full) Star on GitHub',
    description: 'Costs nothing, makes my day ⭐',
    url: GITHUB_REPOSITORY_URL,
};

// Star first: the zero-cost ask, then the funding platforms.
export const SPONSOR_PICK_LINKS: readonly SponsorLink[] = [GITHUB_STAR_LINK, ...SPONSOR_LINKS];

interface SponsorPick extends vscode.QuickPickItem {
    link: SponsorLink;
}

export async function showSponsorOptions(): Promise<void> {
    const pick = await vscode.window.showQuickPick<SponsorPick>(
        SPONSOR_PICK_LINKS.map(link => ({
            label: link.label,
            description: link.description,
            link,
        })),
        {
            placeHolder: 'Like Agent Pivot? Star it or buy the author a coffee ☕',
        },
    );
    if (!pick) {
        return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(pick.link.url));
}

export function registerSponsorCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(SPONSOR_COMMAND_ID, () => showSponsorOptions());
}
