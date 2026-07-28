# Skill Management Design

> Status: approved direction, pending implementation plan
> Date: 2026-07-21
> Worktree: `.worktrees/feat-ai-skill-management` (branch `feat/ai-skill-management`)

## Background

Project Steward already manages AI sessions across three agents (Codex, Kimi,
Claude). Agent skills (`SKILL.md` packages per the agentskills.io open
standard) are the other half of the "AI workbench": every agent discovers
skills from its own directories with its own precedence rules, and no tool on
the market offers a unified, cross-agent, cross-scope management console.

### Competitive research (2026-07-21)

- **Claude Code**: `/plugin` terminal browser + marketplaces; personal
  (`~/.claude/skills`) and project (`.claude/skills`) scopes. Disabling a
  skill requires renaming its folder. Terminal-only, Claude-only.
- **Kimi CLI**: layered discovery (project/user/extra/built-in; brand group
  priority kimi > claude > codex, first existing directory wins at
  v1.49.0; generic group `.agents` / `~/.config/agents` merged). No
  management UI. Precedence shadowing and case-sensitive `SKILL.md`
  discovery are real, observed footguns.
- **Codex CLI**: `~/.codex/skills`. No management UI.
- **Registries**: `npx skills add` (Vercel skills CLI, 18+ platform install
  paths), agenticskills.io directory, skilldock.io (versioned, commerce),
  LobeHub/Agensi catalogs. All solve discovery+install, none solve local
  management.
- **Validation**: agentskills.io spec (name ≤64 chars, description ≤1024
  chars, body ≤500 lines recommended) plus SkillCheck/validate-skill
  tooling.

**Gap**: nobody provides "which skills do I have, which agent actually
loads them, why is this one not firing, and how do I toggle it" in one
place. That is the product.

## Product direction

**Spine (v1): local unified management console.** Registry/marketplace
install is a later increment on top of the local model.

**Persona**: multi-agent developer who keeps skills in several directories
(`~/.kimi/skills`, `~/.claude/skills`, `~/.codex/skills`, project-level
`.kimi/.claude/.codex/.agents`) and cannot see effective state.

| Job to be done | Today | Product answer |
| --- | --- | --- |
| Installed a skill but the agent ignores it — why? | Black box | Effectiveness diagnostics: active / shadowed / absent per agent, with reasons |
| Temporarily turn a skill off without deleting | Rename/delete folders | One-click enable/disable (move directory) |
| Use one skill from several agents | Manual copies, drift | (P1) cross-agent sync |
| What skills does this project ship, who loads them? | Dig through repo dirs | Project-scope group view |

## Unified skill model

Each discovered skill is aggregated into one record:

- **Identity**: `name`, `description` (parsed from SKILL.md frontmatter)
- **Scope**: `user` | `project` | `extra` | `built-in` (built-in is
  read-only)
- **Per-agent visibility** for Kimi / Claude / Codex, computed from each
  agent's actual discovery rules:
  - `active` — the agent will load this skill
  - `shadowed` — present on disk but a same-named skill in a
    higher-priority directory wins; the record shows *which* directory
    shadows it
  - `absent` — the agent does not see this skill
- **State**: `enabled` | `disabled`
- **Health diagnostics**: missing/invalid frontmatter, name ≠ directory
  name, description >1024 chars, body >500 lines, lowercase `skill.md`
  filename, unreadable directory
- **Origin** (optional): local vs registry-installed source marker

## Core user journeys

- **J1 Unified view**: SKILLS tab groups cards under USER SKILLS /
  PROJECT SKILLS / BUILT-IN. Each card: name, description (2-line clamp),
  scope badge, three agent chips (bright = active, dim = absent, ⚠ =
  shadowed), enable toggle, health warning badge.
- **J2 Toggle**: flip → directory moves into/out of a sibling `.disabled/`
  parking area; watcher refreshes the list.
- **J3 Diagnosis**: warning badge click/hover explains the issue in plain
  language ("shadowed by `~/.kimi/skills/using-superpowers` — Kimi loads
  that copy").
- **J4 Open for edit**: click card → VS Code editor opens `SKILL.md`. No
  embedded editor in v1.
- **J5 Auto refresh**: fs watchers on every skills root; changes update
  the webview incrementally.
- **J6 (P1) Cross-agent sync**: card menu copies the skill into another
  agent's directory.
- **J7 (P1) Registry install**: search skills.sh / agenticskills.io,
  install via `npx skills add` into a chosen directory.
- **J8 (P2) Workshop**: scaffolding, validation report, evals.

## Scope (YAGNI)

- **MVP (P0, this branch)**: unified model scan + SKILLS tab card list +
  enable/disable toggle + diagnostics badges + open SKILL.md + watcher
  refresh. Scopes: user + project (generic `.agents` directories are
  scanned and folded into the user scope with a generic origin marker).
- **P1**: cross-agent sync, search/filter, delete with confirmation.
- **P2**: built-in group, registry install, scaffolding, evals.

## Key design decisions

1. **Effectiveness engine mirrors Kimi's rules**: brand group priority
   kimi > claude > codex (first existing directory wins, matching Kimi
   v1.49.0), generic group merged. The rule table is data-driven so a
   future Kimi behavior change edits one table, not the UI.
2. **Disable = move directory**: disabling moves `<skillsDir>/<name>` to
   `<skillsDir>/.disabled/<name>`; the parking area is excluded from
   scans; enabling moves it back; existing destination = error, never
   overwrite.
3. **No embedded editor in P0**: the VS Code editor is the editor.
4. **Visual language reuse**: steward-item-card + badges + fitty title
   row; agent chips reuse the codex/kimi/claude iconography already used
   by session views.
5. **Architecture**: new SKILLS tab in the existing sidebar webview
   (alongside OPEN / PROJECTS / TODOS), reusing the tab framework, card
   styles, search, and message routing. No separate activity bar view.
   With four tabs the 340px sidebar wraps the tab strip — accept natural
   wrapping in v1 (no abbreviated labels or scrolling tab strip).
6. **Built-in skills are out of P0**: they live inside each agent's
   install package (e.g. the kimi-cli package directory), which is not a
   stable discovery surface. The BUILT-IN group returns in P2 behind an
   explicit, configurable package-path list.

## Edge cases

- Shadow chains across scopes show which copy actually wins.
- `.disabled/` parking areas never appear as skills.
- Symlinked skill directories are followed for reads, never written
  through.
- Multi-window: project scope is computed per window's own workspace.
- Unreadable directories degrade to an "unreadable" diagnostic, not an
  activation error.

## Testing strategy

Repo-style `run-*-checks.js` scripts: discovery precedence/shadowing
matrix, toggle move atomicity and conflict rollback, diagnostic rule
fixtures (including the three observed real-world cases: brand-directory
shadowing, lowercase `skill.md`, missing frontmatter), webview rendering
contracts.

## Mockups

- [SKILLS tab — list view](assets/skill-management-tab-list.png)
- [SKILLS tab — shadowed diagnostic detail](assets/skill-management-diagnostic.png)
