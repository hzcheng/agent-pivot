#!/usr/bin/env python3
"""Render near-final SKILLS tab mockups with the extension's real styles.css."""
import pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path('/home/hzcheng/projects/repos/vscode-dashboard/.worktrees/feat-ai-skill-management')
CSS = (ROOT / 'media/styles.css').read_text()

ROOT_VARS = """:root {
    --vscode-font-family: 'Segoe WPC', 'Segoe UI', sans-serif;
    --vscode-font-size: 13px;
    --vscode-foreground: #cccccc;
    --vscode-editor-foreground: #cccccc;
    --vscode-sideBar-background: #181818;
    --vscode-sideBar-foreground: #cccccc;
    --vscode-sideBarSectionHeader-background: #1f1f1f;
    --vscode-panel-border: #3c3c3c;
    --vscode-focusBorder: #007fd4;
    --vscode-list-hoverBackground: #2a2d2e;
    --vscode-list-inactiveSelectionBackground: #37373d;
    --vscode-descriptionForeground: #9d9d9d;
    --vscode-charts-blue: #3794ff;
    --vscode-charts-green: #4ec9b0;
    --vscode-charts-purple: #b180d7;
    --vscode-errorForeground: #f48771;
    --vscode-terminal-ansiCyan: #29b8db;
    --vscode-terminal-ansiGreen: #23d18b;
    --vscode-editorWarning-foreground: #cca700;
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #ffffff;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-secondaryBackground: #3a3d41;
    --vscode-button-secondaryForeground: #ffffff;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
}
html, body { margin: 0; padding: 0; background: var(--vscode-sideBar-background); }
"""

SKILL_CSS = """
/* --- new skill-management styles (approximation of the final implementation) --- */
body.steward-sidebar .skill-card { height: auto; min-height: 96px; }
body.steward-sidebar .skill-card .project-description {
    white-space: normal; display: -webkit-box;
    -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.skill-toggle {
    position: absolute; top: 8px; right: 9px; z-index: 3;
    width: 26px; height: 14px; border-radius: 999px;
    background: var(--vscode-button-background); cursor: pointer; border: 0; padding: 0;
}
.skill-toggle::after {
    content: ""; position: absolute; top: 2px; right: 2px;
    width: 10px; height: 10px; border-radius: 999px; background: #fff;
}
.skill-toggle.off { background: #3c3c3c; box-shadow: inset 0 0 0 1px #555; }
.skill-toggle.off::after { right: auto; left: 2px; background: #888; }

.skill-chip-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; align-items: center; }
.skill-chip {
    display: inline-flex; align-items: center; gap: 3px;
    padding: 1px 7px; border-radius: 999px;
    font-size: 9px; line-height: 14px; letter-spacing: .1px;
    border: 1px solid transparent; white-space: nowrap;
}
.skill-chip.scope-user { color: #8ab4f8; background: rgba(55,148,255,.14); border-color: rgba(138,180,248,.4); }
.skill-chip.scope-project { color: #c9a6f2; background: rgba(180,130,255,.13); border-color: rgba(201,166,242,.35); }
.skill-chip.scope-builtin { color: #a0a0a0; background: rgba(160,160,160,.12); border-color: rgba(160,160,160,.3); }
.skill-chip.agent-kimi { color: #7aa2ff; background: rgba(122,162,255,.13); border-color: rgba(122,162,255,.4); }
.skill-chip.agent-claude { color: #d97757; background: rgba(217,119,87,.13); border-color: rgba(217,119,87,.4); }
.skill-chip.agent-codex { color: #4ec9b0; background: rgba(78,201,176,.13); border-color: rgba(78,201,176,.4); }
.skill-chip.agent-absent { color: #6a6a6a; background: rgba(110,110,110,.08); border-color: rgba(110,110,110,.25); text-decoration: line-through; }
.skill-chip.warn { color: var(--vscode-editorWarning-foreground, #cca700); background: rgba(204,167,0,.12); border-color: rgba(204,167,0,.4); }

.skill-card-disabled { opacity: .55; }
.skill-parked-note { display: block; margin-top: 2px; font-size: 9px; font-style: italic; color: var(--vscode-descriptionForeground); opacity: .8; }

.skill-detail {
    margin: 0 2px 7px 2px; padding: 8px 10px;
    border: 1px solid #3a3d42; border-radius: 12px; background: #1e2023;
}
.skill-detail-title { font-size: 11px; font-weight: 600; margin: 0 0 7px; color: var(--vscode-foreground); }
.skill-detail-row { display: flex; align-items: center; gap: 7px; margin: 5px 0; font-size: 10px; }
.skill-detail-row .skill-chip { flex: none; }
.skill-detail-status { width: 74px; flex: none; font-size: 10px; }
.skill-detail-status.ok { color: var(--vscode-charts-green); }
.skill-detail-status.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
.skill-detail-path { color: var(--vscode-descriptionForeground); font-size: 9.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.skill-detail-note { margin: 8px 0; padding-top: 7px; border-top: 1px solid #333; color: var(--vscode-editorWarning-foreground, #cca700); font-size: 10px; line-height: 1.5; }
.skill-detail-actions { display: flex; gap: 6px; margin-top: 6px; }
.skill-detail-actions button {
    border: 0; border-radius: 4px; padding: 3px 10px; font-size: 10px; cursor: pointer;
    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
}
.skill-detail-actions button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
"""

ICON = '<svg viewBox="0 0 24 24"><path d="M4 5.75C4 4.78 4.78 4 5.75 4h12.5c.97 0 1.75.78 1.75 1.75v12.5c0 .97-.78 1.75-1.75 1.75H5.75C4.78 20 4 19.22 4 18.25V5.75zm1.5 0v12.5c0 .14.11.25.25.25h12.5c.14 0 .25-.11.25-.25V5.75a.25.25 0 0 0-.25-.25H5.75a.25.25 0 0 0-.25.25zm2.2 3.78 1.77-1.76L13 11.3l-3.53 3.53-1.77-1.77 1.76-1.76L7.7 9.53zm5.3 5.22h4v1.5h-4v-1.5z" fill="currentColor"/></svg>'


def chip(text, cls):
    return f'<span class="skill-chip {cls}">{text}</span>'


def agent_chips(agents):
    out = []
    for agent in ('kimi', 'claude', 'codex'):
        state = agents[agent]
        if state == 'active':
            out.append(chip(agent, f'agent-{agent}'))
        elif state == 'shadowed':
            out.append(chip('\u26a0 ' + agent, 'warn'))
        else:
            out.append(chip(agent, 'agent-absent'))
    return ''.join(out)


def skill_card(name, desc, scope, agents, on=True, warn=None, note=None):
    scope_cls = {'User': 'scope-user', 'Project': 'scope-project', 'Built-in': 'scope-builtin'}[scope]
    chips = chip(scope, scope_cls) + agent_chips(agents)
    if warn:
        chips += chip('\u26a0 ' + warn, 'warn')
    note_html = f'<span class="skill-parked-note">{note}</span>' if note else ''
    return f"""
<div class="project-container">
    <div class="project steward-item-card skill-card{'' if on else ' skill-card-disabled'}" data-id="{name}">
        <div class="project-aura"></div>
        <div class="project-border steward-item-accent"></div>
        <button class="skill-toggle{'' if on else ' off'}" title="{'Disable' if on else 'Enable'} skill"></button>
        <div class="fitty-container project-title-row">
            <span class="project-kind-icon">{ICON}</span>
            <h2 class="project-header">{name}</h2>
        </div>
        <p class="project-description" title="{desc}">{desc}</p>
        {note_html}
        <div class="skill-chip-row">{chips}</div>
    </div>
</div>"""


def group(title, cards, badge='Live'):
    return f"""
<div class="group steward-section" data-group-id="{title.lower().replace(' ', '-')}">
    <div class="group-title steward-section-header steward-group-header">
        <span class="group-title-text"><span class="group-title-text">{title}</span></span>
        <span class="group-title-badge">{badge}</span>
    </div>
    <div class="group-list">
        <div class="drop-signal"></div>
        {''.join(cards)}
    </div>
</div>"""


def page(content):
    return f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>{ROOT_VARS}</style><style>{CSS}</style><style>{SKILL_CSS}</style></head>
<body class="steward-sidebar">
<div class="steward-sticky-header">
    <div class="dashboard-tab-list" role="tablist">
        <button type="button" class="dashboard-tab-button" role="tab" aria-selected="false">OPEN</button>
        <button type="button" class="dashboard-tab-button" role="tab" aria-selected="false">PROJECTS</button>
        <button type="button" class="dashboard-tab-button" role="tab" aria-selected="false">TODO</button>
        <button type="button" class="dashboard-tab-button active" role="tab" aria-selected="true">SKILLS</button>
    </div>
</div>
<main class="dashboard-content">
    <section class="dashboard-tab-panel" role="tabpanel">
        <div class="sticky-groups-wrapper">
{content}
        </div>
    </section>
</main>
</body></html>"""


CARDS = [
    ('USER SKILLS', [
        dict(name='brainstorming', scope='User',
             desc='Use before any creative work — explores intent, requirements and design before implementation.',
             agents={'kimi': 'active', 'claude': 'active', 'codex': 'active'}),
        dict(name='using-superpowers', scope='User', warn='shadowed',
             desc='Establishes how to find and use skills; invoke relevant skills before any response.',
             agents={'kimi': 'active', 'claude': 'shadowed', 'codex': 'active'}),
        dict(name='pingcode-create-workitem', scope='User',
             desc='Create PingCode work items: requirements, defects and subtasks.',
             agents={'kimi': 'active', 'claude': 'active', 'codex': 'absent'}),
        dict(name='test-driven-development', scope='User', on=False,
             desc='Write the test first. Watch it fail. Write minimal code to pass.',
             agents={'kimi': 'absent', 'claude': 'absent', 'codex': 'absent'},
             note='parked at ~/.kimi/skills/.disabled/test-driven-development'),
    ]),
    ('PROJECT SKILLS', [
        dict(name='protecting-main-with-worktrees', scope='Project',
             desc='Keep protected branches clean; do feature work in local .worktrees.',
             agents={'kimi': 'active', 'claude': 'active', 'codex': 'active'}),
        dict(name='review-fix-commit-loop', scope='Project', warn='skill.md',
             desc='Review findings, patch narrowly, verify freshly, commit intentionally.',
             agents={'kimi': 'absent', 'claude': 'active', 'codex': 'active'}),
    ]),
    ('BUILT-IN', [
        dict(name='kimi-cli-help', scope='Built-in',
             desc='Answer Kimi Code CLI usage, configuration and troubleshooting questions.',
             agents={'kimi': 'active', 'claude': 'absent', 'codex': 'absent'}),
        dict(name='skill-creator', scope='Built-in',
             desc='Guide for creating effective skills that extend agent capabilities.',
             agents={'kimi': 'active', 'claude': 'absent', 'codex': 'absent'}),
    ]),
]

list_content = ''
for title, cards in CARDS:
    list_content += group(title, [skill_card(**c) for c in cards])

detail_content = group('USER SKILLS', [
    skill_card('using-superpowers',
               'Establishes how to find and use skills; invoke relevant skills before any response.',
               'User', {'kimi': 'active', 'claude': 'shadowed', 'codex': 'active'}, warn='shadowed'),
]) + """
<div class="skill-detail">
    <p class="skill-detail-title">Effectiveness per agent</p>
    <div class="skill-detail-row">""" + chip('kimi', 'agent-kimi') + """<span class="skill-detail-status ok">✓ active</span><span class="skill-detail-path">~/.kimi/skills/using-superpowers</span></div>
    <div class="skill-detail-row">""" + chip('claude', 'warn') + """<span class="skill-detail-status warn">⚠ shadowed</span><span class="skill-detail-path">~/.kimi/skills/… wins over ~/.claude/skills/…</span></div>
    <div class="skill-detail-row">""" + chip('codex', 'agent-codex') + """<span class="skill-detail-status ok">✓ active</span><span class="skill-detail-path">~/.codex/skills/using-superpowers</span></div>
    <p class="skill-detail-note">⚠ Kimi's brand-directory priority loads the ~/.kimi copy; the ~/.claude copy is invisible to every agent.</p>
    <div class="skill-detail-actions">
        <button class="primary">Open SKILL.md</button>
        <button>Disable</button>
        <button>Sync to Claude…</button>
    </div>
</div>
"""

out = pathlib.Path(__file__).parent
with sync_playwright() as p:
    browser = p.chromium.launch()
    for name, content, height in (('skill-management-tab-list', list_content, None),
                                  ('skill-management-diagnostic', detail_content, None)):
        pg = browser.new_page(viewport={'width': 340, 'height': 800}, device_scale_factor=2)
        pg.set_content(page(content))
        pg.wait_for_timeout(400)
        el = pg.locator('body')
        el.screenshot(path=str(out / f'{name}.png'))
        (out / f'{name}.html').write_text(page(content))
        pg.close()
    browser.close()
print('rendered')
