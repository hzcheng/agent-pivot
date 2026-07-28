#!/usr/bin/env python3
"""Generate SVG/PNG mockups for the Skill Management design spec."""
import cairosvg

W = 360
BG = '#181818'
CARD = '#242526'
BORDER = '#343536'
FG = '#e8e8e8'
DIM = '#9da0a3'
FAINT = '#6a6a6a'
ACCENT = '#3794ff'
WARN = '#cca700'

def tint(hex_color, alpha=.13):
    r, g, b = (int(hex_color[i:i+2], 16) for i in (1, 3, 5))
    return f'rgba({r},{g},{b},{alpha})'

AGENTS = {'kimi': '#7aa2ff', 'claude': '#d97757', 'codex': '#4ec9b0'}
SCOPE_STYLE = {
    'User': ('#8ab4f8', 'rgba(55,148,255,.14)'),
    'Project': ('#c9a6f2', 'rgba(180,130,255,.13)'),
    'Built-in': ('#a0a0a0', 'rgba(160,160,160,.12)'),
}
FONT = "font-family='DejaVu Sans,Segoe UI,sans-serif'"


def esc(t):
    return t.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def pill(x, y, text, color, bg, w=None, strike=False, warn_icon=False):
    w = w or (len(text) * 5.6 + 12 + (10 if warn_icon else 0))
    label = ('\u26a0 ' if warn_icon else '') + text
    deco = " text-decoration='line-through'" if strike else ''
    return (f"<rect x='{x}' y='{y}' width='{w}' height='15' rx='7.5' fill='{bg}' "
            f"stroke='{color}' stroke-width='.6' stroke-opacity='.55'/>"
            f"<text x='{x + 6}' y='{y + 11}' font-size='8.5' fill='{color}'{deco} {FONT}>{esc(label)}</text>",
            w)


def agent_chip(x, y, agent, state):
    """state: active | shadowed | absent"""
    color = AGENTS[agent]
    if state == 'active':
        return pill(x, y, agent, color, tint(color))
    if state == 'shadowed':
        return pill(x, y, agent, WARN, 'rgba(204,167,0,.13)', warn_icon=True)
    return pill(x, y, agent, FAINT, 'rgba(110,110,110,.1)', strike=True)


def toggle(x, y, on):
    if on:
        return (f"<rect x='{x}' y='{y}' width='26' height='14' rx='7' fill='{ACCENT}'/>"
                f"<circle cx='{x + 19}' cy='{y + 7}' r='5' fill='#fff'/>")
    return (f"<rect x='{x}' y='{y}' width='26' height='14' rx='7' fill='#3c3c3c' stroke='#555' stroke-width='.5'/>"
            f"<circle cx='{x + 7}' cy='{y + 7}' r='5' fill='#888'/>")


def wrap(text, width):
    words, lines, cur = text.split(), [], ''
    for w_ in words:
        if len(cur) + len(w_) + 1 > width:
            lines.append(cur)
            cur = w_
        else:
            cur = (cur + ' ' + w_).strip()
    lines.append(cur)
    return lines[:2]


def card(y, name, desc, scope, agents, on=True, warn=None, note=None):
    """agents: dict agent->state. Returns (svg, height)."""
    lines = wrap(desc, 56)
    h = 62 + 13 * (len(lines) - 1)
    if note:
        h += 13
    op = '1' if on else '.55'
    s = [f"<g opacity='{op}'>",
         f"<rect x='10' y='{y}' width='{W - 20}' height='{h}' rx='9' fill='{CARD}' stroke='{BORDER}'/>",
         f"<rect x='10' y='{y + 6}' width='3' height='{h - 12}' rx='1.5' fill='{ACCENT}' fill-opacity='{'.9' if on else '.35'}'/>",
         f"<text x='24' y='{y + 19}' font-size='12' font-weight='bold' fill='{FG}' {FONT}>{esc(name)}</text>",
         toggle(W - 44, y + 7, on)]
    ty = y + 33
    for ln in lines:
        s.append(f"<text x='24' y='{ty}' font-size='9.5' fill='{DIM}' {FONT}>{esc(ln)}</text>")
        ty += 12
    if note:
        s.append(f"<text x='24' y='{ty}' font-size='8.5' fill='{FAINT}' font-style='italic' {FONT}>{esc(note)}</text>")
        ty += 12
    cx = 24
    p, w_ = pill(cx, ty + 2, scope, *SCOPE_STYLE[scope])
    s.append(p)
    cx += w_ + 5
    for agent in ('kimi', 'claude', 'codex'):
        p, w_ = agent_chip(cx, ty + 2, agent, agents[agent])
        s.append(p)
        cx += w_ + 5
    if warn:
        p, w_ = pill(cx, ty + 2, warn, WARN, 'rgba(204,167,0,.13)', warn_icon=True)
        s.append(p)
    s.append('</g>')
    return ''.join(s), h


def group_header(y, title, count):
    return (f"<text x='12' y='{y}' font-size='10' font-weight='bold' letter-spacing='.8' fill='{DIM}' {FONT}>{title}</text>"
            f"<rect x='{W - 34}' y='{y - 10}' width='22' height='13' rx='6.5' fill='#2c2c2c'/>"
            f"<text x='{W - 23}' y='{y}' font-size='8.5' text-anchor='middle' fill='{DIM}' {FONT}>{count}</text>")


def tab_bar():
    tabs = [('OPEN', 12), ('PROJECTS', 56), ('TODOS', 124), ('SKILLS', 172)]
    s = [f"<rect x='0' y='0' width='{W}' height='34' fill='#1f1f20'/>"]
    for label, x in tabs:
        active = label == 'SKILLS'
        s.append(f"<text x='{x}' y='{21}' font-size='10.5' font-weight='{'bold' if active else 'normal'}' "
                 f"fill='{FG if active else FAINT}' {FONT}>{label}</text>")
        if active:
            s.append(f"<rect x='{x}' y='{28}' width='40' height='2' fill='{ACCENT}'/>")
    s.append(f"<rect x='0' y='33' width='{W}' height='1' fill='#2b2b2c'/>")
    return ''.join(s)


def search_row():
    return (f"<rect x='10' y='42' width='{W - 20}' height='22' rx='5' fill='#262728' stroke='#3a3a3b' stroke-width='.6'/>"
            f"<text x='20' y='57' font-size='9.5' fill='{FAINT}' {FONT}>Search skills\u2026</text>")


CARDS = [
    ('USER SKILLS', [
        dict(name='brainstorming', scope='User', on=True,
             desc='Use before any creative work: explore intent, requirements and design before implementation.',
             agents={'kimi': 'active', 'claude': 'active', 'codex': 'active'}),
        dict(name='using-superpowers', scope='User', on=True, warn='shadowed',
             desc='Establishes how to find and use skills; invoke relevant skills before any response.',
             agents={'kimi': 'active', 'claude': 'shadowed', 'codex': 'active'}),
        dict(name='pingcode-create-workitem', scope='User', on=True,
             desc='Create PingCode work items: requirements, defects and subtasks.',
             agents={'kimi': 'active', 'claude': 'active', 'codex': 'absent'}),
        dict(name='test-driven-development', scope='User', on=False,
             desc='Write the test first. Watch it fail. Write minimal code to pass.',
             agents={'kimi': 'absent', 'claude': 'absent', 'codex': 'absent'},
             note='parked at ~/.kimi/skills/.disabled/test-driven-development'),
    ]),
    ('PROJECT SKILLS', [
        dict(name='protecting-main-with-worktrees', scope='Project', on=True,
             desc='Keep protected branches clean; do feature work in local .worktrees.',
             agents={'kimi': 'active', 'claude': 'active', 'codex': 'active'}),
        dict(name='review-fix-commit-loop', scope='Project', on=True, warn='skill.md',
             desc='Review findings, patch narrowly, verify freshly, commit intentionally.',
             agents={'kimi': 'absent', 'claude': 'active', 'codex': 'active'}),
    ]),
    ('BUILT-IN', [
        dict(name='kimi-cli-help', scope='Built-in', on=True,
             desc='Answer Kimi Code CLI usage, configuration and troubleshooting questions.',
             agents={'kimi': 'active', 'claude': 'absent', 'codex': 'absent'}),
        dict(name='skill-creator', scope='Built-in', on=True,
             desc='Guide for creating effective skills that extend agent capabilities.',
             agents={'kimi': 'active', 'claude': 'absent', 'codex': 'absent'}),
    ]),
]


def list_view(path_svg, path_png):
    parts = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}' height='860' viewBox='0 0 {W} 860'>",
             f"<rect width='{W}' height='860' fill='{BG}'/>", tab_bar(), search_row()]
    y = 84
    for title, cards in CARDS:
        parts.append(group_header(y, title, len(cards)))
        y += 14
        for c in cards:
            svg, h = card(y, **c)
            parts.append(svg)
            y += h + 8
        y += 12
    parts.append(f"<text x='{W / 2}' y='848' font-size='8.5' text-anchor='middle' fill='{FAINT}' {FONT}>"
                 f"agent chips: bright = active \u00b7 \u26a0 = shadowed \u00b7 dim = absent</text>")
    parts.append('</svg>')
    svg = ''.join(parts)
    with open(path_svg, 'w') as f:
        f.write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=path_png, output_width=W * 2, output_height=1720)


def diagnostic_view(path_svg, path_png):
    """Expanded card: shadow resolution detail for using-superpowers."""
    parts = [f"<svg xmlns='http://www.w3.org/2000/svg' width='{W}' height='420' viewBox='0 0 {W} 420'>",
             f"<rect width='{W}' height='420' fill='{BG}'/>", tab_bar(), search_row(),
             group_header(84, 'USER SKILLS', 4)]
    svg, h = card(98, 'using-superpowers',
                  'Establishes how to find and use skills; invoke relevant skills before any response.',
                  'User', {'kimi': 'active', 'claude': 'shadowed', 'codex': 'active'}, warn='shadowed')
    parts.append(svg)
    y = 98 + h + 8
    dh = 168
    parts.append(f"<rect x='10' y='{y}' width='{W - 20}' height='{dh}' rx='9' fill='#1e2023' stroke='#3a3d42'/>")
    parts.append(f"<text x='22' y='{y + 18}' font-size='10' font-weight='bold' fill='{FG}' {FONT}>Effectiveness per agent</text>")
    rows = [
        ('kimi', AGENTS['kimi'], '\u2713 active', '~/.kimi/skills/using-superpowers'),
        ('claude', WARN, '\u26a0 shadowed', '~/.kimi/skills/\u2026 wins over ~/.claude/skills/\u2026'),
        ('codex', AGENTS['codex'], '\u2713 active', '~/.codex/skills/using-superpowers'),
    ]
    ry = y + 36
    for agent, color, status, detail in rows:
        p, _ = pill(22, ry - 10, agent, color, tint(color))
        parts.append(p)
        parts.append(f"<text x='80' y='{ry + 1}' font-size='9' fill='{color}' {FONT}>{esc(status)}</text>")
        parts.append(f"<text x='150' y='{ry + 1}' font-size='8.5' fill='{DIM}' {FONT}>{esc(detail)}</text>")
        ry += 20
    parts.append(f"<line x1='22' y1='{ry + 2}' x2='{W - 22}' y2='{ry + 2}' stroke='#333'/>")
    parts.append(f"<text x='22' y='{ry + 18}' font-size='9' fill='{WARN}' {FONT}>\u26a0 Kimi brand-directory priority loads the ~/.kimi copy;</text>")
    parts.append(f"<text x='22' y='{ry + 31}' font-size='9' fill='{WARN}' {FONT}>the ~/.claude copy is invisible to every agent.</text>")
    by = ry + 44
    for label, x, w_ in (('Open SKILL.md', 22, 92), ('Disable', 122, 66), ('Sync to Claude\u2026', 196, 108)):
        parts.append(f"<rect x='{x}' y='{by}' width='{w_}' height='20' rx='5' fill='#2b2d30' stroke='#45484c' stroke-width='.6'/>")
        parts.append(f"<text x='{x + w_ / 2}' y='{by + 13}' font-size='9' text-anchor='middle' fill='{FG}' {FONT}>{esc(label)}</text>")
    parts.append('</svg>')
    svg = ''.join(parts)
    with open(path_svg, 'w') as f:
        f.write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=path_png, output_width=W * 2, output_height=840)


list_view('skill-management-tab-list.svg', 'skill-management-tab-list.png')
diagnostic_view('skill-management-diagnostic.svg', 'skill-management-diagnostic.png')
print('done')
