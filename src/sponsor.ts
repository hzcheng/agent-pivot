'use strict';

import * as vscode from 'vscode';

export interface SponsorLink {
    id: string;
    label: string;
    description: string;
    url: string;
}

export const SPONSOR_COMMAND_ID = 'agentPivot.sponsor';

// Keep in sync with .github/FUNDING.yml; the sponsor unit test asserts it.
export const SPONSOR_LINKS: readonly SponsorLink[] = [
    {
        id: 'ko-fi',
        label: '$(heart) Ko-fi',
        description: 'PayPal / card — support from anywhere',
        url: 'https://ko-fi.com/hongzecheng',
    },
    {
        id: 'afdian',
        label: '$(zap) 爱发电 Afdian',
        description: '微信 / 支付宝 — 国内赞助入口',
        url: 'https://afdian.com/a/YOUR_AFDIAN_ID',
    },
];

interface SponsorPick extends vscode.QuickPickItem {
    link: SponsorLink;
}

export function registerSponsorCommand(): vscode.Disposable {
    return vscode.commands.registerCommand(SPONSOR_COMMAND_ID, async () => {
        const pick = await vscode.window.showQuickPick<SponsorPick>(
            SPONSOR_LINKS.map(link => ({
                label: link.label,
                description: link.description,
                link,
            })),
            {
                placeHolder: 'Support Agent Pivot — pick a sponsorship platform',
            },
        );
        if (!pick) {
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(pick.link.url));
    });
}
